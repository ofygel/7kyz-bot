import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import type { AuthUser, BotContext } from '../../types';
import { copy } from '../../copy';
import { buildInlineKeyboard, type KeyboardButton } from '../../keyboards/common';
import { bindInlineKeyboardToUser } from '../../services/callbackTokens';

export const PROFILE_BUTTON_LABEL = '👤 Профиль';

interface ProfileCardActions {
  changeCityAction?: string;
  subscriptionAction?: string;
  supportAction?: string;
}

export interface ProfileCardNavigationOptions extends ProfileCardActions {
  backAction: string;
  homeAction: string;
}

export interface ProfileCardActionOptions extends ProfileCardNavigationOptions {
  onAnswerError?: (error: unknown) => void;
}

const isValidDate = (value?: Date): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

const formatDate = (value: Date): string => value.toLocaleDateString('ru-RU');

const formatDeadline = (value?: Date): string | null => {
  if (!isValidDate(value)) {
    return null;
  }

  const formatted = formatDate(value);
  const msLeft = value.getTime() - Date.now();
  if (msLeft <= 0) {
    return formatted;
  }

  const daysLeft = Math.max(1, Math.ceil(msLeft / 86_400_000));
  return `${formatted} (осталось ${daysLeft} дн.)`;
};

const formatVerificationStatus = (user: AuthUser): string => {
  if (user.isVerified) {
    return isValidDate(user.verifiedAt) ? `подтверждена (${formatDate(user.verifiedAt)})` : 'подтверждена';
  }

  switch (user.verifyStatus) {
    case 'pending':
      return 'на проверке';
    case 'rejected':
      return 'отклонена';
    case 'expired':
      return 'истекла';
    case 'active':
      return isValidDate(user.verifiedAt) ? `подтверждена (${formatDate(user.verifiedAt)})` : 'подтверждена';
    case 'none':
    default:
      return 'не запрашивалась';
  }
};

const formatSubscriptionStatus = (user: AuthUser): string => {
  const plan = user.activeExecutorPlan;
  const subscriptionExpiry = isValidDate(user.subscriptionExpiresAt)
    ? user.subscriptionExpiresAt
    : undefined;
  const planExpiry = plan && isValidDate(plan.endsAt) ? plan.endsAt : undefined;

  if (plan && plan.planChoice === 'trial' && plan.status === 'active') {
    const deadline = formatDeadline(planExpiry ?? subscriptionExpiry);
    return deadline ? `пробный доступ до ${deadline}` : 'пробный доступ активен';
  }

  switch (user.subscriptionStatus) {
    case 'active': {
      const deadline = formatDeadline(planExpiry ?? subscriptionExpiry);
      return deadline ? `активна до ${deadline}` : 'активна';
    }
    case 'grace': {
      const deadline = formatDeadline(planExpiry ?? subscriptionExpiry);
      return deadline ? `период продления до ${deadline}` : 'период продления';
    }
    case 'expired': {
      const deadline = formatDeadline(subscriptionExpiry ?? planExpiry);
      return deadline ? `истекла ${deadline}` : 'истекла';
    }
    case 'none':
    default:
      return 'не активна';
  }
};

const formatTrialStatus = (user: AuthUser): string => {
  const plan = user.activeExecutorPlan;
  if (!plan || plan.planChoice !== 'trial') {
    return 'не активирован';
  }

  if (plan.status === 'blocked') {
    return 'приостановлен';
  }

  const expires = isValidDate(plan.endsAt)
    ? plan.endsAt
    : isValidDate(user.subscriptionExpiresAt)
      ? user.subscriptionExpiresAt
      : undefined;

  if (!expires) {
    return plan.status === 'active' ? 'активен' : 'не активен';
  }

  if (expires.getTime() <= Date.now()) {
    return `истёк ${formatDate(expires)}`;
  }

  const deadline = formatDeadline(expires);
  return deadline ? `активен до ${deadline}` : 'активен';
};

const shouldHideSubscriptionForUser = (ctx: BotContext): boolean =>
  ctx.auth?.user.role === 'client';

const PERFORMANCE_LABELS: Record<string, string> = {
  completionRate: 'Доля завершённых заказов',
  ordersCompleted: 'Выполнено заказов',
  ordersCancelled: 'Отменено заказов',
  rating: 'Рейтинг',
  earningsTotal: 'Заработок',
};

const numberFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

const formatMetricLabel = (key: string): string => {
  const predefined = PERFORMANCE_LABELS[key];
  if (predefined) {
    return predefined;
  }

  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\s]+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const formatMetricValue = (key: string, value: number | string): string => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('rate') || lowerKey.includes('ratio') || lowerKey.includes('percent')) {
      const percent = value > 1 ? value : value * 100;
      return `${Math.round(percent)}%`;
    }

    return numberFormatter.format(value);
  }

  return String(value);
};

