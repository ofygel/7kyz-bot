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

test('client orders action sends processing feedback', async () => {
  ensureBotEnv();

  const feedbackModulePath = require.resolve('../src/bot/services/feedback');
  const ordersModulePath = require.resolve('../src/bot/flows/client/orders');
  const dbOrdersModulePath = require.resolve('../src/db/orders');
  const uiModulePath = require.resolve('../src/bot/ui');
  const clientMenuModulePath = require.resolve('../src/bot/flows/client/menu');

  delete require.cache[ordersModulePath];

  const feedbackModule = require(feedbackModulePath);
  const originalSendProcessingFeedback = feedbackModule.sendProcessingFeedback;
  let feedbackCalls = 0;
  feedbackModule.sendProcessingFeedback = async () => {
    feedbackCalls += 1;
  };

  const dbOrdersModule = require(dbOrdersModulePath);
  const originalListClientOrders = dbOrdersModule.listClientOrders;
  dbOrdersModule.listClientOrders = async () => [];

  const uiModule = require(uiModulePath);
  const originalUiStep = uiModule.ui.step;
  uiModule.ui.step = async () => {};

  const clientMenuModule = require(clientMenuModulePath);
  const originalLogClientMenuClick = clientMenuModule.logClientMenuClick;
  clientMenuModule.logClientMenuClick = async () => {};

  try {
    const { registerClientOrdersFlow } = require(ordersModulePath);

    const actions = new Map();
    const bot = {
      action(trigger, handler) {
        actions.set(trigger, handler);
      },
      command() {},
    };

    registerClientOrdersFlow(bot);

    const handler = actions.get('client:orders:list');
    assert.ok(handler, 'orders action handler should be registered');

    const ctx = {
      auth: { user: { telegramId: 123 } },
      chat: { id: 456, type: 'private' },
      callbackQuery: {
        id: 'cbq:orders',
        chat_instance: 'instance',
        from: { id: 123 },
        message: { message_id: 10, chat: { id: 456, type: 'private' } },
        data: 'client:orders:list',
      },
      answerCbQuery: async () => {},
      telegram: {
        sendChatAction: async () => {},
      },
    };

    await handler(ctx);

    assert.equal(feedbackCalls, 1, 'processing feedback should be sent');
  } finally {
    feedbackModule.sendProcessingFeedback = originalSendProcessingFeedback;
    dbOrdersModule.listClientOrders = originalListClientOrders;
    uiModule.ui.step = originalUiStep;
    clientMenuModule.logClientMenuClick = originalLogClientMenuClick;
    delete require.cache[ordersModulePath];
  }
});

