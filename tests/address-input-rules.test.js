const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');

const { extractPreferredUrl } = require('../src/lib/extractPreferredUrl');

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
    'Оспанова улица\nhttps://2gis.kz/almaty/geo/70000001000000000?queryState=point',
  );

  assert.equal(draft.stage, 'collectingDropoff');
  assert.deepEqual(draft.pickup, location);
  assert.ok(
    uiCalls.some((call) => call.id === 'client:taxi:step' && /Теперь отправьте пункт назначения/iu.test(call.text)),
    'successful pickup should request dropoff point',
  );
});

test('taxi flow rejects 2GIS links from another city', { concurrency: false }, async (t) => {
  ensureBotEnv();

  const uiCalls = stubUi(t);
  stubDb(t);

  const geocode = require('../src/bot/services/geocode');
  const originalGeocode = geocode.geocodeOrderLocation;
  geocode.geocodeOrderLocation = async () => ({
    query: '2ГИС точка',
    address: 'Астана, Абая 1',
    latitude: 51.128,
    longitude: 71.43,
    twoGisUrl: 'https://2gis.kz/astana/geo/70000001000000002',
  });
  t.after(() => {
    geocode.geocodeOrderLocation = originalGeocode;
  });

  const { taxiOrderTestables } = require('../src/bot/flows/client/taxiOrderFlow');

  const draft = { stage: 'collectingPickup' };
  const ctx = createTaxiContext(draft);

  await taxiOrderTestables.applyPickupAddress(
    ctx,
    draft,
    'Астана\nhttps://2gis.kz/astana/geo/70000001000000002',
  );

  assert.equal(draft.stage, 'collectingPickup');
  assert.ok(
    uiCalls.some(
      (call) =>
        call.id === 'client:taxi:error:city-mismatch' && /Алматы/iu.test(call.text) && /Адрес подачи/iu.test(call.text),
    ),
    'address from another city should trigger mismatch warning',
  );
});

test('taxi flow rejects dropoff from another city', { concurrency: false }, async (t) => {
  ensureBotEnv();

  const uiCalls = stubUi(t);
  stubDb(t);

  const geocode = require('../src/bot/services/geocode');
  const originalGeocode = geocode.geocodeOrderLocation;
  geocode.geocodeOrderLocation = async () => ({
    query: '2ГИС точка',
    address: 'Астана, Абая 1',
    latitude: 51.128,
    longitude: 71.43,
    twoGisUrl: 'https://2gis.kz/astana/geo/70000001000000005',
  });
  t.after(() => {
    geocode.geocodeOrderLocation = originalGeocode;
  });

  const { taxiOrderTestables } = require('../src/bot/flows/client/taxiOrderFlow');

  const draft = {
    stage: 'collectingDropoff',
    pickup: {
      query: 'pickup',
      address: 'Алматы, Абая 1',
      latitude: 43.256,
      longitude: 76.945,
      twoGisUrl: 'https://2gis.kz/almaty/geo/70000001000000000',
    },
  };
  const ctx = createTaxiContext(draft);

  await taxiOrderTestables.applyDropoffAddress(
    ctx,
    draft,
    'Астана\nhttps://2gis.kz/astana/geo/70000001000000005',
  );

  assert.equal(draft.stage, 'collectingDropoff');
  assert.equal(draft.dropoff, undefined);
  assert.ok(
    uiCalls.some(
      (call) =>
        call.id === 'client:taxi:error:city-mismatch' &&
        /Алматы/iu.test(call.text) &&
        /Адрес назначения/iu.test(call.text),
    ),
    'dropoff from another city should trigger mismatch warning',
  );
});

test('taxi flow warns when dropoff distance is unrealistic', { concurrency: false }, async (t) => {
  ensureBotEnv();

  const uiCalls = stubUi(t);
  stubDb(t);

  const geocode = require('../src/bot/services/geocode');
  const originalGeocode = geocode.geocodeOrderLocation;
  geocode.geocodeOrderLocation = async () => ({
    query: 'Очень далёкая точка',
    address: 'Москва, Красная площадь',
    latitude: 55.752,
    longitude: 37.617,
    twoGisUrl: 'https://2gis.kz/almaty/geo/70000001000000006',
  });
  t.after(() => {
    geocode.geocodeOrderLocation = originalGeocode;
  });

  const { taxiOrderTestables } = require('../src/bot/flows/client/taxiOrderFlow');

  const draft = {
    stage: 'collectingDropoff',
    pickup: {
      query: 'pickup',
      address: 'Алматы, Абая 1',
      latitude: 43.256,
      longitude: 76.945,
      twoGisUrl: 'https://2gis.kz/almaty/geo/70000001000000000',
    },
  };
  const ctx = createTaxiContext(draft);

  await taxiOrderTestables.applyDropoffAddress(
    ctx,
    draft,
    'Москва\nhttps://2gis.kz/almaty/geo/70000001000000006/37.617,55.752',
  );

  assert.equal(draft.stage, 'collectingDropoff');
  assert.equal(draft.dropoff, undefined);
  assert.equal(draft.price, undefined);
  assert.ok(
    uiCalls.some(
      (call) =>
        call.id === 'client:taxi:error:distance' && /расстояние/iu.test(call.text) && /некорректно/iu.test(call.text),
    ),
    'unrealistic distance should trigger warning',
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
    'Склад на Абая\nhttps://2gis.kz/almaty/firm/70000001000000001?queryState=firm',
  );

  assert.equal(draft.stage, 'collectingDropoff');
  assert.deepEqual(draft.pickup, location);
  assert.ok(
    uiCalls.some((call) => call.id === 'client:delivery:step' && /Адрес доставки/iu.test(call.text)),
    'successful pickup should request dropoff address details',
  );
});

