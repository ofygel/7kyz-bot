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
  ensureEnv('SUPPORT_USERNAME', 'test_support');
  ensureEnv('SUPPORT_URL', 'https://t.me/test_support');
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

test(
  'handleSummaryDecision stores the comment when creating a plan',
  { concurrency: false },
  async () => {
    const dbClientPath = require.resolve('../src/db/client');
    const queueModulePath = require.resolve('../src/infra/executorPlanQueue');
    const remindersModulePath = require.resolve('../src/jobs/executorPlanReminders');
    const uiModulePath = require.resolve('../src/bot/ui.ts');
    const keyboardModulePath = require.resolve('../src/bot/ui/executorPlans');
    const planSummaryModulePath = require.resolve('../src/services/executorPlans/reminders');
    const executorPlansModulePath = require.resolve('../src/db/executorPlans');
    const formModulePath = require.resolve(FORM_COMMANDS_MODULE_PATH);

    const originalModules = new Map();
    const stubModule = (path, exports) => {
      originalModules.set(path, require.cache[path]);
      require.cache[path] = {
        id: path,
        filename: path,
        loaded: true,
        exports,
      };
    };

    const restoreModules = () => {
      for (const [path, original] of originalModules.entries()) {
        if (original) {
          require.cache[path] = original;
        } else {
          delete require.cache[path];
        }
      }
    };

    const queryCalls = [];
    const insertedRows = [];
    const stubPool = {
      async query(sqlText, params = []) {
        const sql = typeof sqlText === 'string' ? sqlText : String(sqlText);
        queryCalls.push({ sql, params });

        if (/INSERT\s+INTO\s+executor_plans/i.test(sql)) {
          const row = {
            id: 101,
            chat_id: params[0],
            thread_id: params[1],
            phone: params[2],
            nickname: params[3],
            plan_choice: params[4],
            start_at: params[5],
            ends_at: params[6],
            comment: params[7],
            status: 'active',
            muted: false,
            reminder_index: 0,
            reminder_last_sent: null,
            card_message_id: null,
            card_chat_id: null,
            created_at: params[8],
            updated_at: params[8],
          };
          insertedRows.push(row);
          return { rows: [row] };
        }

        if (/SELECT\s+\*/i.test(sql) && /FROM\s+executor_plans/i.test(sql)) {
          return { rows: [] };
        }

        throw new Error(`Unexpected SQL in test stub: ${sql}`);
      },
    };

    const reminderCalls = [];
    const mutationLog = [];
    const uiSteps = [];
    const uiClearCalls = [];

    stubModule(dbClientPath, { pool: stubPool, default: stubPool, __esModule: true });
    stubModule(remindersModulePath, {
      scheduleExecutorPlanReminder: async (plan) => {
        reminderCalls.push(plan);
      },
      cancelExecutorPlanReminders: async () => {},
      ensureExecutorPlanReminderQueue: () => true,
      notifyExecutorPlanReminderQueueUnavailable: async () => {},
      __esModule: true,
    });
    stubModule(queueModulePath, {
      enqueueExecutorPlanMutation: async () => {},
      flushExecutorPlanMutations: async () => {},
      processExecutorPlanMutation: async (mutation) => {
        mutationLog.push(mutation);
        if (mutation.type === 'create') {
          const { createExecutorPlan } = require('../src/db/executorPlans');
          const plan = await createExecutorPlan(mutation.payload);
          return { type: 'created', plan };
        }
        return null;
      },
      __esModule: true,
    });
    stubModule(uiModulePath, {
      ui: {
        step: async (_ctx, options) => {
          uiSteps.push(options);
          return { messageId: uiSteps.length, sent: true };
        },
        clear: async (_ctx, options) => {
          uiClearCalls.push(options);
        },
      },
      __esModule: true,
    });
    stubModule(keyboardModulePath, {
      buildExecutorPlanActionKeyboard: () => ({ inline_keyboard: [] }),
      __esModule: true,
    });
    stubModule(planSummaryModulePath, {
      buildPlanSummary: () => 'План сохранён',
      __esModule: true,
    });

    const originalExecutorPlansModule = require.cache[executorPlansModulePath];
    const originalFormModule = require.cache[formModulePath];
    delete require.cache[executorPlansModulePath];
    delete require.cache[formModulePath];

    try {
      const commandModule = require(FORM_COMMANDS_MODULE_PATH);
      const { handleSummaryDecision, getThreadKey } = commandModule.__testing;

      const chatId = 555;
      const threadId = 42;
      const threadKey = getThreadKey(threadId);
      const ctx = {
        chat: { id: chatId },
        session: {
          moderationPlans: {
            threads: {
              [threadKey]: {
                step: 'summary',
                threadId,
                phone: '+77001234567',
                planChoice: '7',
                comment: 'Комментарий теста',
                startAt: new Date('2024-02-01T00:00:00Z'),
              },
            },
            edits: {},
          },
        },
        telegram: {
          sendMessage: async () => ({}),
        },
        reply: async () => {},
        answerCbQuery: async () => {},
      };

      await handleSummaryDecision(ctx, threadKey, 'confirm');

      assert.equal(mutationLog.length, 1);
      assert.equal(mutationLog[0].type, 'create');
      assert.equal(insertedRows.length, 1);
      assert.equal(reminderCalls.length, 1);

      const insertCall = queryCalls.find((entry) => /INSERT\s+INTO\s+executor_plans/i.test(entry.sql));
      assert.ok(insertCall, 'Expected INSERT query to be executed');
      assert.equal(insertCall.params.length, 9);
      assert.equal(insertCall.params[7], 'Комментарий теста');

      const insertedRow = insertedRows[0];
      assert.equal(insertedRow.comment, 'Комментарий теста');
    } finally {
      if (originalExecutorPlansModule) {
        require.cache[executorPlansModulePath] = originalExecutorPlansModule;
      } else {
        delete require.cache[executorPlansModulePath];
      }

      if (originalFormModule) {
        require.cache[formModulePath] = originalFormModule;
      } else {
        delete require.cache[formModulePath];
      }

      restoreModules();
    }
  },
);
