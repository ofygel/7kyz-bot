import type { Telegram } from 'telegraf';
import type {
  Chat as TelegramChat,
  User as TelegramUser,
} from 'telegraf/typings/core/types/typegram';

import { config, logger } from '../../config';
import { getChannelBinding } from '../channels/bindings';
import { CITY_LABEL, type AppCity } from '../../domain/cities';
import type { OrderRecord, OrderKind } from '../../types';
import type { ExecutorRole, UserSubscriptionStatus } from '../types';
import { getExecutorRoleCopy } from '../copy';

const REPORT_PREVIEW_LENGTH = 120;

export type ReportSendStatus = 'disabled' | 'missing_channel' | 'sent' | 'failed';

export interface ReportSendResult {
  status: ReportSendStatus;
  chatId?: number;
  messageId?: number;
  error?: unknown;
}

interface UserIdentity {
  telegramId?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

interface SubscriptionIdentity extends UserIdentity {
  shortId?: string;
  subscriptionStatus?: UserSubscriptionStatus;
  subscriptionExpiresAt?: Date | number | string;
  trialExpiresAt?: Date | number | string;
  hasActiveOrder?: boolean;
}

const formatDateTime = (value?: Date | number | string): string | undefined => {
  if (!value) {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: config.timezone,
  }).format(date);
};

const formatAmount = (amount: number, currency: string): string =>
  `${new Intl.NumberFormat('ru-RU').format(amount)} ${currency}`;

const joinNonEmpty = (values: Array<string | undefined | null>): string =>
  values
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join(' ')
    .trim();

const formatUserIdentity = (identity: UserIdentity): string | undefined => {
  const fullName = joinNonEmpty([identity.firstName, identity.lastName]);

  if (identity.username) {
    const usernamePart = `@${identity.username}`;
    if (identity.telegramId) {
      return fullName
        ? `${fullName} (${usernamePart}, ID ${identity.telegramId})`
        : `${usernamePart} (ID ${identity.telegramId})`;
    }
    return fullName ? `${fullName} (${usernamePart})` : usernamePart;
  }

  if (fullName) {
    return identity.telegramId ? `${fullName} (ID ${identity.telegramId})` : fullName;
  }

  if (identity.telegramId !== undefined) {
    return `ID ${identity.telegramId}`;
  }

  return undefined;
};

const formatExecutorRole = (role?: ExecutorRole): string | undefined => {
  if (!role) {
    return undefined;
  }

  const copy = getExecutorRoleCopy(role);
  return `${copy.noun} (${role})`;
};

const formatSubscriptionStatus = (
  status?: UserSubscriptionStatus,
): string | undefined => {
  if (!status) {
    return undefined;
  }

  const labels: Record<UserSubscriptionStatus, string> = {
    none: 'нет подписки',
    trial: 'пробный период',
    active: 'активна',
    grace: 'льготный период',
    expired: 'истекла',
  };

  return labels[status];
};

const appendSubscriptionDetails = (
  lines: string[],
  subscriber: SubscriptionIdentity,
  fallbackExpiresAt?: Date | number | string,
): void => {
  const statusLabel = formatSubscriptionStatus(subscriber.subscriptionStatus);
  if (statusLabel) {
    lines.push(`Статус: ${statusLabel}`);
  }

  const expiresSource =
    subscriber.subscriptionExpiresAt ?? subscriber.trialExpiresAt ?? fallbackExpiresAt;
  const expiresLabel = formatDateTime(expiresSource);
  if (expiresLabel) {
    lines.push(`Доступ до: ${expiresLabel}`);
  }

  if (subscriber.hasActiveOrder !== undefined) {
    lines.push(`Активный заказ: ${subscriber.hasActiveOrder ? 'да' : 'нет'}`);
  }
};

const truncatePreview = (text: string): string => {
  if (text.length <= REPORT_PREVIEW_LENGTH) {
    return text;
  }

  return `${text.slice(0, REPORT_PREVIEW_LENGTH - 1)}…`;
};

const toUserIdentity = (user?: TelegramUser | null): UserIdentity => {
  if (!user) {
    return {};
  }

  return {
    telegramId: user.id,
    username: user.username ?? undefined,
    firstName: user.first_name ?? undefined,
    lastName: user.last_name ?? undefined,
  } satisfies UserIdentity;
};

