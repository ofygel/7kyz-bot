import type { MiddlewareFn } from 'telegraf';

import {
  CLIENT_WHITELIST,
  EXECUTOR_WHITELIST,
  clientKeyboard,
  executorKeyboard,
  onboardingKeyboard,
  removeKeyboard,
} from '../ui/menus';
import type { BotContext } from '../types';
import { isSafeModeSession } from '../flows/common/safeMode';
import { showSafeModeCard } from '../ui/safeModeCard';

const hasKnownButtonText = (text: string): boolean =>
  CLIENT_WHITELIST.has(text) || EXECUTOR_WHITELIST.has(text);

const isExecutorUser = (ctx: BotContext): boolean => {
  const role = ctx.auth?.user.role;
  const status = ctx.auth?.user.status;
  if (!ctx.auth?.user) {
    return false;
  }
  return (
    role === 'executor'
    || role === 'moderator'
    || status === 'active_executor'
  );
};

const getMessageText = (ctx: BotContext): string | undefined => {
  const message = ctx.message as { text?: unknown } | undefined;
  if (!message || typeof message.text !== 'string') {
    return undefined;
  }
  const trimmed = message.text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const keyboardGuard = (): MiddlewareFn<BotContext> => async (ctx, next) => {
  if (ctx.chat && ctx.chat.type !== 'private') {
    await next();
    return;
  }

  const text = getMessageText(ctx);
  if (!text || !hasKnownButtonText(text)) {
    await next();
    return;
  }

  const user = ctx.auth?.user;
  if (isSafeModeSession(ctx)) {
    await showSafeModeCard(ctx);
    return;
  }

  if (!user || user.status === 'awaiting_phone' || !user.phoneVerified) {
    await ctx.reply('Нужно авторизоваться, чтобы продолжить.', onboardingKeyboard());
    return;
  }

  if (user.status === 'suspended' || user.status === 'banned') {
    await ctx.reply('Доступ к функциям бота ограничен. Обратитесь в поддержку.', removeKeyboard());
    return;
  }

  if (user.status === 'trial_expired') {
    await ctx.reply('Пробный период завершён. Продлите подписку для продолжения работы.', executorKeyboard());
    return;
  }

  const executor = isExecutorUser(ctx);

  if (EXECUTOR_WHITELIST.has(text) && !executor) {
    await ctx.reply('Этот раздел доступен только исполнителям.', clientKeyboard());
    return;
  }

  if (CLIENT_WHITELIST.has(text) && executor) {
    await ctx.reply('Вы сейчас в режиме исполнителя. Используйте меню исполнителя ниже.', executorKeyboard());
    return;
  }

  await next();
};
