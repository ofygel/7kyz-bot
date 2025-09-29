import { type MiddlewareFn } from 'telegraf';

import type { BotContext } from '../types';

export const ensureVerifiedExecutor: MiddlewareFn<BotContext> = async (_ctx, next) => {
  await next();
};