const buildOrderHeading = (order: Pick<OrderRecord, 'shortId' | 'id' | 'kind'>): string => {
  const number = order.shortId ?? `#${order.id}`;
  const label: Record<OrderKind, string> = {
    taxi: 'Такси',
    delivery: 'Доставка',
  };

  return `📦 Заказ ${label[order.kind]} ${number}`;
};

const appendPhoneLine = (lines: string[], phone?: string): void => {
  if (phone && phone.trim().length > 0) {
    lines.push(`Телефон: ${phone.trim()}`);
  }
};

const appendUserLine = (lines: string[], label: string, user?: UserIdentity): void => {
  const formatted = user ? formatUserIdentity(user) : undefined;
  if (formatted) {
    lines.push(`${label}: ${formatted}`);
  }
};

const formatChatIdentity = (chat?: TelegramChat | null): string | undefined => {
  if (!chat) {
    return undefined;
  }

  const nameParts: string[] = [];
  if ('title' in chat && chat.title) {
    nameParts.push(chat.title);
  }
  if ('username' in chat && chat.username) {
    nameParts.push(`@${chat.username}`);
  }

  const principal = nameParts.join(' ').trim();
  const details: string[] = [];
  if (principal.length > 0) {
    details.push(principal);
  }

  details.push(`ID ${chat.id}`);
  details.push(`тип: ${chat.type}`);

  return details.join(', ');
};

type ReportReadiness =
  | { state: 'disabled' }
  | { state: 'missing' }
  | { state: 'ready'; chatId: number }
  | { state: 'error' };

const ensureReportReady = async (): Promise<ReportReadiness> => {
  if (!config.features.reportsEnabled) {
    return { state: 'disabled' };
  }

  try {
    const binding = await getChannelBinding('stats');
    if (!binding) {
      logger.debug('Stats channel binding is not configured, skipping report');
      return { state: 'missing' };
    }

    return { state: 'ready', chatId: binding.chatId };
  } catch (error) {
    logger.error({ err: error }, 'Failed to resolve stats channel binding for report');
    return { state: 'error' };
  }
};

export const sendStatsReport = async (
  telegram: Telegram,
  text: string,
): Promise<ReportSendResult> => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    logger.warn('Attempted to send empty stats report');
    return { status: 'failed' } satisfies ReportSendResult;
  }

  const readiness = await ensureReportReady();
  if (readiness.state === 'disabled') {
    logger.debug({ preview: truncatePreview(trimmed) }, 'Stats reports are disabled');
    return { status: 'disabled' } satisfies ReportSendResult;
  }

  if (readiness.state === 'missing') {
    return { status: 'missing_channel' } satisfies ReportSendResult;
  }

  if (readiness.state === 'error') {
    return { status: 'failed' } satisfies ReportSendResult;
  }

  const chatId = readiness.chatId;

  logger.debug({ chatId, preview: truncatePreview(trimmed) }, 'Sending stats report');

  try {
    const message = await telegram.sendMessage(chatId, trimmed);
    logger.info(
      { chatId, messageId: message.message_id },
      'Stats report delivered',
    );
    return {
      status: 'sent',
      chatId,
      messageId: message.message_id,
    } satisfies ReportSendResult;
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to deliver stats report');
    return { status: 'failed', chatId, error } satisfies ReportSendResult;
  }
};

const formatRoleLabel = (
  role?: string,
  executorRole?: ExecutorRole,
): string | undefined => {
  if (!role) {
    return undefined;
  }

  const labels: Record<string, string> = {
    guest: 'Гость',
    client: 'Клиент',
    executor: 'Исполнитель',
    moderator: 'Модератор',
  };

  if (role === 'executor') {
    const executorLabel = executorRole ? formatExecutorRole(executorRole) : undefined;
    return executorLabel ? `${labels.executor} — ${executorLabel}` : labels.executor;
  }

  return labels[role] ?? role;
};

const buildRegistrationReport = (
  user: UserIdentity,
  phone?: string,
  source?: string,
): string => {
  const lines = ['🆕 Новая регистрация пользователя'];
  appendUserLine(lines, 'Пользователь', user);
  appendPhoneLine(lines, phone);
  if (source) {
    lines.push(`Источник: ${source}`);
  }
  return lines.join('\n');
};

interface PhoneVerifiedReportContext {
  user: UserIdentity;
  city?: AppCity;
}

const buildPhoneVerifiedReport = ({ user, city }: PhoneVerifiedReportContext): string => {
  const lines = ['📱 Телефон подтверждён'];
  appendUserLine(lines, 'Пользователь', user);
  appendPhoneLine(lines, user.phone);
  if (city) {
    const cityLabel = CITY_LABEL[city] ?? city;
    lines.push(`Город: ${cityLabel}`);
  }
  return lines.join('\n');
};

