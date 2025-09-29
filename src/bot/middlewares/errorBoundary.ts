import type { MiddlewareFn } from 'telegraf';

import { logger } from '../../config';
import { copy } from '../copy';
import { resumeLastFlowStep } from '../flows/recovery';
import type { BotContext } from '../types';

export const errorBoundary = (): MiddlewareFn<BotContext> =>
  async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      logger.error(
        { err: error, update: ctx.update },
        'Unhandled error while processing update',
      );

      if (!ctx.chat) {
        return;
      }

      let resumed = false;
      try {
        resumed = await resumeLastFlowStep(ctx);
      } catch (resumeError) {
        logger.error({ err: resumeError }, 'Failed to resume flow after error');
      }

      const message = resumed ? copy.errorRecovered : copy.errorGeneric;

      try {
        await ctx.reply(message);
      } catch (replyError) {
        logger.error({ err: replyError }, 'Failed to notify user about error');
      }
    }
  };
