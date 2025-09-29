const crypto = require('node:crypto');
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

const {
  buildProfileCardText,
  __testing__,
} = require('../src/bot/flows/common/profileCard');
const { tryDecodeCallbackData } = require('../src/bot/services/callbackTokens');

const createContext = (userOverrides = {}) => {
  const baseUser = {
    telegramId: 1001,
    username: 'tester',
    firstName: 'Test',
    lastName: 'User',
    phone: '+70000000000',
    phoneVerified: true,
    role: 'client',
    executorKind: undefined,
    status: 'active_client',
    verifyStatus: 'none',
    subscriptionStatus: 'none',
    isVerified: false,
    isBlocked: false,
    citySelected: 'almaty',
    hasActiveOrder: false,
    keyboardNonce: 'test-nonce-value',
  };

  const user = { ...baseUser, ...userOverrides };

  return {
    auth: {
      user,
      executor: {
        verifiedRoles: { courier: false, driver: false },
        hasActiveSubscription: false,
        isVerified: false,
      },
      isModerator: false,
    },
    session: { ui: {} },
  };
};

test('buildProfileCardText enriches client profile with statuses and metrics', () => {
  const trialExpiresAt = new Date('2030-01-03T00:00:00Z');
  const subscriptionExpiresAt = new Date('2030-01-10T00:00:00Z');

  const ctx = createContext({
    verifyStatus: 'pending',
    subscriptionStatus: 'trial',
    trialStartedAt: new Date('2030-01-01T00:00:00Z'),
    trialExpiresAt,
    subscriptionExpiresAt,
    performanceMetrics: {
      ordersCompleted: 12,
      completionRate: 0.9,
    },
  });

  const text = buildProfileCardText(ctx);

  assert.match(text, /Верификация: на проверке/);
  assert.match(text, /Подписка: пробный доступ/);
  assert.match(text, /Пробный период: активен до/);
  assert.match(text, /Активный заказ: нет/);
  assert.match(text, /Показатели:/);
  assert.match(text, /Выполнено заказов:\s+12/);
  assert.match(text, /Доля завершённых заказов:\s+90%/);

  const keyboard = __testing__.buildProfileCardKeyboard(ctx, {
    backAction: 'client:menu:show',
    homeAction: 'client:menu:show',
    changeCityAction: 'client:menu:city',
    subscriptionAction: 'executor:subscription:link',
    supportAction: 'client:menu:support',
  });

  const labels = keyboard.inline_keyboard.map((row) => row.map((button) => button.text));
  assert.deepEqual(labels, [
    ['🏙️ Сменить город'],
    ['💳 Подписка'],
    ['🆘 Помощь'],
    ['⬅ Назад', '🏠 Главное меню'],
  ]);

  const cityButton = keyboard.inline_keyboard[0][0];
  const cityDecoded = tryDecodeCallbackData(cityButton.callback_data);
  assert.equal(cityDecoded.ok, true);
  assert.equal(cityDecoded.wrapped.raw, 'client:menu:city');
  assert.ok(cityDecoded.wrapped.nonce);

  const supportButtonClient = keyboard.inline_keyboard[2][0];
  const supportDecodedClient = tryDecodeCallbackData(supportButtonClient.callback_data);
  assert.equal(supportDecodedClient.ok, true);
  assert.equal(supportDecodedClient.wrapped.raw, 'client:menu:support');
  assert.ok(supportDecodedClient.wrapped.nonce);
});

test('buildProfileCardText surfaces executor metrics and navigation', () => {
  const ctx = createContext({
    role: 'executor',
    status: 'active_executor',
    executorKind: 'courier',
    verifyStatus: 'active',
    isVerified: true,
    verifiedAt: new Date('2024-02-01T00:00:00Z'),
    subscriptionStatus: 'active',
    subscriptionExpiresAt: new Date('2030-02-10T00:00:00Z'),
    trialStartedAt: new Date('2020-01-01T00:00:00Z'),
    trialExpiresAt: new Date('2020-01-10T00:00:00Z'),
    hasActiveOrder: true,
    performance: {
      rating: 4.8,
      ordersCompleted: 128,
    },
  });

  const text = buildProfileCardText(ctx);

  assert.match(text, /Верификация: подтверждена/);
  assert.match(text, /Подписка: активна/);
  assert.match(text, /Пробный период: истёк/);
  assert.match(text, /Активный заказ: да/);
  assert.match(text, /Рейтинг:\s+4,8/);
  assert.match(text, /Выполнено заказов:\s+128/);

  const keyboard = __testing__.buildProfileCardKeyboard(ctx, {
    backAction: 'executor:menu:refresh',
    homeAction: 'executor:menu:refresh',
    changeCityAction: 'executor:menu:city',
    subscriptionAction: 'executor:subscription:link',
    supportAction: 'support:contact',
  });

  const labels = keyboard.inline_keyboard.map((row) => row.map((button) => button.text));
  assert.deepEqual(labels, [
    ['🏙️ Сменить город'],
    ['💳 Подписка'],
    ['🆘 Помощь'],
    ['⬅ Назад', '🏠 Главное меню'],
  ]);

  const subscriptionButton = keyboard.inline_keyboard[1][0];
  const subscriptionDecoded = tryDecodeCallbackData(subscriptionButton.callback_data);
  assert.equal(subscriptionDecoded.ok, true);
  assert.equal(subscriptionDecoded.wrapped.raw, 'executor:subscription:link');
  assert.ok(subscriptionDecoded.wrapped.nonce);

  const supportButtonExecutor = keyboard.inline_keyboard[2][0];
  const supportDecodedExecutor = tryDecodeCallbackData(supportButtonExecutor.callback_data);
  assert.equal(supportDecodedExecutor.ok, true);
  assert.equal(supportDecodedExecutor.wrapped.raw, 'support:contact');
  assert.ok(supportDecodedExecutor.wrapped.nonce);
});

test('buildProfileCardKeyboard wraps actions even without persisted nonce', () => {
  const ctx = createContext({ keyboardNonce: undefined });

  const keyboard = __testing__.buildProfileCardKeyboard(ctx, {
    backAction: 'client:menu:back',
    homeAction: 'client:menu:home',
    changeCityAction: 'client:menu:city',
    subscriptionAction: undefined,
    supportAction: undefined,
  });

  const cityButton = keyboard?.inline_keyboard?.[0]?.[0];
  assert.ok(cityButton);

  const decoded = tryDecodeCallbackData(cityButton.callback_data);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.wrapped.raw, 'client:menu:city');

  const expectedFallback = crypto
    .createHash('sha256')
    .update(`kb:${ctx.auth.user.telegramId}`)
    .digest('base64url')
    .slice(0, 10);

  assert.equal(decoded.wrapped.nonce, expectedFallback);
});
