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
const { ui } = require('../src/bot/ui');
const { taxiOrderTestables } = require('../src/bot/flows/client/taxiOrderFlow');
const { deliveryOrderTestables } = require('../src/bot/flows/client/deliveryOrderFlow');
const { __testing__: fallbackTesting } = require('../src/bot/flows/client/fallback');
const { isClientGlobalMenuIntent } = require('../src/bot/flows/client/globalIntents');

const createClientContext = (text, options = {}) => {
  const replies = [];
  const ctx = {
    chat: { id: 123, type: 'private' },
    message: { text },
    auth: {
      user: {
        role: 'client',
        status: 'active_client',
        phoneVerified: true,
        citySelected: 'almaty',
      },
    },
    session: {
      city: 'almaty',
      client: {
        taxi: {
          stage: options.taxiStage ?? 'idle',
          confirmationMessageId: options.taxiMessageId ?? 501,
        },
        delivery: {
          stage: options.deliveryStage ?? 'idle',
          confirmationMessageId: options.deliveryMessageId ?? 601,
        },
      },
      ui: { steps: {}, homeActions: [] },
      support: { status: 'idle' },
    },
    telegram: {
      sendMessage: async (_chatId, message) => {
        replies.push(message);
        return { message_id: replies.length };
      },
      editMessageReplyMarkup: async () => true,
      deleteMessage: async () => {},
    },
    reply: async (message) => {
      replies.push(message);
      return { message_id: replies.length };
    },
  };

  return { ctx, replies };
};

test('isClientGlobalMenuIntent recognises menu triggers', () => {
  const positives = [
    '/start',
    '/start payload',
    '/start@service_bot',
    'start',
    'Меню',
    '🎯 Меню',
    '🏠 Главное меню',
    'Главное меню',
    'На главную',
    'menu',
    'MENU',
  ];

  for (const value of positives) {
    assert.equal(
      isClientGlobalMenuIntent(value),
      true,
      `Expected "${value}" to be recognised as a global menu intent`,
    );
  }

  const negatives = ['привет', '/unknown', ''];
  for (const value of negatives) {
    assert.equal(
      isClientGlobalMenuIntent(value),
      false,
      `Expected "${value}" to be ignored as a global menu intent`,
    );
  }
});

test('fallback handles global menu intents even when drafts are active', () => {
  const { ctx } = createClientContext('Меню', { taxiStage: 'collectingPickup' });
  const shouldHandle = fallbackTesting.shouldHandleFallback(ctx);
  assert.equal(shouldHandle, true, 'Fallback should accept recognised menu intents while busy');
});

test('fallback still ignores unrelated messages during active drafts', () => {
  const { ctx } = createClientContext('random text', { deliveryStage: 'collectingPickup' });
  const shouldHandle = fallbackTesting.shouldHandleFallback(ctx);
  assert.equal(shouldHandle, false, 'Fallback should ignore non-intents during an active stage');
});

test('taxi flow escapes to menu for global intents in every stage', async () => {
  const stages = ['collectingPickup', 'collectingDropoff', 'awaitingConfirmation', 'creatingOrder'];

  for (const stage of stages) {
    const { ctx, replies } = createClientContext('Меню', { taxiStage: stage });
    let nextCalled = false;
    let clearCalls = 0;
    const originalClear = ui.clear;
    ui.clear = async () => {
      clearCalls += 1;
    };

    try {
      await taxiOrderTestables.handleIncomingText(ctx, async () => {
        nextCalled = true;
      });
    } finally {
      ui.clear = originalClear;
    }

    assert.equal(ctx.session.client.taxi.stage, 'idle', `Taxi stage ${stage} should reset to idle`);
    assert.equal(clearCalls, 1, `ui.clear should run once for taxi stage ${stage}`);
    assert.equal(nextCalled, false, `Taxi next handler should not run for stage ${stage}`);
    assert.equal(
      replies[0],
      CLIENT_MENU_TRIGGER,
      `Taxi stage ${stage} should trigger the reply keyboard with the menu trigger`,
    );
    assert.ok(
      replies.some((text) => text !== CLIENT_MENU_TRIGGER && /Меню клиента|Выберите, что хотите оформить/i.test(text)),
      `Taxi stage ${stage} should send a menu prompt`,
    );
  }
});

test('delivery flow escapes to menu for global intents in every stage', async () => {
  const stages = [
    'collectingPickup',
    'collectingDropoff',
    'selectingAddressType',
    'collectingApartment',
    'collectingEntrance',
    'collectingFloor',
    'collectingRecipientPhone',
    'collectingComment',
    'awaitingConfirmation',
    'creatingOrder',
  ];

  for (const stage of stages) {
    const { ctx, replies } = createClientContext('Меню', { deliveryStage: stage });
    let nextCalled = false;
    let clearCalls = 0;
    const originalClear = ui.clear;
    ui.clear = async () => {
      clearCalls += 1;
    };

    try {
      await deliveryOrderTestables.handleIncomingText(ctx, async () => {
        nextCalled = true;
      });
    } finally {
      ui.clear = originalClear;
    }

    assert.equal(ctx.session.client.delivery.stage, 'idle', `Delivery stage ${stage} should reset to idle`);
    assert.equal(clearCalls, 1, `ui.clear should run once for delivery stage ${stage}`);
    assert.equal(nextCalled, false, `Delivery next handler should not run for stage ${stage}`);
    assert.equal(
      replies[0],
      CLIENT_MENU_TRIGGER,
      `Delivery stage ${stage} should trigger the reply keyboard with the menu trigger`,
    );
    assert.ok(
      replies.some((text) => text !== CLIENT_MENU_TRIGGER && /Меню клиента|Выберите, что хотите оформить/i.test(text)),
      `Delivery stage ${stage} should send a menu prompt`,
    );
  }
});
