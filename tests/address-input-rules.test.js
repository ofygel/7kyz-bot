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

const createTaxiContext = (draft) => ({
  chat: { id: 101, type: 'private' },
  session: {
    city: 'almaty',
    client: {
      taxi: draft,
      delivery: { stage: 'idle' },
    },
  },
  auth: {
    user: {
      telegramId: 555,
      citySelected: 'almaty',
    },
  },
  telegram: {},
});

const createDeliveryContext = (draft) => ({
  chat: { id: 202, type: 'private' },
  session: {
    city: 'almaty',
    client: {
      taxi: { stage: 'idle' },
      delivery: draft,
    },
  },
  auth: {
    user: {
      telegramId: 777,
      citySelected: 'almaty',
    },
  },
  telegram: {},
});

const stubUi = (t) => {
  const { ui } = require('../src/bot/ui');
  const calls = [];
  const originalStep = ui.step;
  const originalClear = ui.clear;

  ui.step = async (_ctx, options) => {
    calls.push({ id: options.id, text: options.text });
    return { messageId: 1, sent: true };
  };
  ui.clear = async () => {};

  t.after(() => {
    ui.step = originalStep;
    ui.clear = originalClear;
  });

  return calls;
};

const stubDb = (t) => {
  const db = require('../src/db');
  const originalQuery = db.pool.query;
  db.pool.query = async () => ({ rows: [] });
  t.after(() => {
    db.pool.query = originalQuery;
  });
};

test('taxi flow rejects plain text addresses', { concurrency: false }, async (t) => {
  ensureBotEnv();

  const uiCalls = stubUi(t);
  stubDb(t);

  const geocode = require('../src/bot/services/geocode');
  const originalGeocode = geocode.geocodeOrderLocation;
  let geocodeCalls = 0;
  geocode.geocodeOrderLocation = async () => {
    geocodeCalls += 1;
    return null;
  };
  t.after(() => {
    geocode.geocodeOrderLocation = originalGeocode;
  });

  const { taxiOrderTestables } = require('../src/bot/flows/client/taxiOrderFlow');

  const draft = { stage: 'collectingPickup' };
  const ctx = createTaxiContext(draft);

  await taxiOrderTestables.applyPickupAddress(ctx, draft, 'ул. Абая, 1');

  assert.equal(draft.stage, 'collectingPickup');
  assert.equal(geocodeCalls, 0);
  assert.ok(
    uiCalls.some(
      (call) =>
        call.id === 'client:taxi:hint:manual-address' &&
        /ссылк/iu.test(call.text) &&
        /2ГИС/iu.test(call.text),
    ),
    'manual text should trigger 2GIS requirement reminder',
  );
});

