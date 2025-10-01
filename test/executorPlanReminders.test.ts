import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

import '../src/types/bullmq';

import type { ExecutorPlanRecord } from '../src/types';

const requireFn = createRequire(__filename);

const moduleConstructor = Module as unknown as {
  _resolveFilename: (
    request: string,
    parent?: NodeModule | null,
    isMain?: boolean,
    options?: unknown,
  ) => string;
};

const originalResolveFilename = moduleConstructor._resolveFilename;
moduleConstructor._resolveFilename = function patchedResolveFilename(
  request: string,
  parent?: NodeModule | null,
  isMain?: boolean,
  options?: unknown,
): string {
  if (request === 'bullmq') {
    return request;
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

(requireFn.cache as Record<string, NodeModule | undefined>).bullmq = {
  id: 'bullmq',
  filename: 'bullmq',
  loaded: true,
  exports: {
    Queue: class {},
    Worker: class {},
  },
} as unknown as NodeModule;

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? 'test-token';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://user:pass@localhost:5432/db';
process.env.KASPI_CARD = process.env.KASPI_CARD ?? '1234';
process.env.KASPI_NAME = process.env.KASPI_NAME ?? 'Test User';
process.env.KASPI_PHONE = process.env.KASPI_PHONE ?? '+70000000000';
process.env.SUPPORT_USERNAME = process.env.SUPPORT_USERNAME ?? 'test_support';
process.env.SUPPORT_URL = process.env.SUPPORT_URL ?? 'https://t.me/test_support';
process.env.WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN ?? 'example.com';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'secret';
process.env.TRIAL_DAYS = process.env.TRIAL_DAYS ?? '3';

void (async () => {
  const { REMINDER_OFFSETS_HOURS } = await import('../src/services/executorPlans/reminders');
  const { __testing } = await import('../src/jobs/executorPlanReminders');
  const { getPlanChoiceDurationDays } = await import('../src/domain/executorPlans');

  const { computeReminderTime } = __testing;

  const PLAN_CHOICES: ExecutorPlanRecord['planChoice'][] = ['trial', '7', '15', '30'];
  const PLAN_CONFIGS = PLAN_CHOICES.map((choice) => ({
    choice,
    days: getPlanChoiceDurationDays(choice),
  }));

  const msPerHour = 60 * 60 * 1000;
  const msPerDay = 24 * msPerHour;
  const base = new Date('2024-01-01T00:00:00Z');

  for (const { choice, days } of PLAN_CONFIGS) {
    const endsAt = new Date(base.getTime() + days * msPerDay);
    const plan: ExecutorPlanRecord = {
      id: 1,
      chatId: 1,
      threadId: undefined,
      phone: '+70000000000',
      nickname: undefined,
      planChoice: choice,
      startAt: base,
      endsAt,
      comment: undefined,
      status: 'active',
      muted: false,
      reminderIndex: 0,
      reminderLastSent: undefined,
      createdAt: base,
      updatedAt: base,
    };

    for (let index = 0; index < REMINDER_OFFSETS_HOURS.length; index += 1) {
      const expected = new Date(endsAt.getTime() + REMINDER_OFFSETS_HOURS[index] * msPerHour);
      const actual = computeReminderTime(plan, index);
      assert.ok(actual, `Напоминание ${index} должно вычисляться для плана ${choice}`);
      assert.equal(
        actual.getTime(),
        expected.getTime(),
        `Неверное время напоминания ${index} для плана на ${days} дней`,
      );
    }

    const outOfRange = computeReminderTime(plan, REMINDER_OFFSETS_HOURS.length);
    assert.equal(outOfRange, null, 'Напоминание вне диапазона должно возвращать null');
  }

  console.log('executor plan reminder timing tests: OK');
})();
