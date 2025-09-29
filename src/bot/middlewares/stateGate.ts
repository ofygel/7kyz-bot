import type { MiddlewareFn } from 'telegraf';

import { executorKeyboard, onboardingKeyboard, removeKeyboard } from '../ui/menus';
import type { BotContext } from '../types';
import { logger } from '../../config';
import { isSafeModeSession } from '../flows/common/safeMode';
import { showSafeModeCard } from '../ui/safeModeCard';

const GUEST_ALLOWLIST = new Set<string>([
  '/start',
  '/help',
  'Отправить мой номер телефона',
  'Отправить номер',
  '📲 Поделиться контактом',
]);

const isContactMessage = (ctx: BotContext): boolean =>
  Boolean((ctx.message as { contact?: unknown } | undefined)?.contact);

const getMessageText = (ctx: BotContext): string | undefined => {
  const message = ctx.message as { text?: unknown } | undefined;
  if (!message || typeof message.text !== 'string') {
    return undefined;
  }
  const trimmed = message.text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const isExecutorUser = (ctx: BotContext): boolean => {
  const role = ctx.auth?.user?.role;
  const status = ctx.auth?.user?.status;

  if (!ctx.auth?.user) {
    return false;
  }

  return role === 'executor' || role === 'moderator' || status === 'active_executor';
};

export const stateGate = (): MiddlewareFn<BotContext> => async (ctx, next) => {
  const chatType = ctx.chat?.type;
  const isChannelChat = chatType === 'channel';

  if (chatType && chatType !== 'private') {
    await next();
    return;
  }

  const user = ctx.auth?.user;
  const text = getMessageText(ctx);
  const isCallbackQuery = Boolean(ctx.callbackQuery);

  const answerCallbackQuery = async (message: string) => {
    if (!isCallbackQuery || typeof ctx.answerCbQuery !== 'function') {
      return;
    }

    try {
      await ctx.answerCbQuery(message, { show_alert: false });
    } catch (error) {
      logger.debug({ err: error }, 'Failed to answer callback query in stateGate');
    }
  };

  if (isSafeModeSession(ctx)) {
    const warning = 'Сервис временно работает в безопасном режиме.';
    await answerCallbackQuery(warning);

    if (!isCallbackQuery || !isChannelChat) {
      await showSafeModeCard(ctx, { prompt: 'Доступны только базовые действия ниже.' });
    }
    return;
  }

  if (!user || user.status === 'awaiting_phone' || !user.phoneVerified) {
    if (!text || GUEST_ALLOWLIST.has(text) || isContactMessage(ctx)) {
      await next();
      return;
    }

    const warning = 'Чтобы продолжить, отправьте номер телефона через кнопку ниже.';
    await answerCallbackQuery(warning);

    if (!isCallbackQuery || !isChannelChat) {
      await ctx.reply(warning, onboardingKeyboard());
    }
    return;
  }

  if (user.status === 'suspended' || user.status === 'banned') {
    const warning = 'Доступ к функциям бота ограничен. Обратитесь в поддержку.';
    await answerCallbackQuery(warning);

    if (!isCallbackQuery || !isChannelChat) {
      await ctx.reply(warning, removeKeyboard());
    }
    return;
  }

  const executor = isExecutorUser(ctx);

  if (executor && user.status === 'trial_expired') {
    const warning =
      'Пробный период завершён. Продлите подписку, чтобы продолжить получать заказы.';
    await answerCallbackQuery(warning);

    if (!isCallbackQuery || !isChannelChat) {
      await ctx.reply(warning, executorKeyboard());
    }
    return;
  }

  await next();
};
