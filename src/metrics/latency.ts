import { logger } from '../config';

export const withLatencyLog = async <T>(name: string, handler: () => Promise<T>): Promise<T> => {
  const startedAt = Date.now();
  try {
    return await handler();
  } finally {
    const duration = Date.now() - startedAt;
    logger.info({ metric: 'latency_ms', name, value: duration }, 'Latency sample');
  }
};
