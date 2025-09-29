import type { MiddlewareFn } from 'telegraf';

import { renderMenuFor } from '../ui/menus';
import type { BotContext } from '../types';

export const unknownHandler: MiddlewareFn<BotContext> = async (ctx) => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  await ctx.reply('Я пока не понял сообщение. Пожалуйста, выберите действие в меню ниже.');
  await renderMenuFor(ctx);
};
