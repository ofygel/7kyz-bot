import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import type { BotContext } from '../src/bot/types';
import type { ExecutorPlanInsertInput, ExecutorPlanRecord } from '../src/types';

const requireFn = createRequire(__filename);

const remindersModulePath = requireFn.resolve('../src/jobs/executorPlanReminders.ts');
const scheduledPlans: ExecutorPlanRecord[] = [];

(requireFn.cache as Record<string, NodeModule | undefined>)[remindersModulePath] = {
  id: remindersModulePath,
  filename: remindersModulePath,
  loaded: true,
  exports: {
    scheduleExecutorPlanReminder: async (plan: ExecutorPlanRecord) => {
      scheduledPlans.push(plan);
    },
    cancelExecutorPlanReminders: async () => {},
  },
} as unknown as NodeModule;

const queueModulePath = requireFn.resolve('../src/infra/executorPlanQueue.ts');

interface RecordedMutation {
  type: string;
  payload: ExecutorPlanInsertInput;
}

const processedMutations: RecordedMutation[] = [];

(requireFn.cache as Record<string, NodeModule | undefined>)[queueModulePath] = {
  id: queueModulePath,
  filename: queueModulePath,
  loaded: true,
  exports: {
    enqueueExecutorPlanMutation: async () => {},
    flushExecutorPlanMutations: async () => {},
    processExecutorPlanMutation: async (mutation: { type: string; payload: ExecutorPlanInsertInput }) => {
      processedMutations.push({ type: mutation.type, payload: mutation.payload });
      if (mutation.type !== 'create') {
        return null;
      }

      const payload = mutation.payload;
      const plan: ExecutorPlanRecord = {
        id: 777,
        chatId: payload.chatId,
        threadId: payload.threadId,
        phone: payload.phone,
        nickname: payload.nickname,
        planChoice: payload.planChoice,
        startAt: payload.startAt,
        endsAt: payload.endsAt ?? payload.startAt,
        comment: payload.comment,
        status: 'active',
        muted: false,
        reminderIndex: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ExecutorPlanRecord;

      return { type: 'created', plan } as const;
    },
    onExecutorPlanMutation: () => {},
  },
} as unknown as NodeModule;

const uiModulePath = requireFn.resolve('../src/bot/ui.ts');

interface LoggedStep {
  id: string;
  text: string;
  keyboard?: unknown;
}

const stepLog: LoggedStep[] = [];
const clearLog: { ids?: string[]; cleanupOnly?: boolean }[] = [];

(requireFn.cache as Record<string, NodeModule | undefined>)[uiModulePath] = {
  id: uiModulePath,
  filename: uiModulePath,
  loaded: true,
  exports: {
    ui: {
      step: async (_ctx: BotContext, options: { id: string; text: string; keyboard?: unknown }) => {
        stepLog.push({ id: options.id, text: options.text, keyboard: options.keyboard });
        return { messageId: stepLog.length, sent: true };
      },
      clear: async (_ctx: BotContext, options: { ids?: string[]; cleanupOnly?: boolean } = {}) => {
        clearLog.push(options);
      },
      trackStep: async () => {},
    },
  },
} as unknown as NodeModule;

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? 'test-token';
process.env.CALLBACK_SIGN_SECRET = process.env.CALLBACK_SIGN_SECRET ?? 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://user:pass@localhost:5432/db';
process.env.KASPI_CARD = process.env.KASPI_CARD ?? '1234';
process.env.KASPI_NAME = process.env.KASPI_NAME ?? 'Test User';
process.env.KASPI_PHONE = process.env.KASPI_PHONE ?? '+70000000000';
process.env.WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN ?? 'example.com';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'secret';

void (async () => {
  const { __testing } = await import('../src/bot/channels/commands/form');

  const threadId = 555;
  const threadKey = __testing.getThreadKey(threadId);

  const session = {
    ephemeralMessages: [],
    isAuthenticated: false,
    safeMode: false,
    isDegraded: false,
    awaitingPhone: false,
    authSnapshot: {} as Record<string, unknown>,
    executor: {} as Record<string, unknown>,
    client: {} as Record<string, unknown>,
    ui: { steps: {}, homeActions: [] },
    moderationPlans: { threads: {} },
    support: { status: 'idle' },
    onboarding: { active: false },
  } as unknown as BotContext['session'];

  const replies: string[] = [];
  const callbackAnswers: string[] = [];
  const sentMessages: Array<{ chatId: number; text: string; options: unknown }> = [];

  const ctx = {
    chat: { id: 123, type: 'supergroup' },
    session,
    auth: {} as Record<string, unknown>,
    telegram: {
      sendMessage: async (chatId: number, text: string, options: unknown) => {
        sentMessages.push({ chatId, text, options });
        return { message_id: sentMessages.length };
      },
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length };
    },
    answerCbQuery: async (text?: string) => {
      callbackAnswers.push(text ?? '');
    },
  } as unknown as BotContext;

  const setMessage = (text: string) => {
    (ctx as { message?: unknown }).message = {
      message_thread_id: threadId,
      text,
    };
  };

  await __testing.startWizard(ctx, threadKey, threadId);

  let wizardState = session.moderationPlans.threads[threadKey];
  assert.ok(wizardState, 'Состояние мастера должно создаваться при запуске');
  assert.equal(wizardState?.step, 'phone', 'Первый шаг мастера — ввод телефона');

  setMessage('+7 (700) 123-45-67');
  assert.equal(await __testing.handleWizardTextMessage(ctx), true);

  wizardState = session.moderationPlans.threads[threadKey];
  assert.ok(wizardState, 'Состояние мастера должно сохраняться после ввода телефона');
  assert.equal(wizardState?.phone, '+77001234567', 'Телефон должен нормализоваться к формату +7700…');
  assert.equal(wizardState?.step, 'nickname', 'После ввода телефона ожидается ник');

  setMessage('@executor');
  assert.equal(await __testing.handleWizardTextMessage(ctx), true);

  wizardState = session.moderationPlans.threads[threadKey];
  assert.equal(wizardState?.nickname, '@executor', 'Ник должен сохраняться');
  assert.equal(wizardState?.step, 'plan', 'После ника бот должен ожидать выбор тарифа');

  await __testing.handlePlanSelection(ctx, threadKey, '15');
  wizardState = session.moderationPlans.threads[threadKey];
  assert.equal(wizardState?.planChoice, '15', 'Выбор тарифа должен сохраняться');
  assert.equal(wizardState?.step, 'details', 'После выбора тарифа запрашиваются дополнительные данные');
  assert.ok(
    callbackAnswers.includes('Выбран тариф: План на 15 дней'),
    'Ответ на callback должен подтверждать выбор тарифа',
  );

  setMessage('2024-02-01\nКомментарий');
  assert.equal(await __testing.handleWizardTextMessage(ctx), true);

  wizardState = session.moderationPlans.threads[threadKey];
  assert.equal(wizardState?.step, 'summary', 'После ввода даты и комментария мастер переходит к подтверждению');
  assert.ok(wizardState?.startAt, 'Дата старта должна сохраняться');
  assert.equal(
    wizardState?.startAt?.toISOString(),
    new Date(Date.UTC(2024, 1, 1, 6, 0, 0)).toISOString(),
    'Дата старта должна парситься в UTC с часовым поясом по умолчанию',
  );
  assert.equal(wizardState?.comment, 'Комментарий', 'Комментарий должен сохраняться');

  const summaryStep = stepLog.find((step) => step.id.endsWith(':summary'));
  assert.ok(summaryStep, 'Шаг с итоговым резюме должен отображаться');
  assert.ok(
    summaryStep?.text.includes('Проверьте данные плана'),
    'Итоговое резюме должно содержать инструкцию на проверку данных',
  );

  await __testing.handleSummaryDecision(ctx, threadKey, 'confirm');

  assert.equal(processedMutations.length, 1, 'Создание плана должно вызывать мутацию очереди');
  assert.equal(processedMutations[0].type, 'create', 'Создание плана должно выполнять create-мутацию');
  assert.equal(
    processedMutations[0].payload.phone,
    '+77001234567',
    'В мутацию должен передаваться нормализованный телефон',
  );
  assert.equal(
    processedMutations[0].payload.planChoice,
    '15',
    'В мутации должен использоваться выбранный тариф',
  );
  assert.equal(
    processedMutations[0].payload.comment,
    'Комментарий',
    'В мутации должен передаваться введённый комментарий',
  );
  assert.equal(
    processedMutations[0].payload.threadId,
    threadId,
    'Мутация должна помнить исходный идентификатор ветки',
  );

  assert.equal(scheduledPlans.length, 1, 'После сохранения плана должен планироваться напоминатель');
  assert.equal(
    scheduledPlans[0].planChoice,
    '15',
    'В запланированном плане должен сохраняться выбранный тариф',
  );

  assert.equal(callbackAnswers.at(-1), 'План сохранён', 'Подтверждение должно сообщать об успешном создании');
  assert.equal(
    session.moderationPlans.threads[threadKey],
    undefined,
    'После сохранения состояние мастера должно очищаться',
  );

  assert.ok(
    clearLog.some((entry) => Array.isArray(entry.ids) && entry.ids.includes(`moderation:form:${threadKey}:phone`)),
    'Перед финальным сообщением мастер должен очищать промежуточные шаги',
  );

  const finalStep = stepLog.at(-1);
  assert.ok(finalStep?.text.includes('План сохранён ✅'), 'Итоговое сообщение должно подтверждать сохранение плана');

  assert.equal(sentMessages.length, 1, 'После сохранения нужно публиковать карточку в теме');
  const postedMessage = sentMessages[0];
  assert.equal(postedMessage.chatId, 123, 'Карточка должна публиковаться в канале модерации');
  const replyMarkup = (postedMessage.options as { reply_markup?: { inline_keyboard?: unknown[] } }).reply_markup;
  assert.ok(replyMarkup, 'Карточка должна содержать клавиатуру быстрых действий');
  const inlineKeyboard = replyMarkup?.inline_keyboard as { text: string }[][] | undefined;
  assert.ok(inlineKeyboard, 'Структура клавиатуры должна соответствовать inline-кнопкам');
  assert.deepEqual(
    inlineKeyboard?.[0]?.map((button) => button.text),
    ['+7', '+15', '+30'],
    'Первая строка клавиатуры должна содержать кнопки продления',
  );
  assert.deepEqual(
    inlineKeyboard?.[1]?.map((button) => button.text),
    ['⛔', '🔕', '✏️'],
    'Вторая строка клавиатуры должна содержать кнопки блокировки, отключения уведомлений и редактирования',
  );

  assert.equal(replies.length, 0, 'Мастер не должен отправлять дополнительные сообщения через reply');

  console.log('form command wizard flow test: OK');
})();
