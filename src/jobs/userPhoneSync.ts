import { config, logger } from '../config';
import { flushUserPhoneUpdates } from '../infra/userPhoneQueue';

let timer: NodeJS.Timeout | null = null;

const runFlush = async (): Promise<void> => {
  try {
    await flushUserPhoneUpdates();
  } catch (error) {
    logger.error({ err: error }, 'Failed to flush queued phone updates');
  }
};

export const startUserPhoneSync = (): void => {
  if (timer) {
    return;
  }

  void runFlush();

  timer = setInterval(() => {
    void runFlush();
  }, config.jobs.phoneSyncIntervalMs);

  timer.unref?.();
};

export const stopUserPhoneSync = (): void => {
  if (!timer) {
    return;
  }

  clearInterval(timer);
  timer = null;
};
