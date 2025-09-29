import type { MiddlewareFn } from 'telegraf';

import type { BotContext } from '../types';

export const onlyPrivate: MiddlewareFn<BotContext> = async (ctx, next) => {
  const chatType = ctx.chat?.type;
  if (chatType && chatType !== 'private') {
    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery('Доступно только в личном чате с ботом.');
      } catch {
        // ignore answer errors
      }
    }

    if (typeof ctx.reply === 'function') {
      try {
        await ctx.reply('Команда доступна только в личном чате с ботом.');
      } catch {
        // swallow reply errors
      }
    }

    return;
  }

  await next();
};
