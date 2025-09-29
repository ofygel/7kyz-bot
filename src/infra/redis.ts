import Redis from 'ioredis';

import { config, logger } from '../config';

type RedisClient = Redis | undefined;

let client: RedisClient;
let initialised = false;

const createClient = (): RedisClient => {
  const redisConfig = config.session.redis;
  if (!redisConfig) {
    return undefined;
  }

  const instance = new Redis(redisConfig.url, {
    maxRetriesPerRequest: 2,
    reconnectOnError: () => true,
    lazyConnect: true,
  });

  instance.on('error', (error) => {
    logger.warn({ err: error }, 'Redis connection error');
  });

  instance.on('reconnecting', () => {
    logger.debug('Reconnecting to Redis…');
  });

  instance.on('connect', () => {
    logger.debug('Redis connection established');
  });

  return instance;
};

export const getRedisClient = (): RedisClient => {
  if (!initialised) {
    client = createClient();
    initialised = true;
  }

  return client;
};
