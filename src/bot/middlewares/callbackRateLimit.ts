import rateLimit from 'telegraf-ratelimit';
import type { MiddlewareFn } from 'telegraf';

import type { BotContext } from '../types';
import { copy } from '../copy';

const CALLBACK_WINDOW_MS = 1000;
const CALLBACK_LIMIT = 1;

export const callbackRateLimit = (): MiddlewareFn<BotContext> =>
  (rateLimit({
    window: CALLBACK_WINDOW_MS,
    limit: CALLBACK_LIMIT,
    keyGenerator: (ctx: BotContext) => {
      const userId = ctx.from?.id;
      return typeof userId === 'number' ? `callback:${userId}` : undefined;
    },
    skip: (ctx: BotContext) => !ctx.callbackQuery,
    onLimitExceeded: async (ctx: BotContext) => {
      if (typeof ctx.answerCbQuery !== 'function') {
        return;
      }

      try {
        await ctx.answerCbQuery(copy.tooFrequent);
      } catch {
        // ignore answer errors
      }
    },
  }) as MiddlewareFn<BotContext>);