test('delivery flow rejects 2GIS links from another city', { concurrency: false }, async (t) => {
  ensureBotEnv();

  const uiCalls = stubUi(t);
  stubDb(t);

  const geocode = require('../src/bot/services/geocode');
  const originalGeocode = geocode.geocodeOrderLocation;
  geocode.geocodeOrderLocation = async () => ({
    query: '2ГИС склад',
    address: 'Астана, Назарбаева 10',
    latitude: 51.15,
    longitude: 71.47,
    twoGisUrl: 'https://2gis.kz/astana/firm/70000001000000003',
  });
  t.after(() => {
    geocode.geocodeOrderLocation = originalGeocode;
  });

  const { deliveryOrderTestables } = require('../src/bot/flows/client/deliveryOrderFlow');

  const draft = { stage: 'collectingPickup' };
  const ctx = createDeliveryContext(draft);

  await deliveryOrderTestables.applyPickupAddress(
    ctx,
    draft,
    'Астана\nhttps://2gis.kz/astana/firm/70000001000000003',
  );

  assert.equal(draft.stage, 'collectingPickup');
  assert.ok(
    uiCalls.some(
      (call) =>
        call.id === 'client:delivery:error:city-mismatch' &&
        /Алматы/iu.test(call.text) &&
        /Адрес забора/iu.test(call.text),
    ),
    'delivery pickup from another city should trigger mismatch warning',
  );
});

test('delivery flow rejects dropoff from another city', { concurrency: false }, async (t) => {
  ensureBotEnv();

  const uiCalls = stubUi(t);
  stubDb(t);

  const geocode = require('../src/bot/services/geocode');
  const originalGeocode = geocode.geocodeOrderLocation;
  geocode.geocodeOrderLocation = async () => ({
    query: '2ГИС склад',
    address: 'Астана, Назарбаева 10',
    latitude: 51.15,
    longitude: 71.47,
    twoGisUrl: 'https://2gis.kz/astana/firm/70000001000000004',
  });
  t.after(() => {
    geocode.geocodeOrderLocation = originalGeocode;
  });

  const { deliveryOrderTestables } = require('../src/bot/flows/client/deliveryOrderFlow');

  const draft = {
    stage: 'collectingDropoff',
    pickup: {
      query: 'pickup',
      address: 'Алматы, Назарбаева 10',
      latitude: 43.25,
      longitude: 76.92,
      twoGisUrl: 'https://2gis.kz/almaty/firm/70000001000000001',
    },
  };
  const ctx = createDeliveryContext(draft);

  await deliveryOrderTestables.applyDropoffAddress(
    ctx,
    draft,
    'Астана\nhttps://2gis.kz/astana/firm/70000001000000004',
  );

  assert.equal(draft.stage, 'collectingDropoff');
  assert.equal(draft.dropoff, undefined);
  assert.ok(
    uiCalls.some(
      (call) =>
        call.id === 'client:delivery:error:city-mismatch' &&
        /Алматы/iu.test(call.text) &&
        /Адрес доставки/iu.test(call.text),
    ),
    'delivery dropoff from another city should trigger mismatch warning',
  );
});

test('delivery flow warns when dropoff distance is unrealistic', { concurrency: false }, async (t) => {
  ensureBotEnv();

  const uiCalls = stubUi(t);
  stubDb(t);

  const geocode = require('../src/bot/services/geocode');
  const originalGeocode = geocode.geocodeOrderLocation;
  geocode.geocodeOrderLocation = async () => ({
    query: 'Очень далёкий склад',
    address: 'Москва, склад',
    latitude: 55.75,
    longitude: 37.62,
    twoGisUrl: 'https://2gis.kz/almaty/firm/70000001000000005',
  });
  t.after(() => {
    geocode.geocodeOrderLocation = originalGeocode;
  });

  const { deliveryOrderTestables } = require('../src/bot/flows/client/deliveryOrderFlow');

  const draft = {
    stage: 'collectingDropoff',
    pickup: {
      query: 'pickup',
      address: 'Алматы, Назарбаева 10',
      latitude: 43.25,
      longitude: 76.92,
      twoGisUrl: 'https://2gis.kz/almaty/firm/70000001000000001',
    },
  };
  const ctx = createDeliveryContext(draft);

  await deliveryOrderTestables.applyDropoffAddress(
    ctx,
    draft,
    'Москва\nhttps://2gis.kz/almaty/firm/70000001000000005/37.62,55.75',
  );

  assert.equal(draft.stage, 'collectingDropoff');
  assert.equal(draft.dropoff, undefined);
  assert.equal(draft.price, undefined);
  assert.ok(
    uiCalls.some(
      (call) =>
        call.id === 'client:delivery:error:distance' &&
        /Расстояние/iu.test(call.text) &&
        /нереалистично/iu.test(call.text),
    ),
    'unrealistic delivery distance should trigger warning',
  );
});

test('extractPreferredUrl adds protocol to bare 2GIS link in text', () => {
  const text = 'Название 2gis.kz/almaty/geo/70000001000000000';

  const result = extractPreferredUrl(text);

  assert.equal(result, 'https://2gis.kz/almaty/geo/70000001000000000');
});

test('extractPreferredUrl handles go.2gis short link without protocol', () => {
  const text = 'Ссылка go.2gis.com/redirect?some=value&utm=1';

  const result = extractPreferredUrl(text);

  assert.equal(result, 'https://go.2gis.com/redirect?some=value&utm=1');
});
