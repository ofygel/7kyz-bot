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

const { buildProgressKeyboard } = require('../src/bot/flows/executor/jobs');

const CONTACT_BUTTON_TEXT = '📞 Связаться';

const createOrder = (overrides = {}) => ({
  id: 101,
  shortId: 'T-101',
  kind: 'delivery',
  status: 'claimed',
  city: 'almaty',
  pickup: {
    query: 'pickup-query',
    address: 'Pickup address',
    latitude: 43.238949,
    longitude: 76.889709,
    twoGisUrl: 'https://example.com/pickup',
  },
  dropoff: {
    query: 'dropoff-query',
    address: 'Dropoff address',
    latitude: 43.25654,
    longitude: 76.92848,
    twoGisUrl: 'https://example.com/dropoff',
  },
  price: {
    amount: 1500,
    currency: 'KZT',
    distanceKm: 5,
    etaMinutes: 15,
  },
  createdAt: new Date('2024-01-01T00:00:00Z'),
  ...overrides,
});

const findContactButton = (keyboard) =>
  keyboard.inline_keyboard
    .flat()
    .find((button) => button.text === CONTACT_BUTTON_TEXT);

test('buildProgressKeyboard adds contact button when client phone is available', () => {
  const order = createOrder({ clientPhone: '+7 (701) 123-45-67' });
  const keyboard = buildProgressKeyboard(order);
  const contactButton = findContactButton(keyboard);

  assert.ok(contactButton);
  assert.equal(contactButton.url, 'tel:+77011234567');
});

test('buildProgressKeyboard falls back to recipient phone when client phone is missing', () => {
  const order = createOrder({ recipientPhone: '8 777 123-45-67' });
  const keyboard = buildProgressKeyboard(order);
  const contactButton = findContactButton(keyboard);

  assert.ok(contactButton);
  assert.equal(contactButton.url, 'tel:+87771234567');
});

test('buildProgressKeyboard omits contact button when phones are unavailable', () => {
  const order = createOrder();
  const keyboard = buildProgressKeyboard(order);
  const contactButton = findContactButton(keyboard);

  assert.equal(contactButton, undefined);
});
