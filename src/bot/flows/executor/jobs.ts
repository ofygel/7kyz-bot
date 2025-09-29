import { Telegraf } from 'telegraf';

import type { BotContext } from '../../types';

const SUPPORT_USERNAME = 'support_seven';

export const processOrdersRequest = async (ctx: BotContext): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  await ctx.reply(
    `Чтобы получить заказы, напишите @${SUPPORT_USERNAME} — поддержка подскажет, как подключиться к каналу.`,
  );
};

export const registerExecutorJobs = (_bot: Telegraf<BotContext>): void => {
  // Интерактивная лента заказов отключена.
};

export const registerExecutorOrders = registerExecutorJobs;
