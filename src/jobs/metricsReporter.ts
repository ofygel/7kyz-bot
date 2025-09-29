import cron, { type ScheduledTask } from 'node-cron';

import { config, logger } from '../config';
import { snapshot } from '../metrics/agg';

let task: ScheduledTask | null = null;

export const startMetricsReporter = (): void => {
  if (task) {
    return;
  }

  task = cron.schedule(
    config.jobs.metrics,
    () => {
      try {
        const current = snapshot();
        logger.info({ metric: 'agg', snapshot: current }, 'metrics_snapshot');
      } catch (error) {
        logger.error({ err: error }, 'metrics_reporter_failed');
      }
    },
    { timezone: config.timezone },
  );
};

export const stopMetricsReporter = (): void => {
  if (!task) {
    return;
  }

  task.stop();
  task = null;
};