interface RoleSetReportContext {
  user: UserIdentity;
  role: string;
  executorRole?: ExecutorRole;
  city?: AppCity;
}

const buildRoleSetReport = ({
  user,
  role,
  executorRole,
  city,
}: RoleSetReportContext): string => {
  const lines = ['🎭 Роль пользователя обновлена'];
  appendUserLine(lines, 'Пользователь', user);
  appendPhoneLine(lines, user.phone);
  const roleLabel = formatRoleLabel(role, executorRole);
  if (roleLabel) {
    lines.push(`Роль: ${roleLabel}`);
  }
  if (city) {
    const cityLabel = CITY_LABEL[city] ?? city;
    lines.push(`Город: ${cityLabel}`);
  }
  return lines.join('\n');
};

interface CitySetReportContext {
  user: UserIdentity;
  city: AppCity;
  role?: string;
  executorRole?: ExecutorRole;
}

const buildCitySetReport = ({
  user,
  city,
  role,
  executorRole,
}: CitySetReportContext): string => {
  const lines = ['🗺️ Город обновлён'];
  appendUserLine(lines, 'Пользователь', user);
  appendPhoneLine(lines, user.phone);
  const roleLabel = formatRoleLabel(role, executorRole);
  if (roleLabel) {
    lines.push(`Роль: ${roleLabel}`);
  }
  const cityLabel = CITY_LABEL[city] ?? city;
  lines.push(`Город: ${cityLabel}`);
  return lines.join('\n');
};

export const reportUserRegistration = async (
  telegram: Telegram,
  user: UserIdentity,
  phone?: string,
  source?: string,
): Promise<ReportSendResult> => sendStatsReport(telegram, buildRegistrationReport(user, phone, source));

export const reportPhoneVerified = async (
  telegram: Telegram,
  context: PhoneVerifiedReportContext,
): Promise<ReportSendResult> => sendStatsReport(telegram, buildPhoneVerifiedReport(context));

export const reportRoleSet = async (
  telegram: Telegram,
  context: RoleSetReportContext,
): Promise<ReportSendResult> => sendStatsReport(telegram, buildRoleSetReport(context));

export const reportCitySet = async (
  telegram: Telegram,
  context: CitySetReportContext,
): Promise<ReportSendResult> => sendStatsReport(telegram, buildCitySetReport(context));

const buildVerificationSubmittedReport = (
  applicant: UserIdentity,
  role: ExecutorRole,
  photoCount: number,
  phone?: string,
): string => {
  const lines = ['🛡️ Заявка на проверку документов'];
  appendUserLine(lines, 'Исполнитель', applicant);
  const roleLabel = formatExecutorRole(role);
  if (roleLabel) {
    lines.push(`Роль: ${roleLabel}`);
  }
  appendPhoneLine(lines, phone);
  lines.push(`Фотографии: ${photoCount}`);
  return lines.join('\n');
};

export const reportVerificationSubmitted = async (
  telegram: Telegram,
  applicant: UserIdentity,
  role: ExecutorRole,
  photoCount: number,
  phone?: string,
): Promise<ReportSendResult> =>
  sendStatsReport(telegram, buildVerificationSubmittedReport(applicant, role, photoCount, phone));

const buildVerificationDecisionReport = (
  applicant: UserIdentity,
  role: ExecutorRole,
  decision: 'approved' | 'rejected',
  decidedAt?: Date | number | string,
  reason?: string,
): string => {
  const heading = decision === 'approved' ? '✅ Документы подтверждены' : '❌ Документы отклонены';
  const lines = [heading];
  appendUserLine(lines, 'Исполнитель', applicant);
  const roleLabel = formatExecutorRole(role);
  if (roleLabel) {
    lines.push(`Роль: ${roleLabel}`);
  }
  const decidedLabel = formatDateTime(decidedAt);
  if (decidedLabel) {
    lines.push(`Решение: ${decidedLabel}`);
  }
  if (reason) {
    lines.push(`Причина: ${reason}`);
  }
  return lines.join('\n');
};

export const reportVerificationApproved = async (
  telegram: Telegram,
  applicant: UserIdentity,
  role: ExecutorRole,
  decidedAt?: Date | number | string,
): Promise<ReportSendResult> =>
  sendStatsReport(telegram, buildVerificationDecisionReport(applicant, role, 'approved', decidedAt));

