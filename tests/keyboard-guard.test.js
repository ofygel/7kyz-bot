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
ensureEnv('HMAC_SECRET', 'secret');
ensureEnv('REDIS_URL', 'redis://localhost:6379');

const { CLIENT_MENU_TRIGGER } = require('../src/ui/clientMenu');
const { keyboardGuard } = require('../src/bot/middlewares/keyboardGuard');

test('keyboardGuard allows clients to reach the menu trigger', async () => {

  const replies = [];

  const ctx = {
    chat: { id: 42, type: 'private' },
    message: { text: CLIENT_MENU_TRIGGER },
    auth: {
      user: {
        role: 'client',
        status: 'active_client',
        phoneVerified: true,
      },
    },
    session: {},
    reply: async (text) => {
      replies.push(text);
    },
  };

  const guard = keyboardGuard();
  let nextCalled = false;

  await guard(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true, 'Client menu trigger should reach the next middleware');
  assert.equal(replies.length, 0, 'Guard should not send additional replies for clients');
});

test('keyboardGuard blocks executors from client support menu', async () => {
  const replies = [];

  const ctx = {
    chat: { id: 43, type: 'private' },
    message: { text: CLIENT_MENU_TRIGGER },
    auth: {
      user: {
        role: 'executor',
        status: 'active_executor',
        phoneVerified: true,
      },
    },
    session: {},
    reply: async (text) => {
      replies.push(text);
    },
  };

  const guard = keyboardGuard();
  let nextCalled = false;

  await guard(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, 'Executor should not reach support handler');
  assert.equal(replies.length, 1, 'Executor should receive a warning message');
  assert.equal(
    replies[0],
    'Вы сейчас в режиме исполнителя. Используйте меню исполнителя ниже.',
    'Executor should be prompted to use the executor menu',
  );
});
