import type { Telegraf } from 'telegraf';

import type { BotContext } from '../bot/types';
import { logger } from '../config';

/**
 * Deprecated payment reminder job. Executor reminders are now handled by the CRM scheduler.
 */
export const startPaymentReminderJob = (_bot: Telegraf<BotContext>): void => {
  logger.info('paymentReminder job is disabled in favour of executor plan reminders');
};

export const stopPaymentReminderJob = (): void => {
  // intentionally empty
};
