const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');

const ensureEnv = (key, value) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

ensureEnv('BOT_TOKEN', 'test-bot-token');
ensureEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
ensureEnv('KASPI_NAME', 'Test User');
ensureEnv('KASPI_PHONE', '+70000000000');
ensureEnv('WEBHOOK_DOMAIN', 'example.com');
ensureEnv('WEBHOOK_SECRET', 'secret');

const uiModule = require('../src/bot/ui');
const commandsModule = require('../src/bot/services/commands');
const clientMenuModule = require('../src/ui/clientMenu');
const menuModule = require('../src/bot/flows/executor/menu');
const verificationModule = require('../src/bot/flows/executor/verification');

const createTestContext = () => {
  const ctx = {
    chat: { id: 4242, type: 'private' },
    from: { id: 4242 },
    auth: {
      user: {
        telegramId: 4242,
        phoneVerified: true,
        role: 'executor',
        executorKind: 'courier',
        status: 'active_executor',
        verifyStatus: 'pending',
        subscriptionStatus: 'none',
        isVerified: false,
        isBlocked: false,
        hasActiveOrder: false,
        citySelected: 'almaty',
      },
      executor: {
        verifiedRoles: { courier: false, driver: false },
        hasActiveSubscription: false,
        isVerified: false,
      },
      isModerator: false,
    },
    session: {
      user: { phoneVerified: true },
      isAuthenticated: true,
      ui: {
        steps: {},
        homeActions: [],
        pendingCityAction: undefined,
        clientMenuVariant: undefined,
      },
    },
    telegram: {
      sendMessage: async () => ({ message_id: 1001 }),
      editMessageText: async () => ({ message_id: 1001 }),
      deleteMessage: async () => undefined,
      setMyCommands: async () => undefined,
      setChatMenuButton: async () => undefined,
    },
    reply: async () => ({ message_id: 2002 }),
    answerCbQuery: async () => undefined,
    state: {},
  };

  menuModule.ensureExecutorState(ctx);
  const executorState = ctx.session.executor;
  executorState.role = 'courier';
  executorState.awaitingRoleSelection = true;
  executorState.roleSelectionStage = 'role';
  executorState.verification.courier.status = 'collecting';
  executorState.verification.courier.uploadedPhotos = [
    { fileId: 'test-file-id', messageId: 555 },
  ];

  return ctx;
};

test('executor in collecting verification resumes photo instructions on /start', async () => {
  const originalUiStep = uiModule.ui.step;
  const originalSetChatCommands = commandsModule.setChatCommands;
  const originalHideClientMenu = clientMenuModule.hideClientMenu;
  const originalShowExecutorMenu = menuModule.showExecutorMenu;

  const recordedSteps = [];
  uiModule.ui.step = async (_ctx, options) => {
    recordedSteps.push(options);
    return { messageId: recordedSteps.length, sent: true };
  };

  commandsModule.setChatCommands = async () => undefined;

  let hideClientMenuCalls = 0;
  clientMenuModule.hideClientMenu = async () => {
    hideClientMenuCalls += 1;
    return undefined;
  };

  menuModule.showExecutorMenu = async () => undefined;

  const { handleStart } = require('../src/bot/commands/start');

  const ctx = createTestContext();
  const executorState = ctx.session.executor;

  try {
    await handleStart(ctx);
  } finally {
    uiModule.ui.step = originalUiStep;
    commandsModule.setChatCommands = originalSetChatCommands;
    clientMenuModule.hideClientMenu = originalHideClientMenu;
    menuModule.showExecutorMenu = originalShowExecutorMenu;
  }

  assert.equal(executorState.role, 'courier');
  assert.equal(executorState.awaitingRoleSelection, false);
  assert.equal(executorState.roleSelectionStage, undefined);

  const promptStep = recordedSteps.find(
    (step) => step.id === verificationModule.VERIFICATION_PROMPT_STEP_ID,
  );
  assert.ok(promptStep, 'verification prompt was not shown');
  assert.match(promptStep.text, /Фото удостоверения личности/);

  assert.equal(hideClientMenuCalls, 0);
});
