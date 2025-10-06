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

const ordersChannel = require('../src/bot/channels/ordersChannel');
const ordersDb = require('../src/db/orders');
const dbClient = require('../src/db/client');
const executorAccess = require('../src/bot/services/executorAccess');
const clientMenu = require('../src/ui/clientMenu');
const reports = require('../src/bot/services/reports');
const { copy } = require('../src/bot/copy');

const createOrderBase = (overrides = {}) => ({
  id: overrides.id ?? 501,
  shortId: overrides.shortId ?? 'D-501',
  kind: overrides.kind ?? 'delivery',
  status: overrides.status ?? 'open',
  city: overrides.city ?? 'almaty',
  clientId: overrides.clientId,
  pickup: {
    query: 'pickup',
    address: overrides.pickupAddress ?? 'Pickup address',
    latitude: 43.2,
    longitude: 76.9,
  },
  dropoff: {
    query: 'dropoff',
    address: overrides.dropoffAddress ?? 'Dropoff address',
    latitude: 43.3,
    longitude: 76.95,
  },
  price: {
    amount: overrides.amount ?? 2500,
    currency: overrides.currency ?? 'KZT',
    distanceKm: overrides.distanceKm ?? 7,
    etaMinutes: overrides.etaMinutes ?? 20,
  },
  clientComment: overrides.clientComment ?? '',
});

const createOrderWithExecutor = (base, executor) => ({
  ...base,
  executor,
});

test('client receives detailed notification when order is claimed', async () => {
  ordersChannel.__testing.reset();

  const executorId = 1111;
  const clientId = 2222;
  const baseOrder = createOrderBase({ clientId });
  const claimedOrder = { ...baseOrder, status: 'claimed', claimedBy: executorId, claimedAt: new Date() };
  const orderWithExecutor = createOrderWithExecutor(claimedOrder, {
    telegramId: executorId,
    username: 'driver_one',
    firstName: 'Driver',
    lastName: 'One',
    phone: '+7 (701) 000-00-00',
  });

  const messages = [];
  const menuCalls = [];

  const originalWithTx = dbClient.withTx;
  const originalLockOrderById = ordersDb.lockOrderById;
  const originalTryClaimOrder = ordersDb.tryClaimOrder;
  const originalGetOrderWithExecutorById = ordersDb.getOrderWithExecutorById;
  const originalGetExecutorOrderAccess = executorAccess.getExecutorOrderAccess;
  const originalSendClientMenuToChat = clientMenu.sendClientMenuToChat;
  const originalReportOrderClaimed = reports.reportOrderClaimed;

  dbClient.withTx = async (callback) => callback({});
  ordersDb.lockOrderById = async () => ({ ...baseOrder });
  ordersDb.tryClaimOrder = async () => ({ ...claimedOrder });
  ordersDb.getOrderWithExecutorById = async () => ({ ...orderWithExecutor });
  executorAccess.getExecutorOrderAccess = async () => ({ hasPhone: true, isBlocked: false });
  clientMenu.sendClientMenuToChat = async (telegram, chatId, prompt) => {
    menuCalls.push({ chatId, prompt });
  };
  reports.reportOrderClaimed = async () => {};

  const ctx = {
    from: { id: executorId, first_name: 'Driver', username: 'driver_one' },
    auth: {
      user: {
        role: 'executor',
        executorKind: 'courier',
        citySelected: 'almaty',
      },
    },
    callbackQuery: {
      id: 'cbq:claim',
      data: `order:accept:${baseOrder.id}`,
      message: { message_id: 10, chat: { id: executorId, type: 'private' } },
    },
    telegram: {
      sendChatAction: async () => {},
      deleteMessage: async () => {},
      editMessageText: async () => {},
      editMessageReplyMarkup: async () => {},
      sendMessage: async (chatId, text, options = {}) => {
        messages.push({ chatId, text, options });
        return { message_id: messages.length };
      },
    },
    answerCbQuery: async () => {},
    state: {},
  };

  try {
    await ordersChannel.__testing.handleOrderDecision(ctx, baseOrder.id, 'accept');

    const clientMessage = messages.find((message) => message.chatId === clientId);
    assert(clientMessage, 'client should receive a notification');
    assert(
      clientMessage.text.includes(copy.orderClaimedClientNotice(baseOrder.shortId)),
      'client notification should include order notice',
    );
    assert(
      clientMessage.text.includes('👤 Исполнитель'),
      'client notification should include executor information',
    );

    const inlineKeyboard = clientMessage.options?.reply_markup?.inline_keyboard ?? [];
    const buttons = inlineKeyboard.flat();
    assert(
      buttons.some(
        (button) =>
          typeof button.url === 'string' &&
          (button.url.startsWith('tel:') || button.url.startsWith('tg://') || button.url.startsWith('https://t.me/')),
      ),
      'client notification should include contact buttons',
    );

    assert(
      menuCalls.some((call) => call.chatId === clientId && call.prompt === copy.orderClaimedClientMenuPrompt),
      'client menu prompt should be sent',
    );
  } finally {
    dbClient.withTx = originalWithTx;
    ordersDb.lockOrderById = originalLockOrderById;
    ordersDb.tryClaimOrder = originalTryClaimOrder;
    ordersDb.getOrderWithExecutorById = originalGetOrderWithExecutorById;
    executorAccess.getExecutorOrderAccess = originalGetExecutorOrderAccess;
    clientMenu.sendClientMenuToChat = originalSendClientMenuToChat;
    reports.reportOrderClaimed = originalReportOrderClaimed;
    ordersChannel.__testing.reset();
  }
});

