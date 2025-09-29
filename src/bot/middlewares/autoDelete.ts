import type { MiddlewareFn } from 'telegraf';

import { logger } from '../../config';
import { ui } from '../ui';
import type { BotContext } from '../types';

export const autoDelete = (): MiddlewareFn<BotContext> => async (ctx, next) => {
  if (ctx.chat?.id && ctx.session.ephemeralMessages.length > 0) {
    const chatId = ctx.chat.id;
    const messages = [...ctx.session.ephemeralMessages];
    ctx.session.ephemeralMessages = [];

    for (const messageId of messages) {
      try {
        await ctx.telegram.deleteMessage(chatId, messageId);
      } catch (error) {
        logger.warn(
          { err: error, chatId, messageId },
          'Failed to auto-delete message',
        );
      }
    }
  }

  const homeActions = ctx.session.ui?.homeActions ?? [];
  if (
    ctx.callbackQuery &&
    'data' in ctx.callbackQuery &&
    homeActions.includes(ctx.callbackQuery.data)
  ) {
    await ui.clear(ctx);
  }

  await next();
};
