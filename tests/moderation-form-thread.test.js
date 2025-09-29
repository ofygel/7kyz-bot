const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');

function ensureEnv(key, value) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

function enableTestEnv() {
  ensureEnv('BOT_TOKEN', 'test-bot-token');
  ensureEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
  ensureEnv('WEBHOOK_DOMAIN', 'example.com');
  ensureEnv('WEBHOOK_SECRET', 'secret');
  ensureEnv('BIND_VERIFY_CHANNEL_ID', '777000');
  ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
  ensureEnv('KASPI_NAME', 'Test User');
  ensureEnv('KASPI_PHONE', '+70000000000');
}

enableTestEnv();

const commandModule = require('../src/bot/channels/commands/from');
const {
  startWizard,
  handleWizardTextMessage,
  handlePlanSelection,
  getThreadKey,
} = commandModule.__testing;

test('CRM wizard posts every step inside the originating thread', async () => {
  const threadId = 4242;
  const chatId = Number.parseInt(process.env.BIND_VERIFY_CHANNEL_ID, 10);
  const sentMessages = [];
  let nextMessageId = 100;
  let failReplyOnce = true;

  const recordMessage = (method, text, extra = {}, targetChatId = chatId) => {
    sentMessages.push({ method, text, extra, chatId: targetChatId });
    return { message_id: nextMessageId++, chat: { id: targetChatId }, text };
  };

  const ctx = {
    chat: { id: chatId },
    message: { message_id: 1, message_thread_id: threadId, text: '/form' },
    session: {},
    auth: {},
    state: {},
    answerCbQuery: async () => {},
    reply: async (text, extra = {}) => {
      if (failReplyOnce) {
        failReplyOnce = false;
        const error = new Error('reply message not found');
        error.description = 'Bad Request: reply message not found';
        throw error;
      }

      return recordMessage('reply', text, extra);
    },
    telegram: {
      sendMessage: async (targetChatId, text, extra = {}) =>
        recordMessage('sendMessage', text, extra, targetChatId),
      editMessageText: async () => {},
      deleteMessage: async () => {},
    },
  };

  const threadKey = getThreadKey(threadId);

  await startWizard(ctx, threadKey, threadId);

  ctx.message = { message_id: 2, message_thread_id: threadId, text: '+77001234567' };
  await handleWizardTextMessage(ctx);

  ctx.message = { message_id: 3, message_thread_id: threadId, text: '@executor' };
  await handleWizardTextMessage(ctx);

  await handlePlanSelection(ctx, threadKey, '7');

  ctx.message = { message_id: 4, message_thread_id: threadId, text: '-' };
  await handleWizardTextMessage(ctx);

  const expectedPrefixes = ['📞', '👤', '📦', '📝', '📋'];

  for (const prefix of expectedPrefixes) {
    const message = sentMessages.find((entry) => entry.text.startsWith(prefix));
    assert.ok(message, `expected step starting with ${prefix}`);
    assert.equal(message.extra?.message_thread_id, threadId);
    assert.equal(message.chatId, chatId);
  }
});
