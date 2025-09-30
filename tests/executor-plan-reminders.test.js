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

const { REMINDER_OFFSETS_HOURS } = require('../src/services/executorPlans/reminders');
const { __testing } = require('../src/jobs/executorPlanReminders');

const createPlan = (overrides = {}) => ({
  id: 101,
  chatId: 123456,
  phone: '+77010000000',
  planChoice: '7',
  startAt: new Date('2024-01-01T00:00:00Z'),
  endsAt: new Date('2024-01-08T00:00:00Z'),
  status: 'active',
  muted: false,
  reminderIndex: REMINDER_OFFSETS_HOURS.length - 1,
  createdAt: new Date('2023-12-31T00:00:00Z'),
  updatedAt: new Date('2023-12-31T00:00:00Z'),
  ...overrides,
});

test('marks executor plan as completed after final reminder', async (t) => {
  const plan = createPlan();
  const telegram = {
    sendMessage: async () => {},
  };

  __testing.setBotRef({ telegram });
  __testing.setGetExecutorPlanByIdOverride(async () => plan);

  let reminderUpdated = null;
  __testing.setUpdateExecutorPlanReminderIndexOverride(async () => {
    reminderUpdated = {
      ...plan,
      reminderIndex: REMINDER_OFFSETS_HOURS.length,
    };
    return reminderUpdated;
  });

  let scheduled = false;
  __testing.setScheduleReminderOverride(async () => {
    scheduled = true;
  });

  const enqueued = [];
  __testing.setEnqueueExecutorPlanMutationOverride(async (mutation) => {
    enqueued.push(mutation);
  });

  t.after(() => {
    __testing.resetOverrides();
    __testing.resetBotRef();
  });

  await __testing.handleReminderJob({
    planId: plan.id,
    reminderIndex: plan.reminderIndex,
  });

  assert.equal(scheduled, false, 'no additional reminders should be scheduled');
  assert.deepEqual(enqueued, [
    {
      type: 'set-status',
      payload: { id: plan.id, status: 'completed' },
    },
  ]);
  assert.ok(reminderUpdated, 'reminder index should be updated');
});
