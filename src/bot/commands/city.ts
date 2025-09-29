import type { Telegraf } from 'telegraf';

import type { BotContext } from '../types';
import { askCity, registerCityAction } from '../flows/common/citySelect';

export const registerCityCommand = (bot: Telegraf<BotContext>): void => {
  bot.command('city', async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Пожалуйста, смените город в личном чате с ботом.');
      return;
    }

    await askCity(ctx, 'Смените город:');
  });

  registerCityAction(bot);
};
