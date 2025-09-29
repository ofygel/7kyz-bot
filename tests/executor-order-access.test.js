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
  ensureEnv('WEBHOOK_DOMAIN', 'example.com');
  ensureEnv('WEBHOOK_SECRET', 'secret');
}

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
