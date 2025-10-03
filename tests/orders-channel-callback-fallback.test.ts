import test from 'node:test';
import assert from 'node:assert/strict';

import type { BotContext } from '../src/bot/types';

const ensureEnv = (key: string, value: string): void => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

const ensureBotEnv = (): void => {
  ensureEnv('BOT_TOKEN', 'test-bot-token');
  ensureEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
  ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
  ensureEnv('KASPI_NAME', 'Test User');
  ensureEnv('KASPI_PHONE', '+70000000000');
  ensureEnv('SUPPORT_USERNAME', 'test_support');
  ensureEnv('SUPPORT_URL', 'https://t.me/test_support');
  ensureEnv('WEBHOOK_DOMAIN', 'example.com');
  ensureEnv('WEBHOOK_SECRET', 'secret');
  ensureEnv('HMAC_SECRET', 'secret');
  ensureEnv('REDIS_URL', 'redis://localhost:6379');
};

test('callback fallback is sent when query already answered', async () => {
  ensureBotEnv();
  const { sendProcessingFeedback } = await import('../src/bot/services/feedback');
  const { answerCallbackQuerySafely } = await import('../src/bot/utils/callbacks');

  let answerCalls = 0;
  const delivered: Array<{ chatId: number; text: string }> = [];

  const ctx = {
    from: { id: 777 },
    chat: { id: 888, type: 'private' },
    callbackQuery: {
      id: 'cbq:1',
      chat_instance: 'instance',
      from: { id: 777 },
      message: { message_id: 321, chat: { id: 888, type: 'private' } },
      data: 'noop',
    },
    telegram: {
      sendChatAction: async () => {},
      sendMessage: async (chatId: number, text: string) => {
        delivered.push({ chatId, text });
        return { message_id: 999 } as unknown;
      },
    },
    answerCbQuery: async () => {
      answerCalls += 1;
      if (answerCalls === 2) {
        throw new Error('QUERY_ID_INVALID');
      }
      return true;
    },
  } as unknown as BotContext;

  await sendProcessingFeedback(ctx);
  await answerCallbackQuerySafely(ctx, 'Готово');

  assert.equal(answerCalls, 2);
  assert.deepStrictEqual(delivered, [{ chatId: 777, text: 'Готово' }]);
});
