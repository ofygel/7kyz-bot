import assert from 'node:assert/strict';

declare global {
  // eslint-disable-next-line no-var
  var __verificationTrialTestRan: boolean | undefined;
}

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? 'test-token';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://user:pass@localhost:5432/db';
process.env.KASPI_CARD = process.env.KASPI_CARD ?? '1234';
process.env.KASPI_NAME = process.env.KASPI_NAME ?? 'Test User';
process.env.KASPI_PHONE = process.env.KASPI_PHONE ?? '+70000000000';
process.env.WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN ?? 'example.com';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'secret';

interface TrialCall {
  chatId?: number;
}

void (async () => {
  const { __testing } = await import('../src/bot/moderation/verifyQueue');

  const trialCalls: TrialCall[] = [];
  const fakeExpiry = new Date('2030-01-01T00:00:00Z');

  __testing.setTrialDependencies({
    getChannelBinding: async () => null,
    createTrialSubscription: async (params) => {
      trialCalls.push({ chatId: params.chatId });
      return { subscriptionId: 1, expiresAt: fakeExpiry };
    },
  });

  const application = {
    id: 'app-1',
    applicant: {
      telegramId: 123456,
      username: 'example',
      firstName: 'Test',
      lastName: 'User',
    },
    role: 'courier',
  } as const;

  const result = await __testing.activateVerificationTrial(application);

  assert.ok(result, 'Expected trial notification to be returned');
  assert.equal(trialCalls.length, 1, 'Trial subscription should be created when channel binding is missing');
  assert.equal(
    trialCalls[0]?.chatId,
    undefined,
    'Trial creation should omit chat id when no channel binding is available',
  );
  assert.match(
    result?.text ?? '',
    /бесплатный доступ/i,
    'Notification should mention the free access period',
  );

  console.log('verification trial fallback test: OK');

  __testing.setTrialDependencies({});

  global.__verificationTrialTestRan = true;
})();
