import type Redis from 'ioredis';

import { logger } from '../config';
import { getRedisClient } from './redis';

export interface FlowStepCleanupOptions {
  olderThanSeconds: number;
  batchSize?: number;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const readIdleSeconds = (result: [Error | null, unknown], key: string): number | null => {
  const [error, value] = result;
  if (error) {
    logger.warn({ err: error, key }, 'Failed to inspect Redis key idle time');
    return null;
  }

  if (isNumber(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const deleteKeys = async (client: Redis, keys: string[]): Promise<number> => {
  if (keys.length === 0) {
    return 0;
  }

  try {
    return await client.del(...keys);
  } catch (error) {
    logger.warn({ err: error, keysCount: keys.length }, 'Failed to delete stale flow step keys');
    return 0;
  }
};

export const cleanupStaleFlowSteps = async (
  options: FlowStepCleanupOptions,
): Promise<number> => {
  const client = getRedisClient();
  if (!client) {
    return 0;
  }

  const threshold = Math.max(1, Math.floor(options.olderThanSeconds));
  const batchSize = Math.max(10, Math.floor(options.batchSize ?? 100));

  let cursor = '0';
  let removed = 0;

  try {
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', 'step:*', 'COUNT', batchSize);
      cursor = nextCursor;

      if (keys.length === 0) {
        continue;
      }

      const pipeline = client.pipeline();
      keys.forEach((key) => {
        pipeline.call('OBJECT', 'idletime', key);
      });

      const results = (await pipeline.exec()) ?? [];
      const staleKeys: string[] = [];

      results.forEach((result, index) => {
        const idleSeconds = readIdleSeconds(result as [Error | null, unknown], keys[index]);
        if (idleSeconds !== null && idleSeconds >= threshold) {
          staleKeys.push(keys[index]);
        }
      });

      removed += await deleteKeys(client, staleKeys);
    } while (cursor !== '0');
  } catch (error) {
    logger.warn({ err: error }, 'Failed to perform flow step cleanup');
  }

  return removed;
};
