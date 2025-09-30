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
  ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
  ensureEnv('KASPI_NAME', 'Test User');
  ensureEnv('KASPI_PHONE', '+70000000000');
  ensureEnv('SUPPORT_USERNAME', 'test_support');
  ensureEnv('SUPPORT_URL', 'https://t.me/test_support');
  ensureEnv('WEBHOOK_DOMAIN', 'example.com');
  ensureEnv('WEBHOOK_SECRET', 'secret');
}

const createMockRedis = () => {
  const strings = new Map();
  const lists = new Map();
  const setCalls = [];

  const getList = (key) => lists.get(key) ?? [];

  const ensureList = (key) => {
    if (!lists.has(key)) {
      lists.set(key, []);
    }
    return lists.get(key);
  };

  return {
    setCalls,
    getList,
    async get(key) {
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
    async rpush(key, value) {
      const list = ensureList(key);
      list.push(value);
      return list.length;
    },
    async lpush(key, value) {
      const list = ensureList(key);
      list.unshift(value);
      return list.length;
    },
    async lpop(key) {
      const list = ensureList(key);
      if (list.length === 0) {
        return null;
      }
      const value = list.shift();
      return value ?? null;
    },
  };
};

const loadPhoneCollect = () => {
  delete require.cache[require.resolve('../src/bot/flows/common/phoneCollect')];
  return require('../src/bot/flows/common/phoneCollect');
};

const queueModule = require('../src/infra/userPhoneQueue');
const redisModule = require('../src/infra/redis');
const phoneVerificationModule = require('../src/db/phoneVerification');
const executorAccessModule = require('../src/bot/services/executorAccess');
const reportsModule = require('../src/bot/services/reports');
const config = require('../src/config').config;

const queueKey = `${config.session.redis?.keyPrefix ?? 'session:'}user-phone-updates`;

test('savePhone persists contact immediately when database is available', { concurrency: 1 }, async (t) => {
  const mockRedis = createMockRedis();
  const originalGetRedisClient = redisModule.getRedisClient;
  redisModule.getRedisClient = () => mockRedis;

  const calls = [];
  const originalPersist = phoneVerificationModule.persistPhoneVerification;
  phoneVerificationModule.persistPhoneVerification = async (payload) => {
    calls.push(payload);
  };

  const cacheCalls = [];
  const originalPrime = executorAccessModule.primeExecutorOrderAccessCache;
  executorAccessModule.primeExecutorOrderAccessCache = async (executorId, record, options) => {
    cacheCalls.push({ executorId, record, options });
    await originalPrime(executorId, record, options);
  };

  let registrations = 0;
  let verifications = 0;
  const originalReportRegistration = reportsModule.reportUserRegistration;
  const originalReportPhone = reportsModule.reportPhoneVerified;
  reportsModule.reportUserRegistration = async () => {
    registrations += 1;
  };
  reportsModule.reportPhoneVerified = async () => {
    verifications += 1;
  };

  const { savePhone } = loadPhoneCollect();

  const ctx = {
    chat: { type: 'private' },
    from: { id: 123 },
    message: { contact: { phone_number: '8 (701) 000-00-00', user_id: 123 } },
    session: { awaitingPhone: true, ephemeralMessages: [], user: { id: 123, phoneVerified: false } },
    auth: { user: { telegramId: 123, phoneVerified: false, status: 'awaiting_phone', isBlocked: false } },
    state: {},
  };

  try {
    await savePhone(ctx, async () => {});

    assert.equal(calls.length, 1, 'should persist phone once');
    assert.deepEqual(calls[0], { telegramId: 123, phone: '+87010000000' });
    assert.equal(ctx.session.awaitingPhone, false);
    assert.equal(ctx.session.phoneNumber, '+87010000000');
    assert.equal(ctx.session.user.phoneVerified, true);
    assert.equal(ctx.auth.user.phone, '+87010000000');
    assert.equal(ctx.auth.user.phoneVerified, true);
    assert.equal(ctx.auth.user.status, 'onboarding');
    assert.equal(ctx.state.phoneJustVerified, true);
    assert.equal(registrations, 1);
    assert.equal(verifications, 1);
    assert.equal(mockRedis.getList(queueKey).length, 0, 'queue should stay empty');
    assert.equal(cacheCalls.length, 1, 'cache primed once');
    assert.equal(cacheCalls[0].executorId, 123);
    assert.deepEqual(cacheCalls[0].record, { hasPhone: true, isBlocked: false });
    assert.equal(cacheCalls[0].options.ttlSeconds, 3600);
    assert.equal(mockRedis.setCalls.length, 1, 'cache write recorded');
    assert.equal(mockRedis.setCalls[0].ttl, 3600);
  } finally {
    redisModule.getRedisClient = originalGetRedisClient;
    phoneVerificationModule.persistPhoneVerification = originalPersist;
    executorAccessModule.primeExecutorOrderAccessCache = originalPrime;
    reportsModule.reportUserRegistration = originalReportRegistration;
    reportsModule.reportPhoneVerified = originalReportPhone;
  }
});

test('savePhone enqueues update when database is unavailable and flush later succeeds', { concurrency: 1 }, async (t) => {
  const mockRedis = createMockRedis();
  const originalGetRedisClient = redisModule.getRedisClient;
  redisModule.getRedisClient = () => mockRedis;

  let shouldFail = true;
  const calls = [];
  const originalPersist = phoneVerificationModule.persistPhoneVerification;
  phoneVerificationModule.persistPhoneVerification = async (payload) => {
    calls.push(payload);
    if (shouldFail) {
      throw new Error('temporary failure');
    }
  };

  const cacheCalls = [];
  const originalPrime = executorAccessModule.primeExecutorOrderAccessCache;
  executorAccessModule.primeExecutorOrderAccessCache = async (executorId, record, options) => {
    cacheCalls.push({ executorId, record, options });
    await originalPrime(executorId, record, options);
  };

  let registrations = 0;
  let verifications = 0;
  const originalReportRegistration = reportsModule.reportUserRegistration;
  const originalReportPhone = reportsModule.reportPhoneVerified;
  reportsModule.reportUserRegistration = async () => {
    registrations += 1;
  };
  reportsModule.reportPhoneVerified = async () => {
    verifications += 1;
  };

  const { savePhone } = loadPhoneCollect();

  const ctx = {
    chat: { type: 'private' },
    from: { id: 456 },
    message: { contact: { phone_number: '+7 701 111-22-33', user_id: 456 } },
    session: { awaitingPhone: true, ephemeralMessages: [], user: { id: 456, phoneVerified: false } },
    auth: { user: { telegramId: 456, phoneVerified: false, status: 'guest', isBlocked: true } },
    state: {},
  };

  try {
    await savePhone(ctx, async () => {});

    assert.equal(calls.length, 1, 'initial persistence attempted once');
    assert.equal(mockRedis.getList(queueKey).length, 1, 'queued update should be stored');
    assert.equal(ctx.session.awaitingPhone, false);
    assert.equal(ctx.session.phoneNumber, '+7 701 111-22-33');
    assert.equal(ctx.session.user.phoneVerified, true);
    assert.equal(ctx.auth.user.phone, '+7 701 111-22-33');
    assert.equal(ctx.auth.user.phoneVerified, true);
    assert.equal(ctx.auth.user.status, 'onboarding');
    assert.equal(ctx.state.phoneJustVerified, true);
    assert.equal(registrations, 1);
    assert.equal(verifications, 1);
    assert.equal(cacheCalls.length, 1);
    assert.deepEqual(cacheCalls[0].record, { hasPhone: true, isBlocked: true });

    shouldFail = false;
    await queueModule.flushUserPhoneUpdates();

    assert.equal(calls.length, 2, 'queued update retried once');
    assert.equal(mockRedis.getList(queueKey).length, 0, 'queue should be empty after flush');
  } finally {
    redisModule.getRedisClient = originalGetRedisClient;
    phoneVerificationModule.persistPhoneVerification = originalPersist;
    executorAccessModule.primeExecutorOrderAccessCache = originalPrime;
    reportsModule.reportUserRegistration = originalReportRegistration;
    reportsModule.reportPhoneVerified = originalReportPhone;
  }
});