export const reportVerificationRejected = async (
  telegram: Telegram,
  applicant: UserIdentity,
  role: ExecutorRole,
  decidedAt?: Date | number | string,
  reason?: string,
): Promise<ReportSendResult> =>
  sendStatsReport(
    telegram,
    buildVerificationDecisionReport(applicant, role, 'rejected', decidedAt, reason),
  );

const buildSubscriptionPaymentReport = (
  payer: SubscriptionIdentity,
  periodLabel: string,
  amount: { value: number; currency: string },
  submittedAt?: Date | number | string,
): string => {
  const lines = ['💳 Новый платёж по подписке'];
  appendUserLine(lines, 'Плательщик', payer);
  if (payer.shortId) {
    lines.push(`Подписка: ${payer.shortId}`);
  }
  lines.push(`Период: ${periodLabel}`);
  lines.push(`Сумма: ${formatAmount(amount.value, amount.currency)}`);
  const submittedLabel = formatDateTime(submittedAt);
  if (submittedLabel) {
    lines.push(`Отправлено: ${submittedLabel}`);
  }
  appendPhoneLine(lines, payer.phone);
  return lines.join('\n');
};

export const reportSubscriptionPaymentSubmitted = async (
  telegram: Telegram,
  payer: SubscriptionIdentity,
  periodLabel: string,
  amount: { value: number; currency: string },
  submittedAt?: Date | number | string,
): Promise<ReportSendResult> =>
  sendStatsReport(telegram, buildSubscriptionPaymentReport(payer, periodLabel, amount, submittedAt));

const buildSubscriptionDecisionReport = (
  payer: SubscriptionIdentity,
  periodLabel: string,
  amount: { value: number; currency: string },
  decision: 'approved' | 'rejected',
  decidedAt?: Date | number | string,
  reason?: string,
  expiresAt?: Date | number | string,
): string => {
  const heading = decision === 'approved' ? '✅ Подписка активирована' : '❌ Подписка отклонена';
  const lines = [heading];
  appendUserLine(lines, 'Исполнитель', payer);
  if (payer.shortId) {
    lines.push(`Подписка: ${payer.shortId}`);
  }
  lines.push(`Период: ${periodLabel}`);
  lines.push(`Сумма: ${formatAmount(amount.value, amount.currency)}`);
  const decidedLabel = formatDateTime(decidedAt);
  if (decidedLabel) {
    lines.push(`Решение: ${decidedLabel}`);
  }
  appendSubscriptionDetails(lines, payer, expiresAt);
  if (reason) {
    lines.push(`Причина: ${reason}`);
  }
  appendPhoneLine(lines, payer.phone);
  return lines.join('\n');
};

export const reportSubscriptionApproved = async (
  telegram: Telegram,
  payer: SubscriptionIdentity,
  periodLabel: string,
  amount: { value: number; currency: string },
  decidedAt?: Date | number | string,
  expiresAt?: Date | number | string,
): Promise<ReportSendResult> =>
  sendStatsReport(
    telegram,
    buildSubscriptionDecisionReport(payer, periodLabel, amount, 'approved', decidedAt, undefined, expiresAt),
  );

export const reportSubscriptionRejected = async (
  telegram: Telegram,
  payer: SubscriptionIdentity,
  periodLabel: string,
  amount: { value: number; currency: string },
  decidedAt?: Date | number | string,
  reason?: string,
): Promise<ReportSendResult> =>
  sendStatsReport(
    telegram,
    buildSubscriptionDecisionReport(payer, periodLabel, amount, 'rejected', decidedAt, reason),
  );

const buildSubscriptionLifecycleReport = (
  prefix: string,
  subscriber: SubscriptionIdentity,
  expiresAt: Date,
): string => {
  const lines = [prefix];
  appendUserLine(lines, 'Исполнитель', subscriber);
  appendSubscriptionDetails(lines, subscriber, expiresAt);
  return lines.join('\n');
};

export const reportSubscriptionTrialActivated = async (
  telegram: Telegram,
  subscriber: SubscriptionIdentity,
  expiresAt: Date,
): Promise<ReportSendResult> =>
  sendStatsReport(telegram, buildSubscriptionLifecycleReport('🆓 Пробный период активирован', subscriber, expiresAt));

export const reportSubscriptionWarning = async (
  telegram: Telegram,
  subscriber: SubscriptionIdentity,
  expiresAt: Date,
): Promise<ReportSendResult> =>
  sendStatsReport(telegram, buildSubscriptionLifecycleReport('⚠️ Подписка скоро истекает', subscriber, expiresAt));

