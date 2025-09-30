import { Telegraf } from 'telegraf';

import type { BotContext } from '../../types';
import { config } from '../../../config';

export const processOrdersRequest = async (ctx: BotContext): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  await ctx.reply(
    `Чтобы получить заказы, напишите ${config.support.mention} — поддержка подскажет, как подключиться к каналу.`,
  );
};

export const registerExecutorJobs = (_bot: Telegraf<BotContext>): void => {
  // Интерактивная лента заказов отключена в пользу ручной модерации.
};
