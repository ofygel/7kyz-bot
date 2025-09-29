import { config, logger } from '../config';
import { persistPhoneVerification } from '../db/phoneVerification';
import { getRedisClient } from './redis';

const PHONE_UPDATE_QUEUE_KEY = 'user-phone-updates';
const MAX_UPDATES_PER_FLUSH = 100;

export interface QueuedPhoneUpdate {
  telegramId: number;
  phone: string;
}

const resolveQueueKey = (): string => {
  const prefix = config.session.redis?.keyPrefix ?? 'session:';
  return `${prefix}${PHONE_UPDATE_QUEUE_KEY}`;
};

const serialiseUpdate = (update: QueuedPhoneUpdate): string => JSON.stringify(update);

const parseUpdate = (raw: string): QueuedPhoneUpdate | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<QueuedPhoneUpdate>;
    if (
      !parsed
      || typeof parsed.telegramId !== 'number'
      || Number.isNaN(parsed.telegramId)
      || typeof parsed.phone !== 'string'
    ) {
      return null;
    }

    return { telegramId: parsed.telegramId, phone: parsed.phone };
  } catch (error) {
    logger.error({ err: error, raw }, 'Failed to parse queued phone update payload');
    return null;
  }
};

export const enqueueUserPhoneUpdate = async (update: QueuedPhoneUpdate): Promise<void> => {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Redis is not configured; cannot enqueue phone update');
  }

  await redis.rpush(resolveQueueKey(), serialiseUpdate(update));
};

export const flushUserPhoneUpdates = async (): Promise<void> => {
  const redis = getRedisClient();
  if (!redis) {
    return;
  }

  const queueKey = resolveQueueKey();

  for (let processed = 0; processed < MAX_UPDATES_PER_FLUSH; processed += 1) {
    const raw = await redis.lpop(queueKey);
    if (!raw) {
      break;
    }

    const update = parseUpdate(raw);
    if (!update) {
      continue;
    }

    try {
      await persistPhoneVerification(update);
    } catch (error) {
      logger.error(
        { err: error, telegramId: update.telegramId },
        'Failed to persist queued phone update',
      );
      await redis.lpush(queueKey, raw);
      break;
    }
  }
};