export const reportSubscriptionExpired = async (
  telegram: Telegram,
  subscriber: SubscriptionIdentity,
  expiredAt: Date,
): Promise<ReportSendResult> =>
  sendStatsReport(telegram, buildSubscriptionLifecycleReport('⛔️ Подписка истекла', subscriber, expiredAt));

interface OrderReportContext {
  order: OrderRecord;
  customer?: UserIdentity;
  publishStatus?: 'published' | 'already_published' | 'missing_channel' | 'publish_failed';
}

const buildOrderReport = ({ order, customer, publishStatus }: OrderReportContext): string => {
  const lines = [buildOrderHeading(order)];
  lines.push(`Город: ${CITY_LABEL[order.city] ?? order.city}`);
  lines.push(`Стоимость: ${formatAmount(order.price.amount, order.price.currency)}`);
  lines.push(`Адрес подачи: ${order.pickup.address}`);
  lines.push(`Адрес назначения: ${order.dropoff.address}`);
  appendUserLine(lines, 'Клиент', customer);
  appendPhoneLine(lines, order.clientPhone);
  if (order.recipientPhone) {
    lines.push(`Телефон получателя: ${order.recipientPhone}`);
  }
  if (order.clientComment) {
    lines.push(`Комментарий: ${order.clientComment}`);
  }
  if (publishStatus === 'missing_channel') {
    lines.push('⚠️ Канал исполнителей не настроен');
  }
  if (publishStatus === 'publish_failed') {
    lines.push('🚨 Не удалось опубликовать заказ в канал — требуется ручная обработка');
  }
  return lines.join('\n');
};

export const reportOrderCreated = async (
  telegram: Telegram,
  context: OrderReportContext,
): Promise<ReportSendResult> => sendStatsReport(telegram, buildOrderReport(context));

const buildOrderActionReport = (
  heading: string,
  order: OrderRecord,
  executor?: UserIdentity,
  extra?: string[],
): string => {
  const lines = [heading, buildOrderHeading(order)];
  appendUserLine(lines, 'Исполнитель', executor);
  const cityLabel = CITY_LABEL[order.city] ?? order.city;
  lines.push(`Город: ${cityLabel}`);
  if (order.price) {
    lines.push(`Стоимость: ${formatAmount(order.price.amount, order.price.currency)}`);
  }
  if (extra && extra.length > 0) {
    lines.push(...extra);
  }
  return lines.join('\n');
};

const buildJobFeedReport = (
  executor: UserIdentity,
  cityLabel: string,
  orderCount: number,
): string => {
  const lines = ['👀 JOB_VIEWED: лента заказов'];
  appendUserLine(lines, 'Исполнитель', executor);
  lines.push(`Город: ${cityLabel}`);
  lines.push(orderCount > 0 ? `Доступно заказов: ${orderCount}` : 'Свободных заказов нет');
  return lines.join('\n');
};

const buildJobActionReport = (
  heading: string,
  order: OrderRecord,
  executor: UserIdentity,
  extra?: string[],
): string => {
  const lines = [heading, buildOrderHeading(order)];
  appendUserLine(lines, 'Исполнитель', executor);
  const cityLabel = CITY_LABEL[order.city] ?? order.city;
  lines.push(`Город: ${cityLabel}`);
  if (order.price) {
    lines.push(`Стоимость: ${formatAmount(order.price.amount, order.price.currency)}`);
  }
  if (extra && extra.length > 0) {
    lines.push(...extra);
  }
  return lines.join('\n');
};

export const reportOrderPublished = async (
  telegram: Telegram,
  order: OrderRecord,
): Promise<ReportSendResult> =>
  sendStatsReport(telegram, buildOrderActionReport('📢 Заказ опубликован в канале', order));

export const reportOrderClaimed = async (
  telegram: Telegram,
  order: OrderRecord,
  executor?: UserIdentity,
): Promise<ReportSendResult> =>
  sendStatsReport(telegram, buildOrderActionReport('✅ Заказ принят исполнителем', order, executor));

export const reportOrderReleased = async (
  telegram: Telegram,
  order: OrderRecord,
  executor?: UserIdentity,
  republished?: boolean,
): Promise<ReportSendResult> => {
  const extra = republished
    ? ['Заказ возвращён в канал']
    : ['Заказ ожидает ручной обработки'];
  return sendStatsReport(
    telegram,
    buildOrderActionReport('🚫 Заказ отменён исполнителем', order, executor, extra),
  );
};

