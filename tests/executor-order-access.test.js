const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');

const ensureEnv = (key, value) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

enableTestEnv();

function enableTestEnv() {
  ensureEnv('BOT_TOKEN', 'test-bot-token');
  ensureEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
  ensureEnv('HMAC_SECRET', 'secret');
  ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
  ensureEnv('KASPI_NAME', 'Test User');
  ensureEnv('KASPI_PHONE', '+70000000000');
  ensureEnv('SUPPORT_USERNAME', 'test_support');
  ensureEnv('SUPPORT_URL', 'https://t.me/test_support');
  ensureEnv('WEBHOOK_DOMAIN', 'example.com');
  ensureEnv('WEBHOOK_SECRET', 'secret');
  ensureEnv('EXECUTOR_ACCESS_CACHE_TTL_SECONDS', '21600');
}

const { config, loadConfig } = require('../src/config');

const createMockRedis = () => {
  const strings = new Map();
  const setCalls = [];
  const getCalls = [];

  return {
    setCalls,
    getCalls,
    async get(key) {
      getCalls.push(key);
      return strings.has(key) ? strings.get(key) : null;
    },
    async set(key, value, mode, ttl) {
      if (mode && mode !== 'EX') {
        throw new Error(`Unsupported set mode: ${mode}`);
      }
      if (mode === 'EX' && typeof ttl !== 'number') {
        throw new Error('TTL must be provided when using EX');
      }

      strings.set(key, value);
      setCalls.push({ key, value, mode, ttl });
    },
    async del(key) {
      const existed = strings.delete(key);
      return existed ? 1 : 0;
    },
  };
};

const createMockContext = ({
  telegramId = 12345,
  phone = '+77010000000',
  phoneVerified = true,
  isBlocked = false,
  status = 'active_executor',
  executorKind = 'courier',
} = {}) => {
  const replies = [];
  return {
    chat: { type: 'private' },
    from: { id: telegramId },
    replyMessages: replies,
    reply: async (text) => {
      replies.push(text);
    },
    auth: {
      user: {
        telegramId,
        phone,
        phoneVerified,
        role: 'executor',
        executorKind,
        status,
        verifyStatus: 'none',
        subscriptionStatus: 'none',
        isVerified: false,
        isBlocked,
        hasActiveOrder: false,
      },
      executor: {
        hasActiveSubscription: false,
        isVerified: false,
        verifiedRoles: { courier: false, driver: false },
      },
    },
    session: {},
  };
};

test('ensureExecutorReady allows executors with phone regardless of verification or subscription', async () => {
  delete require.cache[require.resolve('../src/bot/flows/executor/jobs')];
  const { ensureExecutorReady } = require('../src/bot/flows/executor/jobs');

  const ctx = createMockContext();
  const result = await ensureExecutorReady(ctx, {});

  assert.equal(result, true);
  assert.equal(ctx.replyMessages.length, 0);
});

test('attemptClaimOrder succeeds for executor with phone without verification or subscription', async () => {
  const dbClient = require('../src/db/client');
  const ordersDb = require('../src/db/orders');

  const originalWithTx = dbClient.withTx;
  const originalLockOrderById = ordersDb.lockOrderById;
  const originalTryClaimOrder = ordersDb.tryClaimOrder;

  const baseOrder = {
    id: 77,
    shortId: 'T-77',
    kind: 'delivery',
    status: 'open',
    city: 'almaty',
    pickup: {
      query: 'pickup',
      address: 'Pickup address',
      latitude: 43.2,
      longitude: 76.8,
      twoGisUrl: 'https://example.com/pickup',
    },
    dropoff: {
      query: 'dropoff',
      address: 'Dropoff address',
      latitude: 43.3,
      longitude: 76.9,
      twoGisUrl: 'https://example.com/dropoff',
    },
    price: {
      amount: 1500,
      currency: 'KZT',
      distanceKm: 5,
      etaMinutes: 15,
    },
    createdAt: new Date('2024-01-01T00:00:00Z'),
  };

  try {
    dbClient.withTx = async (callback) => callback({ query: async () => ({ rows: [] }) });
    ordersDb.lockOrderById = async () => ({ ...baseOrder });
    ordersDb.tryClaimOrder = async () => ({
      ...baseOrder,
      status: 'claimed',
      claimedBy: 12345,
      claimedAt: new Date(),
    });

    delete require.cache[require.resolve('../src/bot/flows/executor/jobs')];
    const { attemptClaimOrder } = require('../src/bot/flows/executor/jobs');

    const ctx = createMockContext();
    const state = { role: 'courier' };

    const result = await attemptClaimOrder(ctx, state, 'almaty', baseOrder.id);

    assert.equal(result.status, 'claimed');
    assert.equal(ctx.auth.executor.hasActiveSubscription, false);
  } finally {
    dbClient.withTx = originalWithTx;
    ordersDb.lockOrderById = originalLockOrderById;
    ordersDb.tryClaimOrder = originalTryClaimOrder;
    delete require.cache[require.resolve('../src/bot/flows/executor/jobs')];
  }
});