test('client receives notification when order release is undone', async () => {
  ordersChannel.__testing.reset();

  const executorId = 3333;
  const clientId = 4444;
  const baseOrder = createOrderBase({ clientId, id: 777, shortId: 'D-777' });
  const reclaimedOrder = { ...baseOrder, status: 'claimed', claimedBy: executorId, claimedAt: new Date() };
  const orderWithExecutor = createOrderWithExecutor(reclaimedOrder, {
    telegramId: executorId,
    username: 'return_driver',
    firstName: 'Return',
    lastName: 'Driver',
    phone: '+7 (702) 111-22-33',
  });

  const messages = [];
  const menuCalls = [];

  const originalWithTx = dbClient.withTx;
  const originalLockOrderById = ordersDb.lockOrderById;
  const originalTryReclaimOrder = ordersDb.tryReclaimOrder;
  const originalGetOrderWithExecutorById = ordersDb.getOrderWithExecutorById;
  const originalSendClientMenuToChat = clientMenu.sendClientMenuToChat;
  const originalReportOrderClaimed = reports.reportOrderClaimed;

  dbClient.withTx = async (callback) => callback({});
  ordersDb.lockOrderById = async () => ({ ...baseOrder, status: 'open' });
  ordersDb.tryReclaimOrder = async () => ({ ...reclaimedOrder });
  ordersDb.getOrderWithExecutorById = async () => ({ ...orderWithExecutor });
  clientMenu.sendClientMenuToChat = async (telegram, chatId, prompt) => {
    menuCalls.push({ chatId, prompt });
  };
  reports.reportOrderClaimed = async () => {};

  ordersChannel.__testing.releaseUndoStates.set(baseOrder.id, {
    executorId,
    expiresAt: Date.now() + 60_000,
  });

  const ctx = {
    from: { id: executorId },
    callbackQuery: {
      id: 'cbq:undo-release',
      data: `order:undo-release:${baseOrder.id}`,
      message: { message_id: 20, chat: { id: executorId, type: 'private' } },
    },
    telegram: {
      sendChatAction: async () => {},
      sendMessage: async (chatId, text, options = {}) => {
        messages.push({ chatId, text, options });
        return { message_id: messages.length };
      },
      editMessageReplyMarkup: async () => {},
    },
    editMessageText: async () => {},
    editMessageReplyMarkup: async () => {},
    answerCbQuery: async () => {},
    state: {},
  };

  try {
    await ordersChannel.__testing.handleUndoOrderRelease(ctx, baseOrder.id);

    const clientMessage = messages.find((message) => message.chatId === clientId);
    assert(clientMessage, 'client should receive undo notification');
    assert(
      clientMessage.text.includes(copy.orderUndoReleaseClientNotice(baseOrder.shortId)),
      'undo notification should include release notice',
    );
    assert(
      clientMessage.text.includes('👤 Исполнитель'),
      'undo notification should include executor details',
    );

    const inlineKeyboard = clientMessage.options?.reply_markup?.inline_keyboard ?? [];
    const buttons = inlineKeyboard.flat();
    assert(
      buttons.some(
        (button) =>
          typeof button.url === 'string' &&
          (button.url.startsWith('tel:') || button.url.startsWith('tg://') || button.url.startsWith('https://t.me/')),
      ),
      'undo notification should include contact options',
    );

    assert(
      menuCalls.some(
        (call) => call.chatId === clientId && call.prompt === copy.orderUndoReleaseClientMenuPrompt,
      ),
      'client menu prompt should be sent after undo',
    );
  } finally {
    dbClient.withTx = originalWithTx;
    ordersDb.lockOrderById = originalLockOrderById;
    ordersDb.tryReclaimOrder = originalTryReclaimOrder;
    ordersDb.getOrderWithExecutorById = originalGetOrderWithExecutorById;
    clientMenu.sendClientMenuToChat = originalSendClientMenuToChat;
    reports.reportOrderClaimed = originalReportOrderClaimed;
    ordersChannel.__testing.reset();
  }
});
