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
ensureEnv('WEBHOOK_DOMAIN', 'example.com');
ensureEnv('WEBHOOK_SECRET', 'secret');

const { stateGate } = require('../src/bot/middlewares/stateGate');

test('stateGate allows clients with trial_expired status to continue', async () => {
  const replies = [];

  const ctx = {
    chat: { id: 101, type: 'private' },
    message: { text: 'Оформить доставку' },
    auth: {
      user: {
        role: 'client',
        status: 'trial_expired',
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

  assert.equal(nextCalled, true, 'Client middleware should proceed for trial_expired users');
  assert.equal(replies.length, 0, 'Client should not receive subscription warnings');
});

test('stateGate keeps restricting executors with trial_expired status', async () => {
  const replies = [];

  const ctx = {
    chat: { id: 102, type: 'private' },
    message: { text: 'Получить заказы' },
    auth: {
      user: {
        role: 'executor',
        status: 'trial_expired',
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

  assert.equal(nextCalled, false, 'Executor should still be blocked after trial expiration');
  assert.equal(replies.length, 1, 'Executor should receive a subscription reminder');
  assert.equal(
    replies[0],
    'Пробный период завершён. Продлите подписку, чтобы продолжить получать заказы.',
    'Executor should see the subscription warning',
  );
});
