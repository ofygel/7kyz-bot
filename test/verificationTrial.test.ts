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
process.env.SUPPORT_USERNAME = process.env.SUPPORT_USERNAME ?? 'test_support';
process.env.SUPPORT_URL = process.env.SUPPORT_URL ?? 'https://t.me/test_support';
process.env.WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN ?? 'example.com';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'secret';

void (async () => {
  const { __testing, notifyVerificationApproval } = await import(
    '../src/bot/moderation/verifyQueue'
  );

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

  const fallback = __testing.buildFallbackApprovalNotification(application);

  const sentMessages: Array<{
    chatId: number;
    text: string;
    replyMarkup: unknown;
  }> = [];

  const telegram: any = {
    async sendMessage(chatId: number, text: string, options?: { reply_markup?: unknown }) {
      sentMessages.push({ chatId, text, replyMarkup: options?.reply_markup });
      return {};
    },
  };

  await notifyVerificationApproval(telegram, application);

  assert.equal(sentMessages.length, 1, 'Approval notification should be sent once');
  assert.equal(
    sentMessages[0]?.chatId,
    application.applicant.telegramId,
    'Notification should be delivered to the applicant',
  );
  assert.equal(sentMessages[0]?.text, fallback.text, 'Fallback text should be used');
  assert.deepEqual(sentMessages[0]?.replyMarkup, fallback.keyboard, 'Support keyboard should be attached');
  assert.match(
    sentMessages[0]?.text ?? '',
    /Чтобы получить доступ, напишите в поддержку/i,
    'Notification should reference manual access through support',
  );

  console.log('verification approval fallback test: OK');

  global.__verificationTrialTestRan = true;
})();
