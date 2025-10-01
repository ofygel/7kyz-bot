import assert from 'node:assert/strict';

declare const process: NodeJS.Process;

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
process.env.HMAC_SECRET = process.env.HMAC_SECRET ?? 'test-secret';

void (async () => {
  const { __testing } = await import('../src/bot/channels/commands/form');

  const threadId = 321;
  const ctx = {
    channelPost: {
      message_thread_id: threadId,
    },
  } as const;

  const result = __testing.getThreadIdFromContext(ctx as unknown as import('../src/bot/types').BotContext);

  assert.equal(result, threadId, 'Thread identifier should be derived from channel posts');
})();
