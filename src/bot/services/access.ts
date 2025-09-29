import type { BotContext } from '../types';

const DEFAULT_PRIVATE_ONLY_MESSAGE = 'Доступно только в личных сообщениях с ботом.';

export const isPrivateChat = (ctx: BotContext): boolean => ctx.chat?.type === 'private';

export const ensurePrivateChat = async (
  ctx: BotContext,
  response = DEFAULT_PRIVATE_ONLY_MESSAGE,
): Promise<boolean> => {
  if (isPrivateChat(ctx)) {
    return true;
  }

  if ('answerCbQuery' in ctx && ctx.callbackQuery) {
    try {
      await ctx.answerCbQuery(response);
    } catch (error) {
      // ignore failures silently; nothing we can do for closed callbacks
    }
    return false;
  }

  if (typeof ctx.reply === 'function') {
    await ctx.reply(response);
  }

  return false;
};

export const ensurePrivateCallback = async (
  ctx: BotContext,
  successMessage?: string,
  failureMessage = DEFAULT_PRIVATE_ONLY_MESSAGE,
): Promise<boolean> => {
  if (!ctx.callbackQuery) {
    return ensurePrivateChat(ctx, failureMessage);
  }

  if (!isPrivateChat(ctx)) {
    try {
      await ctx.answerCbQuery(failureMessage);
    } catch (error) {
      // swallow telegram errors
    }
    return false;
  }

  try {
    await ctx.answerCbQuery(successMessage);
  } catch (error) {
    // ignore failures silently
  }

  return true;
};
