import { Markup, Telegraf, Telegram } from 'telegraf';

import { config, logger } from '../../config';
import { activateSubscription } from '../../db/subscriptions';
import { BIND_VERIFY_CHANNEL, ORDERS_CHANNEL, getChannelBinding } from '../channels/bindings';
import { getExecutorRoleCopy } from '../copy';
import type { BotContext, ExecutorRole } from '../types';
import {
  createModerationQueue,
  type ModerationDecisionContext,
  type ModerationQueue,
  type ModerationQueueItemBase,
  type ModerationRejectionContext,
  type PublishModerationResult,
} from './queue';
import type { SubscriptionPeriodOption } from '../flows/executor/subscriptionPlans';
import {
  reportSubscriptionApproved,
  reportSubscriptionRejected,
  type SubscriptionIdentity,
} from '../services/reports';

const DEFAULT_TITLE = '💳 Проверка платежа по подписке';
const DEFAULT_REASONS = [
  'Нет подтверждения оплаты',
  'Сумма не совпадает',
  'Недостаточно данных',
];

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

const buildFullName = (first?: string, last?: string): string | undefined => {
  const full = [first?.trim(), last?.trim()].filter(Boolean).join(' ').trim();
  return full || undefined;
};

const normaliseLines = (value?: string | string[]): string[] => {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const formatAmount = (amount: number, currency: string): string =>
  `${new Intl.NumberFormat('ru-RU').format(amount)} ${currency}`;

export interface PaymentPayer {
  telegramId?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

interface SubscriptionReceiptInfo {
  chatId: number;
  messageId: number;
  fileId: string;
  type: 'photo' | 'document';
}

interface SubscriptionPaymentMetadata {
  role: ExecutorRole;
  telegramId: number;
  chatId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  period: SubscriptionPeriodOption;
  paymentId: string;
  submittedAt: Date;
  receipt: SubscriptionReceiptInfo;
  moderation?: {
    chatId?: number;
    messageId?: number;
    token?: string;
  };
}

export interface PaymentReviewItem extends ModerationQueueItemBase<PaymentReviewItem> {
  /** Identifier of the payment under review. */
  id: string | number;
  /** Identifier of the related subscription, if any. */
  subscriptionId?: number | string;
  /** Amount of the payment. */
  amount: { value: number; currency: string };
  /** Payer details used for the moderation summary. */
  payer?: PaymentPayer;
  /** Optional custom title for the moderation message. */
  title?: string;
  /** Additional description of the payment. */
  description?: string;
  /** Link to the invoice or receipt. */
  invoiceUrl?: string;
  /** Time when the payment was made. */
  paidAt?: Date | number | string;
  /** Billing period covered by the payment. */
  period?: { start?: Date | number | string; end?: Date | number | string };
  /** Additional free-form lines appended at the end of the message. */
  notes?: string[];
  /** Optional summary text inserted before the notes. */
  summary?: string | string[];
  /** Additional subscription context used when processing moderation decisions. */
  subscription?: SubscriptionPaymentMetadata;
}

export interface SubscriptionPaymentRequest {
  paymentId: string;
  period: SubscriptionPeriodOption;
  submittedAt: Date;
  executor: {
    role: ExecutorRole;
    telegramId: number;
    chatId: number;
    username?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
  };
  receipt: SubscriptionReceiptInfo;
}

const buildPayerSection = (payer?: PaymentPayer): string[] => {
  if (!payer) {
    return [];
  }

  const lines: string[] = [];
  const fullName = buildFullName(payer.firstName, payer.lastName);
  if (fullName) {
    lines.push(`Плательщик: ${fullName}`);
  }

  if (payer.username) {
    lines.push(`Username: @${payer.username}`);
  }

  if (payer.telegramId !== undefined) {
    lines.push(`Telegram ID: ${payer.telegramId}`);
  }

  if (payer.phone) {
    lines.push(`Телефон: ${payer.phone}`);
  }

  return lines;
};

const buildPeriodLabel = (period?: PaymentReviewItem['period']): string | undefined => {
  if (!period) {
    return undefined;
  }

  const start = formatDateTime(period.start);
  const end = formatDateTime(period.end);
  if (start && end) {
    return `Период: ${start} — ${end}`;
  }

  if (start) {
    return `Период начинается: ${start}`;
  }

  if (end) {
    return `Период заканчивается: ${end}`;
  }

  return undefined;
};

const buildPaymentMessage = (payment: PaymentReviewItem): string => {
  const lines: string[] = [];
  lines.push(payment.title?.trim() || DEFAULT_TITLE);
  lines.push('');
  lines.push(`ID платежа: ${payment.id}`);

  if (payment.subscriptionId) {
    lines.push(`Подписка: ${payment.subscriptionId}`);
  }

  const amountLabel = formatAmount(payment.amount.value, payment.amount.currency);
  lines.push(`Сумма: ${amountLabel}`);

  const paidAt = formatDateTime(payment.paidAt);
  if (paidAt) {
    lines.push(`Оплачен: ${paidAt}`);
  }

  const periodLabel = buildPeriodLabel(payment.period);
  if (periodLabel) {
    lines.push(periodLabel);
  }

  const payerLines = buildPayerSection(payment.payer);
  if (payerLines.length > 0) {
    lines.push('');
    lines.push(...payerLines);
  }

  if (payment.description) {
    lines.push('');
    lines.push(payment.description);
  }

  if (payment.invoiceUrl) {
    lines.push('');
    lines.push(`Квитанция: ${payment.invoiceUrl}`);
  }

  const summaryLines = normaliseLines(payment.summary);
  if (summaryLines.length > 0) {
    lines.push('');
    lines.push(...summaryLines);
  }

  if (payment.notes && payment.notes.length > 0) {
    lines.push('');
    lines.push(...payment.notes);
  }

  return lines.join('\n');
};

const formatRejectionReason = (reason: string): string => {
  const trimmed = reason.trim();
  if (!trimmed) {
    return 'не указана.';
  }

  if (/[.!?]$/.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}.`;
};

const estimatePeriodEnd = (start: Date, days: number): Date =>
  new Date(start.getTime() + days * 24 * 60 * 60 * 1000);

const createSubscriptionPaymentReviewItem = (
  request: SubscriptionPaymentRequest,
): PaymentReviewItem => {
  const submittedAt = request.submittedAt ?? new Date();
  const periodEnd = estimatePeriodEnd(submittedAt, request.period.days);
  const roleCopy = getExecutorRoleCopy(request.executor.role);
  const summaryLines = [
    `Исполнитель: ${roleCopy.noun} (${request.executor.role})`,
    `Период: ${request.period.label}`,
    `Отправлено: ${formatDateTime(submittedAt) ?? 'неизвестно'}`,
  ];

  const notes: string[] = [];
  if (request.executor.phone) {
    notes.push(`Контактный телефон: ${request.executor.phone}`);
  }
  notes.push('Чек прикреплён отдельным сообщением.');

  return {
    id: request.paymentId,
    title: `💳 Оплата подписки (${request.period.label})`,
    amount: { value: request.period.amount, currency: request.period.currency },
    payer: {
      telegramId: request.executor.telegramId,
      username: request.executor.username,
      firstName: request.executor.firstName,
      lastName: request.executor.lastName,
      phone: request.executor.phone,
    },
    description: 'Квитанция приложена отдельным сообщением ниже.',
    paidAt: submittedAt,
    period: { start: submittedAt, end: periodEnd },
    summary: summaryLines,
    notes,
    subscription: {
      role: request.executor.role,
      telegramId: request.executor.telegramId,
      chatId: request.executor.chatId,
      username: request.executor.username,
      firstName: request.executor.firstName,
      lastName: request.executor.lastName,
      phone: request.executor.phone,
      period: request.period,
      paymentId: request.paymentId,
      submittedAt,
      receipt: request.receipt,
    },
  } satisfies PaymentReviewItem;
};

const copyReceiptToModerationChannel = async (
  telegram: Telegram,
  receipt: SubscriptionReceiptInfo,
  targetChatId: number,
  paymentId: string,
): Promise<void> => {
  try {
    await telegram.copyMessage(targetChatId, receipt.chatId, receipt.messageId);
  } catch (error) {
    logger.warn(
      { err: error, chatId: targetChatId, paymentId },
      'Failed to copy subscription receipt to moderation channel',
    );
  }
};

const handleSubscriptionApproval = async (
  context: ModerationDecisionContext<PaymentReviewItem>,
): Promise<void> => {
  const { item, telegram, decidedAt } = context;
  const subscription = item.subscription;
  if (!subscription) {
    return;
  }

  const roleCopy = getExecutorRoleCopy(subscription.role);
  const fallbackInvite = config.subscriptions.payment.driversChannelInvite;
  const binding = await getChannelBinding(ORDERS_CHANNEL);
  if (!binding) {
    logger.error(
      { paymentId: item.id },
      'Drivers channel is not configured, cannot issue invite link',
    );
    if (subscription.telegramId) {
      try {
        const message = fallbackInvite
          ? [
              '✅ Оплата подписки подтверждена.',
              `Чтобы вступить в ${roleCopy.pluralGenitive}, воспользуйтесь кнопкой «Заказы» ниже.`,
              'Если кнопка не работает, запросите новую ссылку через меню «Получить ссылку на канал».',
            ].join('\n')
          : 'Оплата подтверждена, но канал исполнителей временно недоступен. Мы свяжемся с вами после настройки.';

        const extra = fallbackInvite
          ? {
              reply_markup: Markup.inlineKeyboard([[Markup.button.url('Заказы', fallbackInvite)]]).reply_markup,
            }
          : undefined;

        await telegram.sendMessage(subscription.telegramId, message, extra);
      } catch (error) {
        logger.error(
          { err: error, paymentId: item.id, telegramId: subscription.telegramId },
          'Failed to notify user about missing drivers channel',
        );
      }
    }
    return;
  }

  const paymentMetadata: Record<string, unknown> = {
    receipt: {
      type: subscription.receipt.type,
      fileId: subscription.receipt.fileId,
      chatId: subscription.receipt.chatId,
      messageId: subscription.receipt.messageId,
    },
    moderation: subscription.moderation,
    source: 'manual_review',
  };

  let activation;
  try {
    activation = await activateSubscription({
      telegramId: subscription.telegramId,
      username: subscription.username,
      firstName: subscription.firstName,
      lastName: subscription.lastName,
      phone: subscription.phone,
      executorKind: subscription.role,
      chatId: binding.chatId,
      periodDays: subscription.period.days,
      periodLabel: subscription.period.label,
      amount: item.amount.value,
      currency: item.amount.currency,
      paymentId: subscription.paymentId,
      submittedAt: subscription.submittedAt,
      receiptFileId: subscription.receipt.fileId,
      paymentMetadata,
    });
  } catch (error) {
    logger.error(
      { err: error, paymentId: item.id, telegramId: subscription.telegramId },
      'Failed to activate subscription after payment approval',
    );
    if (subscription.telegramId) {
      try {
        await telegram.sendMessage(
          subscription.telegramId,
          'Оплата подтверждена, но не удалось активировать подписку. Свяжитесь с поддержкой, пожалуйста.',
        );
      } catch (notifyError) {
        logger.error(
          { err: notifyError, paymentId: item.id, telegramId: subscription.telegramId },
          'Failed to notify user about activation failure',
        );
      }
    }
    return;
  }

  const payer: SubscriptionIdentity = {
    telegramId: subscription.telegramId,
    username: subscription.username ?? undefined,
    firstName: subscription.firstName ?? undefined,
    lastName: subscription.lastName ?? undefined,
    phone: subscription.phone,
    shortId: activation.subscriptionId ? String(activation.subscriptionId) : undefined,
    subscriptionStatus: 'active',
    subscriptionExpiresAt: activation.nextBillingAt,
  };

  await reportSubscriptionApproved(
    telegram,
    payer,
    subscription.period.label,
    { value: item.amount.value, currency: item.amount.currency },
    decidedAt,
    activation.nextBillingAt,
  );

  let inviteLink: string | undefined;
  try {
    const expireDate = Math.floor(activation.nextBillingAt.getTime() / 1000);
    const invite = await telegram.createChatInviteLink(binding.chatId, {
      name: `Subscription ${subscription.telegramId} ${subscription.period.days}d`,
      expire_date: expireDate,
      member_limit: 1,
    });
    inviteLink = invite.invite_link;
  } catch (error) {
    logger.error(
      { err: error, paymentId: item.id, chatId: binding.chatId },
      'Failed to create invite link after subscription activation',
    );
  }

  if (!inviteLink && fallbackInvite) {
    inviteLink = fallbackInvite;
  }

  if (!subscription.telegramId) {
    return;
  }

  const expiresLabel = activation.nextBillingAt
    ? formatDateTime(activation.nextBillingAt)
    : undefined;

  const inviteInstructions = inviteLink
    ? `Чтобы вступить в ${roleCopy.pluralGenitive}, нажмите кнопку «Заказы».`
    : 'Ссылка на канал будет отправлена дополнительно. Свяжитесь с поддержкой, если не получили её в ближайшее время.';

  const parts = [
    '✅ Оплата подписки подтверждена.',
    expiresLabel ? `Подписка активна до ${expiresLabel}.` : undefined,
    inviteInstructions,
    'Если ссылка перестанет работать, запросите новую через меню «Получить ссылку на канал».',
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));

  const extra = inviteLink
    ? {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.url('Заказы', inviteLink)],
        ]).reply_markup,
      }
    : undefined;

  try {
    await telegram.sendMessage(subscription.telegramId, parts.join('\n'), extra);
  } catch (error) {
    logger.error(
      { err: error, paymentId: item.id, telegramId: subscription.telegramId },
      'Failed to notify user about approved subscription payment',
    );
  }
};

const handleSubscriptionRejection = async (
  context: ModerationRejectionContext<PaymentReviewItem>,
): Promise<void> => {
  const { item, telegram, reason, decidedAt } = context;
  const subscription = item.subscription;
  if (!subscription?.telegramId) {
    return;
  }

  const reasonText = formatRejectionReason(reason);
  const message = [
    '❌ Оплата подписки не подтверждена.',
    `Причина: ${reasonText}`,
    'Проверьте данные и отправьте новый чек через меню «Получить ссылку на канал».',
  ].join('\n');

  try {
    await telegram.sendMessage(subscription.telegramId, message);
  } catch (error) {
    logger.error(
      { err: error, paymentId: item.id, telegramId: subscription.telegramId },
      'Failed to notify user about rejected subscription payment',
    );
  }

  const payer: SubscriptionIdentity = {
    telegramId: subscription.telegramId,
    username: subscription.username ?? undefined,
    firstName: subscription.firstName ?? undefined,
    lastName: subscription.lastName ?? undefined,
    phone: subscription.phone,
    subscriptionStatus: 'none',
  };

  await reportSubscriptionRejected(
    telegram,
    payer,
    subscription.period.label,
    { value: item.amount.value, currency: item.amount.currency },
    decidedAt,
    reason,
  );
};

const attachPaymentModerationHandlers = (
  payment: PaymentReviewItem,
): PaymentReviewItem => {
  if (payment.subscription) {
    payment.onApprove = handleSubscriptionApproval;
    payment.onReject = handleSubscriptionRejection;
  }

  return payment;
};

const revivePaymentReviewItem = (payload: unknown): PaymentReviewItem | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const payment = payload as PaymentReviewItem;
  return attachPaymentModerationHandlers(payment);
};

const queue: ModerationQueue<PaymentReviewItem> = createModerationQueue<PaymentReviewItem>({
  type: 'payment',
  channelType: BIND_VERIFY_CHANNEL,
  defaultRejectionReasons: DEFAULT_REASONS,
  renderMessage: buildPaymentMessage,
  deserializeItem: revivePaymentReviewItem,
});

export const publishPaymentReview = async (
  telegram: Telegram,
  payment: PaymentReviewItem,
): Promise<PublishModerationResult> => queue.publish(telegram, payment);

export const submitSubscriptionPaymentReview = async (
  telegram: Telegram,
  request: SubscriptionPaymentRequest,
): Promise<PublishModerationResult> => {
  const payment = attachPaymentModerationHandlers(
    createSubscriptionPaymentReviewItem(request),
  );

  const result = await queue.publish(telegram, payment);

  if (result.status === 'published' && payment.subscription) {
    payment.subscription.moderation = {
      chatId: result.chatId,
      messageId: result.messageId,
      token: result.token,
    };

    if (result.chatId !== undefined) {
      await copyReceiptToModerationChannel(
        telegram,
        payment.subscription.receipt,
        result.chatId,
        request.paymentId,
      );
    }
  }

  return result;
};

export const registerPaymentModerationQueue = (bot: Telegraf<BotContext>): void => {
  queue.register(bot);
};

export const restorePaymentModerationQueue = async (): Promise<void> => {
  await queue.restore();
};

export type { PublishModerationResult } from './queue';
