const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');

const ensureEnv = (key, value) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

ensureEnv('BOT_TOKEN', 'test-bot-token');
ensureEnv('HMAC_SECRET', 'test-hmac');
ensureEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
ensureEnv('KASPI_NAME', 'Test User');
ensureEnv('KASPI_PHONE', '+70000000000');
ensureEnv('SUPPORT_USERNAME', 'test_support');
ensureEnv('SUPPORT_URL', 'https://t.me/test_support');
ensureEnv('WEBHOOK_DOMAIN', 'example.com');
ensureEnv('WEBHOOK_SECRET', 'secret');
ensureEnv('REDIS_URL', 'redis://localhost:6379');

const executorPlans = require('../src/domain/executorPlans');
const subscriptionPlans = require('../src/bot/flows/executor/subscriptionPlans');
const subscriptionFlow = require('../src/bot/flows/executor/subscription');

const createExecutorContext = () => ({
  session: {},
  auth: {
    user: {
      executorKind: 'courier',
    },
  },
});

test('custom plan durations propagate through subscription prompts', (t) => {
  executorPlans.__testing__.setPlanDurationsOverride([10, 21, 45]);
  t.after(() => {
    executorPlans.__testing__.resetPlanDurationsOverride();
  });

  assert.equal(executorPlans.getPlanChoiceDurationDays('7'), 10);
  assert.equal(executorPlans.getPlanChoiceDurationDays('15'), 21);
  assert.equal(executorPlans.getPlanChoiceDurationDays('30'), 45);
  assert.equal(executorPlans.getPlanChoiceLabel('7'), 'План на 10 дней');
  assert.equal(executorPlans.getPlanChoiceLabel('15'), 'План на 21 день');
  assert.equal(executorPlans.getPlanChoiceLabel('30'), 'План на 45 дней');

  const options = subscriptionPlans.getSubscriptionPeriodOptions();
  assert.deepEqual(
    options.map((option) => option.days),
    [10, 21, 45],
    'Subscription options should reuse configured durations',
  );
  assert.deepEqual(
    options.map((option) => option.label),
    ['10 дней', '21 день', '45 дней'],
    'Subscription option labels should match configured durations',
  );

  const ctx = createExecutorContext();
  const infoText = subscriptionFlow.__private__.buildSubscriptionInfoText(ctx);
  assert.match(infoText, /10 дней/);
  assert.match(infoText, /21 день/);
  assert.match(infoText, /45 дней/);

  const keyboard = subscriptionFlow.__private__.buildSubscriptionKeyboard();
  const planLabels = keyboard.inline_keyboard.slice(0, 3).map((row) => row[0].text);
  assert.deepEqual(planLabels, ['10 дней', '21 день', '45 дней']);
  assert.equal(keyboard.inline_keyboard[3][0].text, '📤 Отправить чек');
  assert.equal(keyboard.inline_keyboard[3][0].url, 'https://t.me/test_support');
});
