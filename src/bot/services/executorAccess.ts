import { logger } from '../../config';
import { pool } from '../../db/client';
import { getRedisClient } from '../../infra/redis';

interface ExecutorOrderAccessRecord {
  hasPhone: boolean;
  isBlocked: boolean;
}

const CACHE_PREFIX = 'executor-access:';
const CACHE_TTL_SECONDS = 60;

const formatCacheKey = (executorId: number): string => `${CACHE_PREFIX}${executorId}`;

const parseCachePayload = (payload: string | null): ExecutorOrderAccessRecord | null => {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Partial<ExecutorOrderAccessRecord>;
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const hasPhone = Boolean(parsed.hasPhone);
    const isBlocked = Boolean(parsed.isBlocked);

    return { hasPhone, isBlocked } satisfies ExecutorOrderAccessRecord;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to parse executor access cache entry');
    return null;
  }
};

const loadExecutorAccessFromCache = async (
  executorId: number,
): Promise<ExecutorOrderAccessRecord | null> => {
  const client = getRedisClient();
  if (!client) {
    return null;
  }

  const cacheKey = formatCacheKey(executorId);

  try {
    const payload = await client.get(cacheKey);
    return parseCachePayload(payload);
  } catch (error) {
    logger.warn({ err: error, executorId }, 'Failed to load executor access cache');
    return null;
  }
};

const saveExecutorAccessToCache = async (
  executorId: number,
  record: ExecutorOrderAccessRecord,
): Promise<void> => {
  const client = getRedisClient();
  if (!client) {
    return;
  }

  const cacheKey = formatCacheKey(executorId);

  try {
    await client.set(cacheKey, JSON.stringify(record), 'EX', CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn({ err: error, executorId }, 'Failed to save executor access cache');
  }
};

const loadExecutorAccessFromDatabase = async (
  executorId: number,
): Promise<ExecutorOrderAccessRecord | null> => {
  try {
    const { rows } = await pool.query<{
      phone: string | null;
      is_blocked: boolean | null;
    }>(
      `
        SELECT phone, is_blocked
        FROM users
        WHERE tg_id = $1
      `,
      [executorId],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    const hasPhone = typeof row.phone === 'string' && row.phone.trim().length > 0;
    const isBlocked = Boolean(row.is_blocked);

    return { hasPhone, isBlocked } satisfies ExecutorOrderAccessRecord;
  } catch (error) {
    logger.error({ err: error, executorId }, 'Failed to query executor access');
    return null;
  }
};

export const getExecutorOrderAccess = async (
  executorId: number,
): Promise<ExecutorOrderAccessRecord | null> => {
  const cached = await loadExecutorAccessFromCache(executorId);
  if (cached) {
    return cached;
  }

  const record = await loadExecutorAccessFromDatabase(executorId);
  if (record) {
    await saveExecutorAccessToCache(executorId, record);
  }

  return record;
};

export const hasExecutorOrderAccess = async (executorId: number): Promise<boolean> => {
  const access = await getExecutorOrderAccess(executorId);
  if (!access) {
    return false;
  }

  return access.hasPhone && !access.isBlocked;
};

export type { ExecutorOrderAccessRecord };
