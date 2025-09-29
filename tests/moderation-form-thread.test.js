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

const FORM_COMMANDS_MODULE_PATH = '../src/bot/channels/commands/form';

function loadFormCommandsModule() {
  delete require.cache[require.resolve(FORM_COMMANDS_MODULE_PATH)];
  return require(FORM_COMMANDS_MODULE_PATH);
}

test('registerFormCommand configures verify channel chat commands once', async () => {
  const { registerFormCommand } = loadFormCommandsModule();

  const bot = {
    command: () => undefined,
    on: () => undefined,
    action: () => undefined,
    telegram: {
      setMyCommands: async () => undefined,
      setChatMenuButton: async () => undefined,
    },
  };

  const setMyCommandsCalls = [];
  const callPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('setMyCommands was not called')), 1000);

    bot.telegram.setMyCommands = async (...args) => {
      setMyCommandsCalls.push(args);
      if (setMyCommandsCalls.length === 1) {
        clearTimeout(timeout);
        resolve();
      }
    };
  });

  registerFormCommand(bot);
  await callPromise;

  assert.equal(setMyCommandsCalls.length, 1);

  const [commandsArg, optionsArg] = setMyCommandsCalls[0];
  const chatId = Number.parseInt(process.env.BIND_VERIFY_CHANNEL_ID, 10);
  assert.equal(optionsArg.scope.chat_id, chatId);

  const commandNames = commandsArg.map((entry) => entry.command);
  for (const expected of ['from', 'form', 'extend', 'block', 'unblock', 'status', 'delete']) {
    assert.ok(commandNames.includes(expected), `expected command ${expected} to be registered`);
  }

  registerFormCommand(bot);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setMyCommandsCalls.length, 1);
});

test('CRM wizard posts every step inside the originating thread', async () => {
  const commandModule = loadFormCommandsModule();
  const {
    startWizard,
    handleWizardTextMessage,
    handlePlanSelection,
    getThreadKey,
  } = commandModule.__testing;

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
