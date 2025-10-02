const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');

const ensureEnv = (key, value) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

ensureEnv('BOT_TOKEN', 'test-bot-token');
ensureEnv('HMAC_SECRET', 'secret');
ensureEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
ensureEnv('KASPI_NAME', 'Test User');
ensureEnv('KASPI_PHONE', '+70000000000');
ensureEnv('SUPPORT_USERNAME', 'test_support');
ensureEnv('SUPPORT_URL', 'https://t.me/test_support');
ensureEnv('WEBHOOK_DOMAIN', 'example.com');
ensureEnv('WEBHOOK_SECRET', 'secret');

const { setChatCommands } = require('../src/bot/services/commands');

const createTelegram = (overrides = {}) => ({
  getChat: async () => ({ id: 111, type: 'supergroup' }),
  setMyCommands: async () => undefined,
  setChatMenuButton: async () => undefined,
  ...overrides,
});

test('setChatCommands skips registration for channel chats', async () => {
  const telegram = createTelegram({
    getChat: async () => ({ id: 111, type: 'channel' }),
    setMyCommands: async () => {
      throw new Error('setMyCommands should not be called');
    },
    setChatMenuButton: async () => {
      throw new Error('setChatMenuButton should not be called');
    },
  });

  await setChatCommands(telegram, 111, [], { showMenuButton: true });
});

test('setChatCommands stops after non-actionable errors', async () => {
  let menuButtonCalls = 0;
  const telegram = createTelegram({
    setMyCommands: async () => {
      const error = new Error("Bad Request: can't change commands in channel chats");
      error.response = {
        error_code: 400,
        description: "Bad Request: can't change commands in channel chats",
      };
      throw error;
    },
    setChatMenuButton: async () => {
      menuButtonCalls += 1;
    },
  });

  await setChatCommands(telegram, 222, [], { showMenuButton: true });

  assert.equal(menuButtonCalls, 0, 'chat menu button should not be configured after non-actionable errors');
});

test('setChatCommands skips invalid chat id errors from getChat', async () => {
  let commandsCalled = false;
  const telegram = createTelegram({
    getChat: async () => {
      const error = new Error('Bad Request: invalid chat_id');
      error.response = { error_code: 400, description: 'Bad Request: invalid chat_id' };
      throw error;
    },
    setMyCommands: async () => {
      commandsCalled = true;
    },
  });

  await setChatCommands(telegram, 333, [], { showMenuButton: true });

  assert.equal(commandsCalled, false, 'commands should not be configured when chat cannot be resolved');
});
