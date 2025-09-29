import type { Telegraf } from 'telegraf';

import type { BotContext } from '../bot/types';
import { startSubscriptionScheduler, stopSubscriptionScheduler } from './scheduler';
import { startInactivityNudger, stopInactivityNudger } from './nudger';
import { startMetricsReporter, stopMetricsReporter } from './metricsReporter';
import { startPaymentReminderJob, stopPaymentReminderJob } from './paymentReminder';

let initialized = false;

export const registerJobs = (bot: Telegraf<BotContext>): void => {
  if (initialized) {
    return;
  }

  startSubscriptionScheduler(bot);
  startInactivityNudger(bot);
  startMetricsReporter();
  startPaymentReminderJob(bot);
  initialized = true;
};

export const stopJobs = (): void => {
  if (!initialized) {
    return;
  }

  stopInactivityNudger();
  stopSubscriptionScheduler();
  stopMetricsReporter();
  stopPaymentReminderJob();
  initialized = false;
};
