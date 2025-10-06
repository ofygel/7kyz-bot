const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');

const ensureEnv = (key, value) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

const ensureBotEnv = () => {
  ensureEnv('NODE_ENV', 'test');
  ensureEnv('BOT_TOKEN', 'test-bot-token');
  ensureEnv('HMAC_SECRET', 'test-hmac');
  ensureEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
  ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
  ensureEnv('KASPI_NAME', 'Test User');
  ensureEnv('KASPI_PHONE', '+70000000000');
  ensureEnv('SUPPORT_USERNAME', 'test_support');
  ensureEnv('SUPPORT_URL', 'https://t.me/test_support');
  ensureEnv('WEBHOOK_DOMAIN', 'example.com');
  ensureEnv('WEBHOOK_SECRET', 'secret');
};

const createMockBot = () => {
  const actions = new Map();
  const commands = new Map();
  return {
    actions,
    commands,
    action(trigger, handler) {
      if (typeof trigger === 'string') {
        actions.set(trigger, handler);
      }
    },
    command(trigger, handler) {
      commands.set(trigger, handler);
    },
    hears() {},
  };
};

const ROLE_PICK_STEP_ID = 'start:role:pick';

const createTestContext = (step) => {
  const replies = [];
  const telegramDeleteCalls = [];
  let editMarkupCalls = 0;

  const ctx = {
    chat: { id: step.chatId, type: 'private' },
    from: {
      id: 555,
      username: 'test_user',
      first_name: 'Test',
      last_name: 'User',
    },
    callbackQuery: { id: 'cbq', data: 'start:role-pick:client' },
    auth: {
      user: {
        telegramId: 555,
        role: 'client',
        status: 'active_client',
        phoneVerified: true,
        verifyStatus: 'none',
        subscriptionStatus: 'none',
        isVerified: false,
        isBlocked: false,
        hasActiveOrder: false,
        keyboardNonce: 'nonce',
      },
      executor: {
        verifiedRoles: { courier: false, driver: false },
        hasActiveSubscription: false,
        isVerified: false,
      },
      isModerator: false,
    },
    session: {
      phoneNumber: undefined,
      isAuthenticated: false,
      safeMode: false,
      isDegraded: false,
      awaitingPhone: false,
      onboarding: { active: true, step: 'role' },
      user: undefined,
      ui: {
        steps: { [ROLE_PICK_STEP_ID]: step },
        homeActions: [],
        pendingCityAction: undefined,
        clientMenuVariant: undefined,
      },
      client: { taxi: { stage: 'idle' }, delivery: { stage: 'idle' } },
      executor: {},
      support: { status: 'idle' },
      moderationPlans: { threads: {}, edits: {} },
      authSnapshot: {
        role: 'guest',
        executorKind: undefined,
        status: 'guest',
        phoneVerified: false,
        verifyStatus: 'none',
        subscriptionStatus: 'none',
        userIsVerified: false,
        executor: {
          verifiedRoles: { courier: false, driver: false },
          hasActiveSubscription: false,
          isVerified: false,
        },
        isModerator: false,
        hasActiveOrder: false,
        stale: false,
      },
      ephemeralMessages: [],
    },
    telegram: {
      deleteMessage: async (chatId, messageId) => {
        telegramDeleteCalls.push({ chatId, messageId });
      },
      editMessageReplyMarkup: async () => {},
      sendMessage: async () => ({ message_id: 900 }),
      getChat: async () => ({ id: step.chatId, type: 'private' }),
      setMyCommands: async () => {},
      setChatMenuButton: async () => {},
    },
    deleteMessage: async () => {
      throw new Error('message cannot be deleted');
    },
    editMessageReplyMarkup: async () => {
      editMarkupCalls += 1;
    },
    answerCbQuery: async () => {},
    reply: async (text) => {
      replies.push(text);
      return { message_id: 1000 + replies.length };
    },
  };

  return { ctx, replies, telegramDeleteCalls, getEditMarkupCalls: () => editMarkupCalls };
};

test('client role selection clears stored onboarding card', async () => {
  ensureBotEnv();
  const { registerClientMenu } = require('../src/bot/flows/client/menu');
  const { ROLE_PICK_CLIENT_ACTION } = require('../src/bot/flows/executor/roleSelectionConstants');

  const bot = createMockBot();
  registerClientMenu(bot);

  const handler = bot.actions.get(ROLE_PICK_CLIENT_ACTION);
  assert.ok(handler, 'client role action handler should be registered');

  const step = { chatId: 4242, messageId: 101, cleanup: false };
  const { ctx, telegramDeleteCalls, getEditMarkupCalls } = createTestContext(step);

  await handler(ctx);

  assert.equal(
    getEditMarkupCalls(),
    0,
    'role selection fallback should avoid editing reply markup after successful deletion',
  );
  assert.ok(
    telegramDeleteCalls.some(
      (call) => call.chatId === step.chatId && call.messageId === step.messageId,
    ),
    'stored role selection message should be deleted via telegram.deleteMessage',
  );
  assert.equal(
    ctx.session.ui.steps[ROLE_PICK_STEP_ID],
    undefined,
    'role selection step should be removed from UI state after selection',
  );
});
