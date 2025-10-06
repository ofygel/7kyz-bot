const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');

const ensureEnv = (key, value) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

const ensureBotEnv = () => {
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
};

test('renderOrdersList falls back when UI rendering fails', async () => {
  ensureBotEnv();

  const { copy } = require('../src/bot/copy');
  const uiModulePath = require.resolve('../src/bot/ui');
  const ordersModulePath = require.resolve('../src/bot/flows/client/orders');

  delete require.cache[ordersModulePath];

  const uiModule = require(uiModulePath);
  const originalUiStep = uiModule.ui.step;
  const originalUiClear = uiModule.ui.clear;
  uiModule.ui.step = async () => {
    throw new Error('ui-step-failure');
  };
  uiModule.ui.clear = async () => {};

  try {
    const { renderOrdersList } = require(ordersModulePath);

    const replies = [];
    const ctx = {
      auth: { user: { telegramId: 123 } },
      chat: { id: 456, type: 'private' },
      reply: async (text) => {
        replies.push(text);
      },
      telegram: {
        deleteMessage: async () => {},
      },
      session: {},
    };

    const result = await renderOrdersList(ctx, []);
    assert.equal(result, null, 'renderOrdersList should return null when rendering fails');
    assert.equal(replies.length, 1, 'fallback reply should be sent');
    assert.equal(replies[0], copy.serviceUnavailable, 'fallback reply should inform about service unavailability');
  } finally {
    uiModule.ui.step = originalUiStep;
    uiModule.ui.clear = originalUiClear;
    delete require.cache[ordersModulePath];
  }
});
