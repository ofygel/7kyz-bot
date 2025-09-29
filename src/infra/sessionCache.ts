import type { SessionState } from '../bot/types';
import type { SessionKey } from '../db/sessions';
import { config, logger } from '../config';
import { getRedisClient } from './redis';

const CACHE_PREFIX = config.session.redis?.keyPrefix ?? 'session:';
const SESSION_TTL = config.session.ttlSeconds;

const formatKey = (key: SessionKey): string => `${CACHE_PREFIX}${key.scope}:${key.scopeId}`;

export const loadSessionCache = async (key: SessionKey): Promise<SessionState | null> => {
  const client = getRedisClient();
  if (!client) {
    return null;
  }

  try {
    const payload = await client.get(formatKey(key));
    if (!payload) {
      return null;
    }

    return JSON.parse(payload) as SessionState;
  } catch (error) {
    logger.warn({ err: error, cacheKey: formatKey(key) }, 'Failed to load session cache');
    return null;
  }
};

export const saveSessionCache = async (key: SessionKey, state: SessionState): Promise<void> => {
  const client = getRedisClient();
  if (!client) {
    return;
  }

  try {
    const payload = JSON.stringify(state);
    await client.set(formatKey(key), payload, 'EX', SESSION_TTL);
  } catch (error) {
    logger.warn({ err: error, cacheKey: formatKey(key) }, 'Failed to save session cache');
  }
};

export const deleteSessionCache = async (key: SessionKey): Promise<void> => {
  const client = getRedisClient();
  if (!client) {
    return;
  }

  try {
    await client.del(formatKey(key));
  } catch (error) {
    logger.warn({ err: error, cacheKey: formatKey(key) }, 'Failed to delete session cache');
  }
};
