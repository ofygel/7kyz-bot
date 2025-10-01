const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');

const ensureEnv = (key, value) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

ensureEnv('BOT_TOKEN', 'test-bot-token');
ensureEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
ensureEnv('KASPI_NAME', 'Test User');
ensureEnv('KASPI_PHONE', '+70000000000');
ensureEnv('SUPPORT_USERNAME', 'test_support');
ensureEnv('SUPPORT_URL', 'https://t.me/test_support');
ensureEnv('WEBHOOK_DOMAIN', 'example.com');
ensureEnv('WEBHOOK_SECRET', 'secret');

const { stateGate } = require('../src/bot/middlewares/stateGate');

test('stateGate allows clients with expired subscription status to reach renderOrdersList', async () => {
  const replies = [];

  const ctx = {
    chat: { id: 101, type: 'private' },
    message: { text: 'Оформить доставку' },
    auth: {
      user: {
        role: 'client',
        status: 'active_client',
        subscriptionStatus: 'expired',
        phoneVerified: true,
      },
    },
    session: {},
    reply: async (text) => {
      replies.push(text);
    },
  };

  const gate = stateGate();
  let nextCalled = false;
  let renderOrdersListReached = false;

  await gate(ctx, async () => {
    nextCalled = true;
    renderOrdersListReached = true;
  });

  assert.equal(nextCalled, true, 'Client middleware should proceed for users with expired subscription');
  assert.equal(
    renderOrdersListReached,
    true,
    'Client flow should reach renderOrdersList after passing through middleware',
  );
  assert.equal(replies.length, 0, 'Client should not receive subscription warnings');
});

test('stateGate keeps restricting executors with suspended status', async () => {
  const replies = [];

  const ctx = {
    chat: { id: 102, type: 'private' },
    message: { text: 'Получить заказы' },
    auth: {
      user: {
        role: 'executor',
        status: 'suspended',
        phoneVerified: true,
      },
    },
    session: {},
    reply: async (text) => {
      replies.push(text);
    },
  };

  const gate = stateGate();
  let nextCalled = false;

  await gate(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, 'Executor should be blocked while suspended');
  assert.equal(replies.length, 1, 'Executor should receive a suspension warning');
  assert.equal(
    replies[0],
    'Доступ к функциям бота ограничен. Обратитесь в поддержку.',
    'Executor should see the suspension warning',
  );
});
