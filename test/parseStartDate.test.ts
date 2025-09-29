import assert from 'node:assert/strict';
import { DateTime } from 'luxon';

declare const process: NodeJS.Process;

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? 'test-token';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://user:pass@localhost:5432/db';
process.env.KASPI_CARD = process.env.KASPI_CARD ?? '1234';
process.env.KASPI_NAME = process.env.KASPI_NAME ?? 'Test User';
process.env.KASPI_PHONE = process.env.KASPI_PHONE ?? '+70000000000';
process.env.WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN ?? 'example.com';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'secret';
process.env.CALLBACK_SIGN_SECRET = process.env.CALLBACK_SIGN_SECRET ?? 'test-secret';
process.env.TIMEZONE = process.env.TIMEZONE ?? 'Asia/Almaty';

const formatInTimezone = (date: Date, timezone: string): string =>
  DateTime.fromJSDate(date).setZone(timezone).toFormat('yyyy-MM-dd HH:mm:ss');

void (async () => {
  const [{ __testing: formTesting }, { __testing: queueTesting }, { config }] = await Promise.all([
    import('../src/bot/channels/commands/form'),
    import('../src/infra/executorPlanQueue'),
    import('../src/config'),
  ]);

  const inputs = ['01.02.2024, 10:00:00', '01.02.2024, 10:00', '01.02.2024 10:00'];
  const expected = '2024-02-01 10:00:00';

  for (const input of inputs) {
    const formDate = formTesting.parseStartDate(input);
    assert.ok(formDate, `Form parser should accept "${input}"`);
    assert.equal(
      formatInTimezone(formDate, config.timezone),
      expected,
      `Form parser should keep local time for "${input}"`,
    );

    const queueDate = queueTesting.parseStartDate(input);
    assert.ok(queueDate, `Queue parser should accept "${input}"`);
    assert.equal(
      formatInTimezone(queueDate, config.timezone),
      expected,
      `Queue parser should keep local time for "${input}"`,
    );

    assert.equal(
      formDate.getTime(),
      queueDate.getTime(),
      `Parsers should produce identical timestamps for "${input}"`,
    );
  }
})();
