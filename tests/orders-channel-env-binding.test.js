const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');

const ensureEnv = (key, value) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

const enableTestEnv = () => {
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
};

test('publishes orders using ORDERS_CHANNEL_ID without DB bindings', async () => {
  enableTestEnv();

  const previousOrdersChannelId = process.env.ORDERS_CHANNEL_ID;
  const configuredChatId = '-1005001234567';
  process.env.ORDERS_CHANNEL_ID = configuredChatId;

  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/bot/channels/bindings')];
  delete require.cache[require.resolve('../src/bot/channels/ordersChannel')];

  const { config } = require('../src/config');
  const bindings = require('../src/bot/channels/bindings');
  bindings.__testing.clearBindingCache();

  assert.equal(config.channels.ordersChannelId, Number.parseInt(configuredChatId, 10));

  const db = require('../src/db');
  const dbClient = require('../src/db/client');
  const ordersDb = require('../src/db/orders');
  const reports = require('../src/bot/services/reports');
  const ordersChannel = require('../src/bot/channels/ordersChannel');

  const originalPoolQuery = db.pool.query;
  const originalWithTx = dbClient.withTx;
  const originalLockOrderById = ordersDb.lockOrderById;
  const originalSetOrderChannelMessageId = ordersDb.setOrderChannelMessageId;
  const originalReportOrderPublished = reports.reportOrderPublished;

  const baseOrder = {
    id: 99,
    shortId: 'D-99',
    kind: 'delivery',
    status: 'open',
    city: 'almaty',
    pickup: {
      query: 'pickup',
      address: 'Pickup street 1',
      latitude: 43.2,
      longitude: 76.8,
      twoGisUrl: 'https://example.com/pickup',
    },
    dropoff: {
      query: 'dropoff',
      address: 'Dropoff avenue 2',
      latitude: 43.3,
      longitude: 76.9,
      twoGisUrl: 'https://example.com/dropoff',
    },
    price: {
      amount: 2500,
      currency: 'KZT',
      distanceKm: 7,
      etaMinutes: 18,
    },
    clientComment: 'Leave at the door',
    channelMessageId: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
  };

  const telegram = {
    sentMessages: [],
    async sendMessage(chatId, text, options) {
      this.sentMessages.push({ chatId, text, options });
      return { message_id: 4321 };
    },
  };

  try {
    db.pool.query = async () => {
      throw new Error('channels table should not be queried when ORDERS_CHANNEL_ID is set');
    };

    dbClient.withTx = async (callback) =>
      callback({ query: async () => ({ rows: [] }) });

    ordersDb.lockOrderById = async () => ({ ...baseOrder });
    ordersDb.setOrderChannelMessageId = async () => {};
    reports.reportOrderPublished = async () => {};

    const result = await ordersChannel.publishOrderToDriversChannel(telegram, baseOrder.id);

    assert.equal(result.status, 'published');
    assert.equal(result.messageId, 4321);
    assert.equal(telegram.sentMessages.length, 1);
    assert.equal(telegram.sentMessages[0].chatId, Number.parseInt(configuredChatId, 10));
  } finally {
    db.pool.query = originalPoolQuery;
    dbClient.withTx = originalWithTx;
    ordersDb.lockOrderById = originalLockOrderById;
    ordersDb.setOrderChannelMessageId = originalSetOrderChannelMessageId;
    reports.reportOrderPublished = originalReportOrderPublished;
    bindings.__testing.clearBindingCache();

    if (previousOrdersChannelId === undefined) {
      delete process.env.ORDERS_CHANNEL_ID;
    } else {
      process.env.ORDERS_CHANNEL_ID = previousOrdersChannelId;
    }
  }
});