export const reportOrderCompleted = async (
  telegram: Telegram,
  order: OrderRecord,
  executor?: UserIdentity,
): Promise<ReportSendResult> =>
  sendStatsReport(telegram, buildOrderActionReport('🏁 Заказ завершён', order, executor));

export const reportJobFeedViewed = async (
  telegram: Telegram,
  executor: UserIdentity,
  city: AppCity,
  orderCount: number,
): Promise<ReportSendResult> =>
  sendStatsReport(telegram, buildJobFeedReport(executor, CITY_LABEL[city] ?? city, orderCount));

export const reportJobTaken = async (
  telegram: Telegram,
  order: OrderRecord,
  executor: UserIdentity,
): Promise<ReportSendResult> =>
  sendStatsReport(
    telegram,
    buildJobActionReport('🤝 JOB_TAKEN: заказ взят исполнителем', order, executor, [
      'Источник: лента заказов',
    ]),
  );

export const reportJobReleased = async (
  telegram: Telegram,
  order: OrderRecord,
  executor: UserIdentity,
  republished?: boolean,
): Promise<ReportSendResult> => {
  const extra: string[] = ['Источник: лента заказов'];
  if (republished === true) {
    extra.push('Статус: заказ возвращён в ленту/канал');
  } else if (republished === false) {
    extra.push('Статус: требуется ручная обработка');
  }
  return sendStatsReport(
    telegram,
    buildJobActionReport('↩️ JOB_RELEASED: исполнитель отказался от заказа', order, executor, extra),
  );
};

export const reportJobCompleted = async (
  telegram: Telegram,
  order: OrderRecord,
  executor: UserIdentity,
): Promise<ReportSendResult> =>
  sendStatsReport(
    telegram,
    buildJobActionReport('🏁 JOB_COMPLETED: заказ завершён исполнителем', order, executor, [
      'Источник: лента заказов',
    ]),
  );

export const reportJobViewed = async (
  telegram: Telegram,
  order: OrderRecord,
  executor: UserIdentity,
): Promise<ReportSendResult> =>
  sendStatsReport(
    telegram,
    buildJobActionReport('👁️ JOB_VIEWED: просмотрена карточка заказа', order, executor, [
      'Источник: лента заказов',
    ]),
  );

interface SafeModeReportContext {
  chat?: TelegramChat | null;
  user?: UserIdentity;
  reason?: string;
}

const buildSafeModeEnterReport = ({ chat, user, reason }: SafeModeReportContext): string => {
  const lines = ['🚨 SAFE_MODE_ENTER: активирован безопасный режим'];
  const chatLabel = formatChatIdentity(chat);
  if (chatLabel) {
    lines.push(`Чат: ${chatLabel}`);
  }
  appendUserLine(lines, 'Пользователь', user);
  const reasonLabel = typeof reason === 'string' ? reason.trim() : undefined;
  if (reasonLabel) {
    lines.push(`Причина: ${reasonLabel}`);
  }
  return lines.join('\n');
};

export const reportSafeModeEnter = async (
  telegram: Telegram,
  context: { chat?: TelegramChat | null; user?: TelegramUser | null; reason?: string },
): Promise<ReportSendResult> =>
  sendStatsReport(
    telegram,
    buildSafeModeEnterReport({
      chat: context.chat,
      user: toUserIdentity(context.user),
      reason: context.reason,
    }),
  );

const buildDatabaseFallbackReport = ({ chat, user, reason }: SafeModeReportContext): string => {
  const lines = ['🧰 DB_FALLBACK: сессия переведена на резервный режим'];
  const chatLabel = formatChatIdentity(chat);
  if (chatLabel) {
    lines.push(`Чат: ${chatLabel}`);
  }
  appendUserLine(lines, 'Пользователь', user);
  const reasonLabel = typeof reason === 'string' ? reason.trim() : undefined;
  if (reasonLabel) {
    lines.push(`Причина: ${reasonLabel}`);
  }
  return lines.join('\n');
};

export const reportDatabaseFallback = async (
  telegram: Telegram,
  context: { chat?: TelegramChat | null; user?: TelegramUser | null; reason?: string },
): Promise<ReportSendResult> =>
  sendStatsReport(
    telegram,
    buildDatabaseFallbackReport({
      chat: context.chat,
      user: toUserIdentity(context.user),
      reason: context.reason,
    }),
  );

export type { UserIdentity, SubscriptionIdentity };
export { toUserIdentity };
