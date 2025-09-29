import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import type { BotContext } from '../src/bot/types';

const requireFn = createRequire(__filename);
const remindersModulePath = requireFn.resolve('../src/jobs/executorPlanReminders.ts');

(requireFn.cache as Record<string, NodeModule | undefined>)[remindersModulePath] = {
  id: remindersModulePath,
  filename: remindersModulePath,
  loaded: true,
  exports: {
    scheduleExecutorPlanReminder: async () => {},
    cancelExecutorPlanReminders: async () => {},
  },
} as unknown as NodeModule;

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? 'test-token';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://user:pass@localhost:5432/db';
process.env.KASPI_CARD = process.env.KASPI_CARD ?? '1234';
process.env.KASPI_NAME = process.env.KASPI_NAME ?? 'Test User';
process.env.KASPI_PHONE = process.env.KASPI_PHONE ?? '+70000000000';
process.env.WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN ?? 'example.com';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'secret';

void (async () => {
  const { __testing } = await import('../src/bot/channels/commands/from');

  const payload = ['тел: +77001234567', 'план: 7', 'комм: без даты'].join('\n');

  const beforeParse = Date.now();
  const parsed = __testing.parsePlanForm(payload);
  const afterParse = Date.now();

  assert.ok(parsed.startAt, 'Дата старта должна заполняться автоматически при отсутствии ввода');

  const startAtTime = parsed.startAt!.getTime();
  assert.ok(
    startAtTime >= beforeParse - 1_000 && startAtTime <= afterParse + 1_000,
    'Дата старта без явного значения должна устанавливаться к текущему времени',
  );

  const fakeCtx = {
    chat: { id: 123 },
    message: { message_thread_id: undefined },
  } as unknown as BotContext;

  const input = __testing.buildPlanInput(fakeCtx, parsed);
  assert.ok(input, 'План должен создаваться при передаче телефона, тарифа и стартовой даты по умолчанию');
  assert.equal(
    input!.startAt.getTime(),
    startAtTime,
    'Созданный план должен использовать автоматически выбранную дату старта',
  );

  console.log('from command default start date test: OK');
})();
