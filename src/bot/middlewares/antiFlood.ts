import type { MiddlewareFn } from 'telegraf';

import type { BotContext } from '../types';
import { copy } from '../copy';

const WINDOW_MS = 3000;
const MAX_EVENTS = 6;

const buckets = new Map<number, number[]>();

export const antiFlood = (): MiddlewareFn<BotContext> => async (ctx, next) => {
  const userId = ctx.from?.id;
  if (typeof userId !== 'number') {
    await next();
    return;
  }

  const now = Date.now();
  const timestamps = buckets.get(userId) ?? [];
  const recent = timestamps.filter((timestamp) => now - timestamp < WINDOW_MS);
  recent.push(now);
  buckets.set(userId, recent);

  if (recent.length > MAX_EVENTS) {
    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery(copy.tooFrequent);
      } catch {
        // ignore answer errors
      }
    }
    return;
  }

  await next();
};