const extractPerformanceMetrics = (user: AuthUser): string[] => {
  const sources = [user.performanceMetrics, user.performance];
  const metrics = new Map<string, number | string>();

  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }

    for (const [key, rawValue] of Object.entries(source)) {
      if (metrics.has(key)) {
        continue;
      }

      if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        metrics.set(key, rawValue);
      } else if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
        metrics.set(key, rawValue.trim());
      }
    }
  }

  return Array.from(metrics.entries()).map(([key, metricValue]) =>
    `${formatMetricLabel(key)}: ${formatMetricValue(key, metricValue)}`,
  );
};

export const buildProfileCardText = (ctx: BotContext): string => {
  const authUser = ctx.auth?.user;
  const lines = ['👤 Профиль', ''];

  if (!authUser) {
    lines.push('Данные профиля временно недоступны.');
    return lines.join('\n');
  }

  const phoneLabel = authUser.phone
    ? `${authUser.phone}${authUser.phoneVerified ? ' (подтверждён)' : ' (не подтверждён)'}`
    : '—';

  lines.push(`ID: ${authUser.telegramId}`);
  lines.push(`Имя: ${authUser.firstName ?? '—'} ${authUser.lastName ?? ''}`.trim());
  lines.push(`Логин: ${authUser.username ? `@${authUser.username}` : '—'}`);
  lines.push(`Роль: ${authUser.role}`);
  lines.push(`Статус: ${authUser.status}`);
  lines.push(`Телефон: ${phoneLabel}`);
  lines.push(`Город: ${authUser.citySelected ?? '—'}`);

  lines.push('');
  lines.push(`Верификация: ${formatVerificationStatus(authUser)}`);
  if (!shouldHideSubscriptionForUser(ctx)) {
    lines.push(`Подписка: ${formatSubscriptionStatus(authUser)}`);
  }
  lines.push(`Пробный период: ${formatTrialStatus(authUser)}`);
  lines.push(`Активный заказ: ${authUser.hasActiveOrder ? 'да' : 'нет'}`);

  const performanceLines = extractPerformanceMetrics(authUser);
  if (performanceLines.length > 0) {
    lines.push('');
    lines.push('Показатели:');
    for (const metric of performanceLines) {
      lines.push(`• ${metric}`);
    }
  }

  return lines.join('\n');
};

const buildProfileCardKeyboard = (
  ctx: BotContext,
  options: ProfileCardNavigationOptions,
): InlineKeyboardMarkup | undefined => {
  const rows: KeyboardButton[][] = [];

  if (options.changeCityAction) {
    rows.push([{ label: '🏙️ Сменить город', action: options.changeCityAction }]);
  }

  if (options.subscriptionAction && !shouldHideSubscriptionForUser(ctx)) {
    rows.push([{ label: '💳 Подписка', action: options.subscriptionAction }]);
  }

  if (options.supportAction) {
    rows.push([{ label: '🆘 Помощь', action: options.supportAction }]);
  }

  rows.push([
    { label: copy.back, action: options.backAction },
    { label: copy.home, action: options.homeAction },
  ]);

  const keyboard = buildInlineKeyboard(rows);

  return bindInlineKeyboardToUser(ctx, keyboard);
};

const isMessageNotModifiedError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const description = (error as { description?: unknown }).description;
  if (typeof description === 'string' && description.includes('message is not modified')) {
    return true;
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string' && message.includes('message is not modified')) {
    return true;
  }

  return false;
};

export const renderProfileCard = async (
  ctx: BotContext,
  options: ProfileCardNavigationOptions,
): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    if (ctx.callbackQuery) {
      try {
        await ctx.answerCbQuery('Карточка доступна только в личном чате.');
      } catch {
        // Ignore answer errors
      }
    } else if (ctx.chat) {
      try {
        await ctx.reply('Карточка доступна только в личном чате.');
      } catch {
        // Ignore send errors
      }
    }

    return;
  }

  const text = buildProfileCardText(ctx);
  const reply_markup = buildProfileCardKeyboard(ctx, options);

  const message = ctx.callbackQuery?.message;
  if (message && 'message_id' in message && typeof message.message_id === 'number') {
    try {
      await ctx.editMessageText(text, { reply_markup });
      return;
    } catch (error) {
      if (isMessageNotModifiedError(error)) {
        return;
      }
      // Fallback to sending a new message below
    }
  }

  await ctx.reply(text, { reply_markup });
};

export const renderProfileCardFromAction = async (
  ctx: BotContext,
  options: ProfileCardActionOptions,
): Promise<void> => {
  if (ctx.chat?.type === 'private' && ctx.callbackQuery) {
    try {
      await ctx.answerCbQuery();
    } catch (error) {
      options.onAnswerError?.(error);
    }
  }

  await renderProfileCard(ctx, options);
};

export const createProfileCardActionHandler = (
  options: ProfileCardActionOptions,
): ((ctx: BotContext) => Promise<void>) => {
  return async (ctx: BotContext) => {
    await renderProfileCardFromAction(ctx, options);
  };
};

export const __testing__ = {
  buildProfileCardKeyboard,
  isMessageNotModifiedError,
};