test('processOrderAction falls back to cached executor access when database is unavailable', async () => {
  const redisModule = require('../src/infra/redis');
  const executorAccessModule = require('../src/bot/services/executorAccess');
  const dbClient = require('../src/db/client');
  const ordersDb = require('../src/db/orders');

  const ordersChannel = require('../src/bot/channels/ordersChannel');
  const { processOrderAction } = ordersChannel.__testing;

  const mockRedis = createMockRedis();
  const originalGetRedisClient = redisModule.getRedisClient;
  redisModule.getRedisClient = () => mockRedis;

  const executorId = 98765;
  const mainCacheKey = `executor-access:${executorId}`;
  const backupCacheKey = `executor-access:backup:${executorId}`;

  const originalPoolQuery = dbClient.pool.query;
  const originalWithTx = dbClient.withTx;
  const originalLockOrderById = ordersDb.lockOrderById;
  const originalTryClaimOrder = ordersDb.tryClaimOrder;

  let queryCalls = 0;

  try {
    await executorAccessModule.primeExecutorOrderAccessCache(executorId, {
      phone: '+77015550000',
      isBlocked: false,
    });

    await mockRedis.del(mainCacheKey);

    dbClient.pool.query = async () => {
      queryCalls += 1;
      throw new Error('database unavailable');
    };

    const baseOrder = {
      id: 321,
      shortId: 'D-321',
      kind: 'delivery',
      status: 'open',
      city: 'almaty',
      pickup: {
        address: 'Pickup',
        latitude: 43.2,
        longitude: 76.9,
      },
      dropoff: {
        address: 'Dropoff',
        latitude: 43.3,
        longitude: 76.95,
      },
      price: {
        amount: 2500,
        currency: 'KZT',
        distanceKm: 7,
        etaMinutes: 20,
      },
    };

    dbClient.withTx = async (callback) => callback({});

    ordersDb.lockOrderById = async () => ({ ...baseOrder });

    ordersDb.tryClaimOrder = async () => ({
      ...baseOrder,
      status: 'claimed',
      claimedBy: executorId,
      claimedAt: new Date(),
    });

    const outcome = await processOrderAction(321, 'accept', {
      id: executorId,
      role: 'executor',
      executorKind: 'courier',
      city: 'almaty',
    });

    assert.equal(outcome.outcome, 'claimed');
    assert(mockRedis.getCalls.includes(backupCacheKey), 'backup cache should be consulted');
    assert.equal(queryCalls, 1, 'database should be queried once before falling back');
  } finally {
    redisModule.getRedisClient = originalGetRedisClient;
    dbClient.pool.query = originalPoolQuery;
    dbClient.withTx = originalWithTx;
    ordersDb.lockOrderById = originalLockOrderById;
    ordersDb.tryClaimOrder = originalTryClaimOrder;
  }
});

