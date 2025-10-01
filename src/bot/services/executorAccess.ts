import { config, logger } from '../../config';
import { pool } from '../../db/client';
import { getRedisClient } from '../../infra/redis';

export interface ExecutorOrderAccessPrimaryData {
  phone: string | null;
  isBlocked: boolean;
}

interface ExecutorOrderAccessRecord {
  hasPhone: boolean;
  isBlocked: boolean;
}

const CACHE_PREFIX = 'executor-access:';
const CACHE_BACKUP_PREFIX = 'executor-access:backup:';
const CACHE_TTL_SECONDS = config.bot.executorAccessCacheTtlSeconds;

const formatCacheKey = (executorId: number): string => `${CACHE_PREFIX}${executorId}`;
const formatBackupKey = (executorId: number): string => `${CACHE_BACKUP_PREFIX}${executorId}`;

const parseCachePayload = (payload: string | null): ExecutorOrderAccessPrimaryData | null => {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Partial<ExecutorOrderAccessPrimaryData>;
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const phone = typeof parsed.phone === 'string' ? parsed.phone : null;
    const isBlocked = Boolean(parsed.isBlocked);

    return { phone, isBlocked } satisfies ExecutorOrderAccessPrimaryData;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to parse executor access cache entry');
    return null;
  }
};

const loadExecutorAccessFromCache = async (
  executorId: number,
): Promise<ExecutorOrderAccessPrimaryData | null> => {
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

const loadExecutorAccessFromBackup = async (
  executorId: number,
): Promise<ExecutorOrderAccessPrimaryData | null> => {
  const client = getRedisClient();
  if (!client) {
    return null;
  }

  const cacheKey = formatBackupKey(executorId);

  try {
    const payload = await client.get(cacheKey);
    return parseCachePayload(payload);
  } catch (error) {
    logger.warn({ err: error, executorId }, 'Failed to load executor access backup cache');
    return null;
  }
};

const saveExecutorAccessToCache = async (
  executorId: number,
  record: ExecutorOrderAccessPrimaryData,
  ttlSeconds = CACHE_TTL_SECONDS,
): Promise<void> => {
  const client = getRedisClient();
  if (!client) {
    return;
  }

  const cacheKey = formatCacheKey(executorId);

  try {
    await client.set(cacheKey, JSON.stringify(record), 'EX', ttlSeconds);
  } catch (error) {
    logger.warn({ err: error, executorId }, 'Failed to save executor access cache');
  }
};

const saveExecutorAccessBackup = async (
  executorId: number,
  record: ExecutorOrderAccessPrimaryData,
): Promise<void> => {
  const client = getRedisClient();
  if (!client) {
    return;
  }

  const cacheKey = formatBackupKey(executorId);

  try {
    await client.set(cacheKey, JSON.stringify(record));
  } catch (error) {
    logger.warn({ err: error, executorId }, 'Failed to save executor access backup cache');
  }
};

const loadExecutorAccessFromDatabase = async (
  executorId: number,
): Promise<ExecutorOrderAccessPrimaryData | null> => {
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

    const phone = typeof row.phone === 'string' ? row.phone : null;
    const isBlocked = Boolean(row.is_blocked);

    return { phone, isBlocked } satisfies ExecutorOrderAccessPrimaryData;
  } catch (error) {
    logger.error({ err: error, executorId }, 'Failed to query executor access');
    throw error;
  }
};

const mapPrimaryToRecord = (primary: ExecutorOrderAccessPrimaryData): ExecutorOrderAccessRecord => ({
  hasPhone: typeof primary.phone === 'string' && primary.phone.trim().length > 0,
  isBlocked: primary.isBlocked,
});

const rememberExecutorAccessSnapshot = async (
  executorId: number,
  record: ExecutorOrderAccessPrimaryData,
  options?: { ttlSeconds?: number },
): Promise<void> => {
  await Promise.all([
    saveExecutorAccessToCache(executorId, record, options?.ttlSeconds),
    saveExecutorAccessBackup(executorId, record),
  ]);
};

const mergeExecutorAccessSnapshot = async (
  executorId: number,
  patch: Partial<ExecutorOrderAccessPrimaryData>,
): Promise<ExecutorOrderAccessPrimaryData> => {
  const existing =
    (await loadExecutorAccessFromCache(executorId))
      ?? (await loadExecutorAccessFromBackup(executorId))
      ?? { phone: null, isBlocked: false };

  const record: ExecutorOrderAccessPrimaryData = {
    phone: patch.phone !== undefined ? patch.phone : existing.phone,
    isBlocked: patch.isBlocked !== undefined ? patch.isBlocked : existing.isBlocked,
  };

  return record;
};

export const getExecutorOrderAccess = async (
  executorId: number,
): Promise<ExecutorOrderAccessRecord | null> => {
  const cached = await loadExecutorAccessFromCache(executorId);
  if (cached) {
    return mapPrimaryToRecord(cached);
  }

  try {
    const record = await loadExecutorAccessFromDatabase(executorId);
    if (!record) {
      return null;
    }

    await rememberExecutorAccessSnapshot(executorId, record);
    return mapPrimaryToRecord(record);
  } catch (error) {
    const fallback = await loadExecutorAccessFromBackup(executorId);
    if (fallback) {
      logger.warn({ err: error, executorId }, 'Using executor access backup after database error');
      return mapPrimaryToRecord(fallback);
    }

    return null;
  }
};

export const primeExecutorOrderAccessCache = async (
  executorId: number,
  record: ExecutorOrderAccessPrimaryData,
  options?: { ttlSeconds?: number },
): Promise<void> => {
  await rememberExecutorAccessSnapshot(executorId, record, options);
};

const deleteExecutorAccessCacheKey = async (
  client: NonNullable<ReturnType<typeof getRedisClient>>,
  key: string,
): Promise<void> => {
  try {
    await client.del(key);
  } catch (error) {
    logger.warn({ err: error, key }, 'Failed to delete executor access cache key');
  }
};

export const clearExecutorOrderAccessCache = async (executorId: number): Promise<void> => {
  const client = getRedisClient();
  if (!client) {
    return;
  }

  await Promise.all([
    deleteExecutorAccessCacheKey(client, formatCacheKey(executorId)),
    deleteExecutorAccessCacheKey(client, formatBackupKey(executorId)),
  ]);
};

export const refreshExecutorOrderAccessCache = async (
  executorId: number,
  record?: ExecutorOrderAccessPrimaryData | null,
  options?: { ttlSeconds?: number },
): Promise<void> => {
  await clearExecutorOrderAccessCache(executorId);

  if (record) {
    await primeExecutorOrderAccessCache(executorId, record, options);
  }
};

export const updateCachedExecutorAccess = async (
  executorId: number,
  patch: Partial<ExecutorOrderAccessPrimaryData>,
  options?: { ttlSeconds?: number },
): Promise<void> => {
  const record = await mergeExecutorAccessSnapshot(executorId, patch);
  await refreshExecutorOrderAccessCache(executorId, record, options);
};

export const hasExecutorOrderAccess = async (executorId: number): Promise<boolean> => {
  const access = await getExecutorOrderAccess(executorId);
  if (!access) {
    return false;
  }

  return access.hasPhone && !access.isBlocked;
};

