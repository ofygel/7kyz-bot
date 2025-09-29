import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import { logger } from '../config';

const registry = new Registry();
registry.setDefaultLabels({ service: 'freedom-bot' });
collectDefaultMetrics({ register: registry });

const updateCounter = new Counter({
  name: 'telegram_updates_total',
  help: 'Total number of Telegram updates processed by the bot',
  labelNames: ['type', 'result'] as const,
  registers: [registry],
});

const updateLatency = new Histogram({
  name: 'telegram_update_duration_seconds',
  help: 'Duration of Telegram update processing in seconds',
  labelNames: ['type'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

const dbErrorsCounter = new Counter({
  name: 'database_errors_total',
  help: 'Total number of database errors observed',
  registers: [registry],
});

const startupTaskRetriesCounter = new Counter({
  name: 'startup_task_retries_total',
  help: 'Total number of retries performed for startup tasks',
  labelNames: ['task', 'event'] as const,
  registers: [registry],
});

export const metricsRegistry = registry;

export const metricsSnapshot = async (): Promise<string> => {
  try {
    return await registry.metrics();
  } catch (error) {
    logger.error({ err: error }, 'Failed to collect Prometheus metrics');
    throw error;
  }
};

export const observeDatabaseError = (): void => {
  dbErrorsCounter.inc();
};

export const observeStartupTaskRetryScheduled = (task: string): void => {
  startupTaskRetriesCounter.inc({ task, event: 'scheduled' });
};

export const observeStartupTaskRetrySuccess = (task: string): void => {
  startupTaskRetriesCounter.inc({ task, event: 'success' });
};

export const observeUpdateStart = (type: string): (() => void) => {
  const updateType = type || 'unknown';
  const stopTimer = updateLatency.startTimer({ type: updateType });
  return () => {
    stopTimer();
  };
};

export const recordUpdateResult = (type: string, result: 'success' | 'error'): void => {
  const updateType = type || 'unknown';
  updateCounter.inc({ type: updateType, result });
};

export const __testing__ = {
  resetMetrics(): void {
    updateCounter.reset();
    updateLatency.reset();
    dbErrorsCounter.reset();
    startupTaskRetriesCounter.reset();
  },
};