test('refreshExecutorOrderAccessCacheForPlan immediately toggles executor access state', async () => {
  const redisModule = require('../src/infra/redis');
  const accessCacheModule = require('../src/services/executorPlans/accessCache');
  const executorAccessModule = require('../src/bot/services/executorAccess');
  const dbClient = require('../src/db/client');

  const mockRedis = createMockRedis();
  const originalGetRedisClient = redisModule.getRedisClient;
  redisModule.getRedisClient = () => mockRedis;

  const originalPoolQuery = dbClient.pool.query;

  const executorId = 112233;
  const phone = '+77019998877';
  const mainCacheKey = `executor-access:${executorId}`;

  let dbCalls = 0;

  try {
    dbClient.pool.query = async () => {
      dbCalls += 1;
      return { rows: [{ phone, is_blocked: false }] };
    };

    await accessCacheModule.refreshExecutorOrderAccessCacheForPlan({
      id: 900,
      chatId: executorId,
      phone,
      status: 'active',
    });

    let hasAccess = await executorAccessModule.hasExecutorOrderAccess(executorId);
    assert.equal(hasAccess, true);

    await accessCacheModule.refreshExecutorOrderAccessCacheForPlan({
      id: 900,
      chatId: executorId,
      phone,
      status: 'blocked',
    });

    const blockedSnapshot = await mockRedis.get(mainCacheKey);
    assert(blockedSnapshot, 'cache should be available after blocking');
    assert.equal(JSON.parse(blockedSnapshot).isBlocked, true);

    hasAccess = await executorAccessModule.hasExecutorOrderAccess(executorId);
    assert.equal(hasAccess, false);

    await accessCacheModule.refreshExecutorOrderAccessCacheForPlan({
      id: 900,
      chatId: executorId,
      phone,
      status: 'active',
    });

    const activeSnapshot = await mockRedis.get(mainCacheKey);
    assert(activeSnapshot, 'cache should be updated after unblocking');
    assert.equal(JSON.parse(activeSnapshot).isBlocked, false);

    hasAccess = await executorAccessModule.hasExecutorOrderAccess(executorId);
    assert.equal(hasAccess, true);

    const mainSetCalls = mockRedis.setCalls.filter((call) => call.key === mainCacheKey);
    assert(mainSetCalls.length >= 1, 'main cache should be written at least once');
    assert.equal(
      mainSetCalls[mainSetCalls.length - 1].ttl,
      config.bot.executorAccessCacheTtlSeconds,
    );

    assert.equal(dbCalls, 0, 'database should not be queried when cache is refreshed');
  } finally {
    redisModule.getRedisClient = originalGetRedisClient;
    dbClient.pool.query = originalPoolQuery;
  }
});

test('executor access cache TTL can be overridden via configuration', async () => {
  const previous = process.env.EXECUTOR_ACCESS_CACHE_TTL_SECONDS;

  try {
    process.env.EXECUTOR_ACCESS_CACHE_TTL_SECONDS = '7200';
    const customConfig = loadConfig();
    assert.equal(customConfig.bot.executorAccessCacheTtlSeconds, 7200);
  } finally {
    if (previous === undefined) {
      delete process.env.EXECUTOR_ACCESS_CACHE_TTL_SECONDS;
    } else {
      process.env.EXECUTOR_ACCESS_CACHE_TTL_SECONDS = previous;
    }
  }
});

test('hasExecutorOrderAccess uses cached snapshot without hitting database for extended TTL', async () => {
  const redisModule = require('../src/infra/redis');
  const executorAccessModule = require('../src/bot/services/executorAccess');
  const dbClient = require('../src/db/client');

  const mockRedis = createMockRedis();
  const originalGetRedisClient = redisModule.getRedisClient;
  redisModule.getRedisClient = () => mockRedis;

  const executorId = 554433;
  const mainCacheKey = `executor-access:${executorId}`;

  const originalPoolQuery = dbClient.pool.query;
  let queryCalls = 0;

  try {
    await executorAccessModule.primeExecutorOrderAccessCache(executorId, {
      phone: '+77012223344',
      isBlocked: false,
    });

    dbClient.pool.query = async () => {
      queryCalls += 1;
      throw new Error('database should not be queried when cache is warm');
    };

    const hasAccess = await executorAccessModule.hasExecutorOrderAccess(executorId);
    assert.equal(hasAccess, true);

    assert.equal(queryCalls, 0, 'database should not be queried while cache entry is valid');

    const primaryCall = mockRedis.setCalls.find(
      (call) => call.key === mainCacheKey && call.mode === 'EX',
    );
    assert(primaryCall, 'primary cache should persist executor access');
    assert.equal(primaryCall.ttl, config.bot.executorAccessCacheTtlSeconds);
  } finally {
    redisModule.getRedisClient = originalGetRedisClient;
    dbClient.pool.query = originalPoolQuery;
  }
});
