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

const { config } = require('../src/config');
const {
  REMINDER_OFFSETS_HOURS,
  REMINDER_STAGE_LABELS,
  buildPlanSummary,
  buildReminderMessage,
  formatPlanChoice,
} = require('../src/services/executorPlans/reminders');
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

const formatDateTime = (value) =>
  new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: config.timezone,
  }).format(value);

test('buildPlanSummary включает дату ближайшего напоминания', () => {
  const reminderIndex = 0;
  const plan = createPlan({
    reminderIndex,
    nickname: '@executor',
    comment: 'Комментарий',
  });

  const summary = buildPlanSummary(plan);
  const lines = summary.split('\n');
  const reminderLine = lines.find((line) => line.startsWith('Ближайшее напоминание: '));

  assert.ok(reminderLine, 'Резюме плана должно содержать строку о ближайшем напоминании');

  const expectedDueAt = new Date(
    plan.endsAt.getTime() + REMINDER_OFFSETS_HOURS[reminderIndex] * 60 * 60 * 1000,
  );
  assert.equal(
    reminderLine,
    `Ближайшее напоминание: ${formatDateTime(expectedDueAt)}`,
    'В резюме должна выводиться дата ближайшего напоминания',
  );
});

test('buildPlanSummary сообщает об окончании напоминаний', () => {
  const plan = createPlan({ reminderIndex: REMINDER_OFFSETS_HOURS.length });

  const summary = buildPlanSummary(plan);

  assert.ok(
    summary.includes('Ближайшее напоминание: выполнены все'),
    'Резюме должно указывать на завершение всех напоминаний',
  );
});

test('buildReminderMessage формирует текст напоминания с данными плана', () => {
  const reminderIndex = 1;
  const plan = createPlan({
    reminderIndex,
    nickname: '@executor',
    comment: 'Комментарий',
  });

  const message = buildReminderMessage(plan, reminderIndex);

  assert.ok(message.startsWith(`⏰ Напоминание ${REMINDER_STAGE_LABELS[reminderIndex]}`));
  assert.ok(message.includes(`Телефон: ${plan.phone}`));
  assert.ok(message.includes(`Ник/ID: ${plan.nickname}`));
  assert.ok(message.includes(`План: ${formatPlanChoice(plan)}`));
  assert.ok(message.includes(`Старт: ${formatDateTime(plan.startAt)}`));
  assert.ok(message.includes(`Окончание: ${formatDateTime(plan.endsAt)}`));
  assert.ok(message.includes('Комментарий: Комментарий'));
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
