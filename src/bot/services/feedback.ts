import { logger } from '../../config';
import { copy } from '../copy';
import type { BotContext } from '../types';

export const sendProcessingFeedback = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id ?? (ctx.callbackQuery && 'message' in ctx.callbackQuery
    ? ctx.callbackQuery.message?.chat?.id
    : undefined);

  if (typeof chatId === 'number') {
    try {
      await ctx.telegram.sendChatAction(chatId, 'typing');
    } catch (error) {
      logger.debug({ err: error, chatId }, 'Failed to send chat action');
    }
  }

  if (typeof ctx.answerCbQuery === 'function' && ctx.callbackQuery) {
    try {
      await ctx.answerCbQuery(copy.waiting);
    } catch (error) {
      logger.debug({ err: error }, 'Failed to send provisional callback answer');
    }
  }
};

