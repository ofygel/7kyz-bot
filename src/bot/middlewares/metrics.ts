import type { MiddlewareFn } from 'telegraf';

import { recordUpdateResult, observeUpdateStart } from '../../metrics/prometheus';
import type { BotContext } from '../types';

export const metricsCollector = (): MiddlewareFn<BotContext> => async (ctx, next) => {
  const updateType = ctx.updateType ?? 'unknown';
  const stopTimer = observeUpdateStart(updateType);

  try {
    await next();
    recordUpdateResult(updateType, 'success');
  } catch (error) {
    recordUpdateResult(updateType, 'error');
    throw error;
  } finally {
    stopTimer();
  }
};
