import type { Telegraf } from 'telegraf';

import type { BotContext } from '../bot/types';
import { startSubscriptionScheduler, stopSubscriptionScheduler } from './scheduler';
import { startInactivityNudger, stopInactivityNudger } from './nudger';
import { startMetricsReporter, stopMetricsReporter } from './metricsReporter';
import {
  startExecutorPlanReminderService,
  stopExecutorPlanReminderService,
} from './executorPlanReminders';
import { startUserPhoneSync, stopUserPhoneSync } from './userPhoneSync';
import { startPaymentFollowUpJob, stopPaymentFollowUpJob } from './paymentFollowUp';

let initialized = false;

export const registerJobs = (bot: Telegraf<BotContext>): void => {
  if (initialized) {
    return;
  }

  startSubscriptionScheduler(bot);
  startInactivityNudger(bot);
  startMetricsReporter();
  startExecutorPlanReminderService(bot);
  startUserPhoneSync();
  startPaymentFollowUpJob(bot);
  initialized = true;
};

export const stopJobs = (): void => {
  if (!initialized) {
    return;
  }

  stopInactivityNudger();
  stopSubscriptionScheduler();
  stopMetricsReporter();
  void stopExecutorPlanReminderService();
  stopUserPhoneSync();
  stopPaymentFollowUpJob();
  initialized = false;
};
