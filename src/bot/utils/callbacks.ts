import type { BotContext } from '../types';
import { logger } from '../../config';

export type AnswerCbQueryOptions = Parameters<NonNullable<BotContext['answerCbQuery']>>[1];

const ensureFallbackText = (text?: string): string =>
  text && text.trim().length > 0 ? text : 'Не удалось обработать действие. Попробуйте ещё раз.';

const sendFallbackMessage = async (ctx: BotContext, text?: string): Promise<void> => {
  const fallbackText = ensureFallbackText(text);
  const recipientId = ctx.from?.id;

  if (typeof recipientId === 'number') {
    try {
      await ctx.telegram.sendMessage(recipientId, fallbackText);
      return;
    } catch (error) {
      logger.warn({ err: error, recipientId }, 'Failed to send callback fallback via direct message');
    }
  }

  if (typeof ctx.reply === 'function') {
    try {
      await ctx.reply(fallbackText);
      return;
    } catch (error) {
      logger.warn({ err: error }, 'Failed to send callback fallback via reply');
    }
  }
};

export const answerCallbackQuerySafely = async (
  ctx: BotContext,
  text?: string,
  options?: AnswerCbQueryOptions,
): Promise<void> => {
  if (typeof ctx.answerCbQuery !== 'function') {
    await sendFallbackMessage(ctx, text);
    return;
  }

  try {
    await ctx.answerCbQuery(text, options);
  } catch (error) {
    logger.warn({ err: error, userId: ctx.from?.id }, 'Failed to answer callback query');
    await sendFallbackMessage(ctx, text);
  }
};