test('taxi flow rejects Telegram locations', { concurrency: false }, async (t) => {
  ensureBotEnv();

  const uiCalls = stubUi(t);

  const { taxiOrderTestables } = require('../src/bot/flows/client/taxiOrderFlow');

  const draft = { stage: 'collectingPickup' };
  const ctx = createTaxiContext(draft);
  ctx.message = { location: { latitude: 43.256, longitude: 76.945 } };

  let nextCalled = false;
  await taxiOrderTestables.handleIncomingLocation(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(draft.stage, 'collectingPickup');
  assert.equal(nextCalled, false);
  assert.ok(
    uiCalls.some(
      (call) =>
        call.id === 'client:taxi:hint:manual-address' &&
        /ссылк/iu.test(call.text) &&
        /2ГИС/iu.test(call.text),
    ),
    'location input should trigger 2GIS requirement reminder',
  );
});

test('taxi flow accepts 2GIS links', { concurrency: false }, async (t) => {
  ensureBotEnv();

  const uiCalls = stubUi(t);
  stubDb(t);

  const geocode = require('../src/bot/services/geocode');
  const originalGeocode = geocode.geocodeOrderLocation;
  const location = {
    query: '2ГИС точка',
    address: 'Алматы, Абая 1',
    latitude: 43.256,
    longitude: 76.945,
    twoGisUrl: 'https://2gis.kz/almaty/geo/70000001000000000',
  };
  geocode.geocodeOrderLocation = async () => location;
  t.after(() => {
    geocode.geocodeOrderLocation = originalGeocode;
  });

  const { taxiOrderTestables } = require('../src/bot/flows/client/taxiOrderFlow');

  const draft = { stage: 'collectingPickup' };
  const ctx = createTaxiContext(draft);

  await taxiOrderTestables.applyPickupAddress(
    ctx,
    draft,
    'https://2gis.kz/almaty/geo/70000001000000000?queryState=point',
  );

  assert.equal(draft.stage, 'collectingDropoff');
  assert.deepEqual(draft.pickup, location);
  assert.ok(
    uiCalls.some((call) => call.id === 'client:taxi:step' && /Теперь отправьте пункт назначения/iu.test(call.text)),
    'successful pickup should request dropoff point',
  );
});

test('delivery flow rejects plain text addresses', { concurrency: false }, async (t) => {
  ensureBotEnv();

  const uiCalls = stubUi(t);
  stubDb(t);

  const geocode = require('../src/bot/services/geocode');
  const originalGeocode = geocode.geocodeOrderLocation;
  let geocodeCalls = 0;
  geocode.geocodeOrderLocation = async () => {
    geocodeCalls += 1;
    return null;
  };
  t.after(() => {
    geocode.geocodeOrderLocation = originalGeocode;
  });

  const { deliveryOrderTestables } = require('../src/bot/flows/client/deliveryOrderFlow');

  const draft = { stage: 'collectingPickup' };
  const ctx = createDeliveryContext(draft);

  await deliveryOrderTestables.applyPickupAddress(ctx, draft, 'проспект Достык, 1');

  assert.equal(draft.stage, 'collectingPickup');
  assert.equal(geocodeCalls, 0);
  assert.ok(
    uiCalls.some(
      (call) =>
        call.id === 'client:delivery:hint:manual-address' &&
        /ссылк/iu.test(call.text) &&
        /2ГИС/iu.test(call.text),
    ),
    'manual text should trigger 2GIS requirement reminder',
  );
});

test('delivery flow rejects Telegram locations', { concurrency: false }, async (t) => {
  ensureBotEnv();

  const uiCalls = stubUi(t);

  const { deliveryOrderTestables } = require('../src/bot/flows/client/deliveryOrderFlow');

  const draft = { stage: 'collectingPickup' };
  const ctx = createDeliveryContext(draft);
  ctx.message = { location: { latitude: 43.256, longitude: 76.945 } };

  let nextCalled = false;
  await deliveryOrderTestables.handleIncomingLocation(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(draft.stage, 'collectingPickup');
  assert.equal(nextCalled, false);
  assert.ok(
    uiCalls.some(
      (call) =>
        call.id === 'client:delivery:hint:manual-address' &&
        /ссылк/iu.test(call.text) &&
        /2ГИС/iu.test(call.text),
    ),
    'location input should trigger 2GIS requirement reminder',
  );
});

test('delivery flow accepts 2GIS links', { concurrency: false }, async (t) => {
  ensureBotEnv();

  const uiCalls = stubUi(t);
  stubDb(t);

  const geocode = require('../src/bot/services/geocode');
  const originalGeocode = geocode.geocodeOrderLocation;
  const location = {
    query: '2ГИС склад',
    address: 'Алматы, Назарбаева 10',
    latitude: 43.25,
    longitude: 76.92,
    twoGisUrl: 'https://2gis.kz/almaty/firm/70000001000000001',
  };
  geocode.geocodeOrderLocation = async () => location;
  t.after(() => {
    geocode.geocodeOrderLocation = originalGeocode;
  });

  const { deliveryOrderTestables } = require('../src/bot/flows/client/deliveryOrderFlow');

  const draft = { stage: 'collectingPickup' };
  const ctx = createDeliveryContext(draft);

  await deliveryOrderTestables.applyPickupAddress(
    ctx,
    draft,
    'https://2gis.kz/almaty/firm/70000001000000001?queryState=firm',
  );

  assert.equal(draft.stage, 'collectingDropoff');
  assert.deepEqual(draft.pickup, location);
  assert.ok(
    uiCalls.some((call) => call.id === 'client:delivery:step' && /Адрес доставки/iu.test(call.text)),
    'successful pickup should request dropoff address details',
  );
});
