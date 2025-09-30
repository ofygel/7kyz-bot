import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import type { BotContext, ModerationPlanWizardState } from '../src/bot/types';
import type { ExecutorPlanInsertInput, ExecutorPlanRecord } from '../src/types';

const requireFn = createRequire(__filename);

const remindersModulePath = requireFn.resolve('../src/jobs/executorPlanReminders.ts');
const scheduledPlans: ExecutorPlanRecord[] = [];
let reminderQueueAvailable = true;
const reminderQueueWarningMessage = [
  '⚠️ Напоминания по планам исполнителей временно отключены.',
  'Redis недоступен или не настроен.',
  'Проверьте переменную окружения REDIS_URL и убедитесь, что Redis запущен.',
  'После восстановления подключения перезапустите бота, чтобы возобновить отправку напоминаний.',
].join('\n');

(requireFn.cache as Record<string, NodeModule | undefined>)[remindersModulePath] = {
  id: remindersModulePath,
  filename: remindersModulePath,
  loaded: true,
  exports: {
    scheduleExecutorPlanReminder: async (plan: ExecutorPlanRecord) => {
      if (!reminderQueueAvailable) {
        return;
      }

      scheduledPlans.push(plan);
    },
    cancelExecutorPlanReminders: async () => {},
    ensureExecutorPlanReminderQueue: () => reminderQueueAvailable,
    notifyExecutorPlanReminderQueueUnavailable: async (
      telegram: { sendMessage: (chatId: number, text: string, options: unknown) => Promise<unknown> } | null,
      chatId: number,
      threadId?: number | null,
    ) => {
      if (!telegram) {
        return;
      }

      await telegram.sendMessage(chatId, reminderQueueWarningMessage, {
        message_thread_id: threadId ?? undefined,
      });
    },
    EXECUTOR_PLAN_REMINDER_QUEUE_WARNING_MESSAGE: reminderQueueWarningMessage,
    __setReminderQueueAvailability: (value: boolean) => {
      reminderQueueAvailable = value;
    },
  },
} as unknown as NodeModule;

const remindersStub = ((requireFn.cache as Record<string, NodeModule | undefined>)[
  remindersModulePath
]?.exports ?? null) as {
  EXECUTOR_PLAN_REMINDER_QUEUE_WARNING_MESSAGE: string;
  __setReminderQueueAvailability: (value: boolean) => void;
} | null;

if (!remindersStub) {
  throw new Error('Failed to initialise reminders stub');
}

const queueModulePath = requireFn.resolve('../src/infra/executorPlanQueue.ts');

interface RecordedMutation {
  type: string;
  payload: unknown;
}

const processedMutations: RecordedMutation[] = [];
let latestPlan: ExecutorPlanRecord | null = null;
let activePlanByPhone: ExecutorPlanRecord | null = null;

(requireFn.cache as Record<string, NodeModule | undefined>)[queueModulePath] = {
  id: queueModulePath,
  filename: queueModulePath,
  loaded: true,
  exports: {
    enqueueExecutorPlanMutation: async () => {},
    flushExecutorPlanMutations: async () => {},
    processExecutorPlanMutation: async (mutation: { type: string; payload: unknown }) => {
      processedMutations.push({ type: mutation.type, payload: mutation.payload });
      if (mutation.type === 'create') {
        const payload = mutation.payload as ExecutorPlanInsertInput;
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
          cardChatId: payload.chatId,
          createdAt: new Date(),
          updatedAt: new Date(),
        } satisfies ExecutorPlanRecord;

        latestPlan = plan;
        return { type: 'created', plan } as const;
      }

      if (mutation.type === 'comment') {
        if (!latestPlan || latestPlan.id !== (mutation.payload as { id: number }).id) {
          return null;
        }

        const nextComment = (mutation.payload as { comment?: string }).comment;
        latestPlan = {
          ...latestPlan,
          comment: nextComment ?? undefined,
          updatedAt: new Date(),
        } satisfies ExecutorPlanRecord;

        return { type: 'updated', plan: latestPlan } as const;
      }

      return null;
    },
    onExecutorPlanMutation: () => {},
  },
} as unknown as NodeModule;

const executorPlansModulePath = requireFn.resolve('../src/db/executorPlans.ts');

(requireFn.cache as Record<string, NodeModule | undefined>)[executorPlansModulePath] = {
  id: executorPlansModulePath,
  filename: executorPlansModulePath,
  loaded: true,
  exports: {
    getExecutorPlanById: async (id: number) =>
      latestPlan && latestPlan.id === id ? latestPlan : null,
    findActiveExecutorPlanByPhone: async (phone: string) =>
      activePlanByPhone && activePlanByPhone.phone === phone ? activePlanByPhone : null,
    updateExecutorPlanCardMessage: async (
      id: number,
      cardMessageId: number,
      cardChatId: number | undefined,
    ) => {
      if (!latestPlan || latestPlan.id !== id) {
        return null;
      }

      latestPlan = {
        ...latestPlan,
        cardMessageId,
        cardChatId: cardChatId ?? latestPlan.cardChatId,
        updatedAt: new Date(),
      } satisfies ExecutorPlanRecord;

      return latestPlan;
    },
    __setActiveExecutorPlanByPhone: (plan: ExecutorPlanRecord | null) => {
      activePlanByPhone = plan;
    },
  },
} as unknown as NodeModule;

const executorPlansStub = ((requireFn.cache as Record<string, NodeModule | undefined>)[
  executorPlansModulePath
]?.exports ?? null) as { __setActiveExecutorPlanByPhone: (plan: ExecutorPlanRecord | null) => void } | null;

if (!executorPlansStub) {
  throw new Error('Failed to initialise executor plans stub');
}

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
process.env.SUPPORT_USERNAME = process.env.SUPPORT_USERNAME ?? 'test_support';
process.env.SUPPORT_URL = process.env.SUPPORT_URL ?? 'https://t.me/test_support';
process.env.WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN ?? 'example.com';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'secret';
process.env.SUB_TRIAL_DAYS = process.env.SUB_TRIAL_DAYS ?? '3';

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
    moderationPlans: { threads: {}, edits: {} },
    support: { status: 'idle' },
    onboarding: { active: false },
  } as unknown as BotContext['session'];

  const replies: string[] = [];
  const callbackAnswers: Array<{ text?: string; options?: unknown }> = [];
  const sentMessages: Array<{
    chatId: number;
    text: string;
    options: unknown;
    messageId: number;
  }> = [];

  const ctx = {
    chat: { id: 123, type: 'supergroup' },
    session,
    auth: {} as Record<string, unknown>,
    telegram: {
      sendMessage: async (chatId: number, text: string, options: unknown) => {
        const messageId = sentMessages.length + 1;
        sentMessages.push({ chatId, text, options, messageId });
        return { message_id: messageId, chat: { id: chatId } };
      },
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length };
    },
    answerCbQuery: async (text?: string, options?: unknown) => {
      callbackAnswers.push({ text, options });
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

  setMessage('123');
  assert.equal(await __testing.handleWizardTextMessage(ctx), true);
  assert.deepEqual(
    session.ephemeralMessages,
    [1],
    'Подсказка с ошибкой должна сохранять идентификатор для автоудаления',
  );
  assert.deepEqual(
    replies,
    ['Не удалось распознать номер. Используйте формат +77001234567.'],
    'При ошибке валидации телефона должна приходить подсказка',
  );
  replies.length = 0;
  session.ephemeralMessages.length = 0;

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

  const planSteps = stepLog.filter((step) => step.id === `moderation:form:${threadKey}:plan`);
  const planStepEntry = planSteps.at(-1);
  assert.ok(planStepEntry, 'Шаг выбора тарифа должен отображаться в интерфейсе');
  const planKeyboard = planStepEntry?.keyboard as
    | { inline_keyboard?: { text: string }[][] }
    | undefined;
  assert.ok(planKeyboard?.inline_keyboard, 'Клавиатура выбора тарифа должна быть доступна');
  const planButtonLabels = planKeyboard.inline_keyboard.map((row) =>
    row.map((button) => button.text),
  );
  assert.deepEqual(
    planButtonLabels,
    [
      [
        __testing.formatPlanChoiceLabel('trial'),
        __testing.formatPlanChoiceLabel('7'),
      ],
      [
        __testing.formatPlanChoiceLabel('15'),
        __testing.formatPlanChoiceLabel('30'),
      ],
    ],
    'Клавиатура выбора тарифа должна располагать варианты по две кнопки в ряд',
  );

  setMessage('15');
  assert.equal(await __testing.handleWizardTextMessage(ctx), true);
  assert.deepEqual(
    session.ephemeralMessages,
    [1],
    'Подсказка о выборе тарифа должна сохранять идентификатор для автоудаления',
  );
  assert.deepEqual(
    replies,
    ['Выберите тариф с помощью кнопок под сообщением.'],
    'При попытке отправить тариф текстом должна приходить подсказка',
  );
  replies.length = 0;
  session.ephemeralMessages.length = 0;

  await __testing.handlePlanSelection(ctx, threadKey, '15');
  wizardState = session.moderationPlans.threads[threadKey];
  assert.equal(wizardState?.planChoice, '15', 'Выбор тарифа должен сохраняться');
  assert.equal(wizardState?.step, 'details', 'После выбора тарифа запрашиваются дополнительные данные');
  assert.ok(
    callbackAnswers.some((entry) => entry.text === 'Выбран тариф: План на 15 дней'),
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
  assert.ok(
    summaryStep?.text.includes('Окончание:'),
    'Итоговое резюме должно содержать дату окончания плана',
  );

  await __testing.handleSummaryDecision(ctx, threadKey, 'confirm');

  assert.equal(processedMutations.length, 1, 'Создание плана должно вызывать мутацию очереди');
  assert.equal(processedMutations[0].type, 'create', 'Создание плана должно выполнять create-мутацию');
  const firstMutationPayload = processedMutations[0].payload as ExecutorPlanInsertInput;
  assert.equal(
    firstMutationPayload.phone,
    '+77001234567',
    'В мутацию должен передаваться нормализованный телефон',
  );
  assert.equal(
    firstMutationPayload.planChoice,
    '15',
    'В мутации должен использоваться выбранный тариф',
  );
  assert.ok(
    firstMutationPayload.endsAt,
    'В мутации должна передаваться вычисленная дата окончания',
  );
  assert.equal(
    firstMutationPayload.endsAt?.toISOString(),
    new Date(firstMutationPayload.startAt.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    'Дата окончания должна вычисляться на основе тарифа',
  );
  assert.equal(
    firstMutationPayload.comment,
    'Комментарий',
    'В мутации должен передаваться введённый комментарий',
  );
  assert.equal(
    firstMutationPayload.threadId,
    threadId,
    'Мутация должна помнить исходный идентификатор ветки',
  );

  assert.equal(scheduledPlans.length, 1, 'После сохранения плана должен планироваться напоминатель');
  assert.equal(
    scheduledPlans[0].planChoice,
    '15',
    'В запланированном плане должен сохраняться выбранный тариф',
  );

  assert.equal(
    callbackAnswers.at(-1)?.text,
    'План сохранён',
    'Подтверждение должно сообщать об успешном создании',
  );
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
  assert.equal(
    latestPlan?.cardMessageId,
    postedMessage.messageId,
    'Идентификатор карточки должен сохраняться в записи плана',
  );
  const { getExecutorPlanById } = await import('../src/db/executorPlans');
  const persistedPlan = await getExecutorPlanById(latestPlan?.id ?? 0);
  assert.equal(
    persistedPlan?.cardMessageId,
    postedMessage.messageId,
    'Идентификатор карточки должен считываться из базы',
  );
  assert.equal(
    persistedPlan?.cardChatId,
    postedMessage.chatId,
    'Чат публикации карточки должен сохраняться в записи плана',
  );
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

  if (!latestPlan) {
    throw new Error('latestPlan is not initialised after plan creation');
  }

  const existingPlan = latestPlan as ExecutorPlanRecord;

  executorPlansStub.__setActiveExecutorPlanByPhone(existingPlan);

  await __testing.startWizard(ctx, threadKey, threadId);

  setMessage('+77001234567');
  assert.equal(await __testing.handleWizardTextMessage(ctx), true);

  setMessage('-');
  assert.equal(await __testing.handleWizardTextMessage(ctx), true);

  await __testing.handlePlanSelection(ctx, threadKey, '7');

  setMessage('2024-03-01\nПовторный комментарий');
  assert.equal(await __testing.handleWizardTextMessage(ctx), true);

  const duplicateMutationCount = processedMutations.length;
  const duplicateStepCount = stepLog.length;

  await __testing.handleSummaryDecision(ctx, threadKey, 'confirm');

  assert.equal(
    processedMutations.length,
    duplicateMutationCount,
    'При обнаружении дубля новая мутация не должна создаваться',
  );

  const duplicateCallbackAnswer = callbackAnswers.at(-1);
  assert.equal(
    duplicateCallbackAnswer?.text,
    'План с этим номером уже существует',
    'При дубле пользователь должен получать предупреждение',
  );
  assert.deepEqual(
    duplicateCallbackAnswer?.options,
    { show_alert: true },
    'Предупреждение о дубле должно показываться через alert',
  );

  const duplicateSummaryStep = stepLog
    .slice(duplicateStepCount)
    .find((step) => step.id === `moderation:form:${threadKey}:summary`);
  assert.ok(
    duplicateSummaryStep,
    'При дубле должен обновляться итоговый шаг с резюме текущего плана',
  );
  assert.ok(
    duplicateSummaryStep?.text.includes('Для этого номера уже есть активный план.'),
    'Текст предупреждения должен сообщать о существующем плане',
  );
  assert.ok(
    duplicateSummaryStep?.text.includes('Обновите комментарий или продлите текущий план'),
    'Текст предупреждения должен предлагать обновить или продлить текущий план',
  );
  assert.ok(
    duplicateSummaryStep?.text.includes(`ID плана: ${existingPlan.id}`),
    'Резюме дубля должно содержать информацию о существующем плане',
  );

  const duplicateWizardState = session.moderationPlans.threads[
    threadKey
  ] as ModerationPlanWizardState | undefined;
  assert.equal(
    duplicateWizardState?.step,
    'summary',
    'После предупреждения о дубле мастер должен оставаться на шаге подтверждения',
  );

  executorPlansStub.__setActiveExecutorPlanByPhone(null);

  console.log('form command duplicate prevention test: OK');

  remindersStub.__setReminderQueueAvailability(false);

  const previousLatestPlan = latestPlan;
  const previousMutationCount = processedMutations.length;

  const missingRedisThreadId = 13337;
  const missingRedisThreadKey = __testing.getThreadKey(missingRedisThreadId);

  const missingRedisSession = {
    ephemeralMessages: [],
    isAuthenticated: false,
    safeMode: false,
    isDegraded: false,
    awaitingPhone: false,
    authSnapshot: {} as Record<string, unknown>,
    executor: {} as Record<string, unknown>,
    client: {} as Record<string, unknown>,
    ui: { steps: {}, homeActions: [] },
    moderationPlans: {
      threads: {
        [missingRedisThreadKey]: {
          step: 'summary',
          threadId: missingRedisThreadId,
          phone: '+77001234567',
          planChoice: '7',
          startAt: new Date(),
        },
      },
      edits: {},
    },
    support: { status: 'idle' },
    onboarding: { active: false },
  } as unknown as BotContext['session'];

  const missingRedisReplies: string[] = [];
  const missingRedisCallbackAnswers: Array<{ text?: string; options?: unknown }> = [];
  const missingRedisSentMessages: Array<{ chatId: number; text: string; options: unknown }> = [];

  const missingRedisCtx = {
    chat: { id: 123, type: 'supergroup' },
    session: missingRedisSession,
    auth: {} as Record<string, unknown>,
    telegram: {
      sendMessage: async (chatId: number, text: string, options: unknown) => {
        missingRedisSentMessages.push({ chatId, text, options });
        return { message_id: missingRedisSentMessages.length };
      },
    },
    reply: async (text: string) => {
      missingRedisReplies.push(text);
      return { message_id: missingRedisReplies.length };
    },
    answerCbQuery: async (text?: string, options?: unknown) => {
      missingRedisCallbackAnswers.push({ text, options });
    },
  } as unknown as BotContext;

  await __testing.handleSummaryDecision(missingRedisCtx, missingRedisThreadKey, 'confirm');

  assert.ok(
    missingRedisCallbackAnswers.some((entry) => entry.text === 'План сохранён'),
    'При отключённом Redis подтверждение должно отправляться пользователю',
  );

  const reminderWarningMessage = missingRedisSentMessages.find(
    (entry) => entry.text === remindersStub.EXECUTOR_PLAN_REMINDER_QUEUE_WARNING_MESSAGE,
  );
  assert.ok(
    reminderWarningMessage,
    'При отключённом Redis в модераторский чат должно отправляться предупреждение',
  );
  assert.deepEqual(
    reminderWarningMessage?.options,
    { message_thread_id: missingRedisThreadId },
    'Предупреждение должно публиковаться в той же ветке модераторского чата',
  );

  assert.equal(
    scheduledPlans.length,
    1,
    'При отключённом Redis напоминание не должно планироваться',
  );

  remindersStub.__setReminderQueueAvailability(true);
  processedMutations.length = previousMutationCount;
  latestPlan = previousLatestPlan;

  if (!latestPlan) {
    throw new Error('latestPlan is not initialised');
  }

  const planForEdit = latestPlan as ExecutorPlanRecord;

  const editSession = {
    ephemeralMessages: [],
    isAuthenticated: false,
    safeMode: false,
    isDegraded: false,
    awaitingPhone: false,
    authSnapshot: {} as Record<string, unknown>,
    executor: {} as Record<string, unknown>,
    client: {} as Record<string, unknown>,
    ui: { steps: {}, homeActions: [] },
    moderationPlans: { threads: {}, edits: {} },
    support: { status: 'idle' },
    onboarding: { active: false },
  } as unknown as BotContext['session'];

  const editCallbackAnswers: Array<{ text?: string; options?: unknown }> = [];
  const editedMessages: Array<{ chatId: number; messageId: number; text: string; options: unknown }> = [];

  const editThreadId = planForEdit.threadId ?? threadId;
  const editThreadKey = __testing.getThreadKey(editThreadId);

  const editCtx = {
    chat: { id: planForEdit.chatId, type: 'supergroup' },
    session: editSession,
    auth: {} as Record<string, unknown>,
    telegram: {
      editMessageText: async (
        chatId: number,
        messageId: number,
        _inlineMessageId: unknown,
        text: string,
        options: unknown,
      ) => {
        editedMessages.push({ chatId, messageId, text, options });
        return { message_id: messageId };
      },
    },
    reply: async () => ({ message_id: 1 }),
    answerCbQuery: async (text?: string, options?: unknown) => {
      editCallbackAnswers.push({ text, options });
    },
  } as unknown as BotContext;

  (editCtx as { callbackQuery?: unknown }).callbackQuery = {
    id: 'edit',
    message: {
      message_id: 901,
      message_thread_id: editThreadId,
      chat: { id: planForEdit.chatId },
    },
  };

  const initialEditStepCount = stepLog.length;

  await __testing.handleEditCallback(editCtx, planForEdit.id);

  const editState = editSession.moderationPlans.edits[editThreadKey];
  assert.ok(editState, 'После нажатия ✏️ должно сохраняться состояние редактирования');
  assert.equal(editState?.planId, planForEdit.id, 'Состояние редактирования должно помнить план');
  assert.equal(editState?.messageId, 901, 'Состояние редактирования должно запоминать сообщение карточки');

  const editPromptStep = stepLog
    .slice(initialEditStepCount)
    .find((step) => step.id === `moderation:form:${editThreadKey}:edit`);
  assert.ok(editPromptStep, 'Редактирование должно открывать отдельный шаг');
  assert.ok(
    editPromptStep?.text.includes('Отправьте новый текст следующим сообщением.'),
    'Шаг редактирования должен содержать инструкцию по вводу комментария',
  );
  assert.equal(
    editCallbackAnswers.at(-1)?.text,
    'Введите новый комментарий',
    'Ответ на callback должен приглашать ввести новый комментарий',
  );

  delete (editCtx as { callbackQuery?: unknown }).callbackQuery;
  (editCtx as { message?: unknown }).message = {
    message_thread_id: editThreadId,
    text: 'Новый комментарий',
  };

  const handledEdit = await __testing.handlePlanEditTextMessage(editCtx);
  assert.equal(handledEdit, true, 'Текст после открытия шага должен обрабатываться редактированием');

  const lastMutation = processedMutations.at(-1);
  assert.equal(lastMutation?.type, 'comment', 'Редактирование должно отправлять мутацию комментария');

  assert.equal(
    editSession.moderationPlans.edits[editThreadKey],
    undefined,
    'После успешного редактирования состояние должно очищаться',
  );
  assert.ok(editedMessages.length > 0, 'Редактирование должно обновлять карточку плана');
  const editedCard = editedMessages.at(-1);
  assert.equal(editedCard?.chatId, planForEdit.chatId, 'Обновление карточки должно выполняться в исходном чате');
  assert.ok(
    editedCard?.text.includes('Новый комментарий'),
    'Текст карточки после обновления должен содержать новый комментарий',
  );

  const editSteps = stepLog.filter((step) => step.id === `moderation:form:${editThreadKey}:edit`);
  const lastEditStep = editSteps.at(-1);
  assert.ok(lastEditStep?.text.includes('Комментарий обновлён ✅'), 'Шаг редактирования должен подтверждать обновление');
  assert.ok(
    lastEditStep?.text.includes('Новый комментарий: Новый комментарий'),
    'Шаг редактирования должен отображать новый комментарий',
  );

  assert.equal(
    (latestPlan as ExecutorPlanRecord | null)?.comment,
    'Новый комментарий',
    'Стабы очереди должны обновлять сохранённый план',
  );

  console.log('form command edit callback flow test: OK');

  const channelThreadId = 777;
  const channelThreadKey = __testing.getThreadKey(channelThreadId);

  const channelSession = {
    ephemeralMessages: [],
    isAuthenticated: false,
    safeMode: false,
    isDegraded: false,
    awaitingPhone: false,
    authSnapshot: {} as Record<string, unknown>,
    executor: {} as Record<string, unknown>,
    client: {} as Record<string, unknown>,
    ui: { steps: {}, homeActions: [] },
    moderationPlans: { threads: {}, edits: {} },
    support: { status: 'idle' },
    onboarding: { active: false },
  } as unknown as BotContext['session'];

  const channelReplies: string[] = [];

  const channelCtx = {
    chat: { id: 123, type: 'supergroup' },
    session: channelSession,
    auth: {} as Record<string, unknown>,
    telegram: {
      sendMessage: async () => ({ message_id: 1 }),
    },
    reply: async (text: string) => {
      channelReplies.push(text);
      return { message_id: channelReplies.length };
    },
  } as unknown as BotContext;

  const setChannelPost = (text: string) => {
    delete (channelCtx as { message?: unknown }).message;
    (channelCtx as { channelPost?: unknown }).channelPost = {
      message_thread_id: channelThreadId,
      text,
    };
  };

  await __testing.startWizard(channelCtx, channelThreadKey, channelThreadId);

  let channelWizardState = channelSession.moderationPlans.threads[channelThreadKey];
  assert.ok(channelWizardState, 'Состояние мастера должно создаваться для channel_post');
  assert.equal(
    channelWizardState?.step,
    'phone',
    'Первый шаг мастера при channel_post — ввод телефона',
  );

  setChannelPost('+7 (700) 123-45-67');
  assert.equal(await __testing.handleWizardTextMessage(channelCtx), true);

  channelWizardState = channelSession.moderationPlans.threads[channelThreadKey];
  assert.equal(
    channelWizardState?.phone,
    '+77001234567',
    'Телефон должен нормализоваться при channel_post',
  );
  assert.equal(
    channelWizardState?.step,
    'nickname',
    'После channel_post с телефоном ожидается ник',
  );

  setChannelPost('@executor');
  assert.equal(await __testing.handleWizardTextMessage(channelCtx), true);

  channelWizardState = channelSession.moderationPlans.threads[channelThreadKey];
  assert.equal(channelWizardState?.nickname, '@executor', 'Ник должен сохраняться при channel_post');
  assert.equal(
    channelWizardState?.step,
    'plan',
    'После ника при channel_post бот должен ожидать выбор тарифа',
  );

  console.log('form command wizard channel_post flow test: OK');

  const missingChatThreadId = 2024;
  const missingChatThreadKey = __testing.getThreadKey(missingChatThreadId);

  const missingChatSession = {
    ephemeralMessages: [],
    isAuthenticated: false,
    safeMode: false,
    isDegraded: false,
    awaitingPhone: false,
    authSnapshot: {} as Record<string, unknown>,
    executor: {} as Record<string, unknown>,
    client: {} as Record<string, unknown>,
    ui: { steps: {}, homeActions: [] },
    moderationPlans: {
      threads: {
        [missingChatThreadKey]: {
          step: 'summary',
          threadId: missingChatThreadId,
          phone: '+77001234567',
          planChoice: '7',
          startAt: new Date(),
        },
      },
      edits: {},
    },
    support: { status: 'idle' },
    onboarding: { active: false },
  } as unknown as BotContext['session'];

  const missingChatReplies: string[] = [];
  const missingChatCallbackAnswers: Array<{ text?: string; options?: unknown }> = [];
  const missingChatSentMessages: Array<{ chatId: number }> = [];

  const missingChatCtx = {
    session: missingChatSession,
    auth: {} as Record<string, unknown>,
    telegram: {
      sendMessage: async (chatId: number) => {
        missingChatSentMessages.push({ chatId });
        return { message_id: missingChatSentMessages.length };
      },
    },
    reply: async (text: string) => {
      missingChatReplies.push(text);
      return { message_id: missingChatReplies.length };
    },
    answerCbQuery: async (text?: string, options?: unknown) => {
      missingChatCallbackAnswers.push({ text, options });
    },
  } as unknown as BotContext;

  const mutationCountBefore = processedMutations.length;

  await __testing.handleSummaryDecision(missingChatCtx, missingChatThreadKey, 'confirm');

  assert.equal(
    processedMutations.length,
    mutationCountBefore,
    'При отсутствии chatId мутация плана не должна выполняться',
  );
  assert.equal(
    missingChatSentMessages.length,
    0,
    'При отсутствии chatId карточка плана не должна отправляться',
  );

  const missingChatAnswer = missingChatCallbackAnswers.find(
    (entry) => entry.text === 'Не удалось определить чат для публикации плана',
  );
  assert.ok(
    missingChatAnswer,
    'При отсутствии chatId должен возвращаться ответ о невозможности определить чат',
  );
  assert.deepEqual(
    missingChatAnswer?.options,
    { show_alert: true },
    'Ответ на callback должен отображать alert',
  );
  assert.equal(
    missingChatReplies.length,
    0,
    'При наличии answerCbQuery не должно быть дополнительного ответа через reply',
  );
})();

void (async () => {
  const { __testing } = await import('../src/bot/channels/commands/form');

  const trialThreadId = 999;
  const trialThreadKey = __testing.getThreadKey(trialThreadId);

  const trialSession = {
    ephemeralMessages: [],
    isAuthenticated: false,
    safeMode: false,
    isDegraded: false,
    awaitingPhone: false,
    authSnapshot: {} as Record<string, unknown>,
    executor: {} as Record<string, unknown>,
    client: {} as Record<string, unknown>,
    ui: { steps: {}, homeActions: [] },
    moderationPlans: {
      threads: {
        [trialThreadKey]: {
          step: 'plan',
          threadId: trialThreadId,
          phone: '+77001234567',
        },
      },
      edits: {},
    },
    support: { status: 'idle' },
    onboarding: { active: false },
  } as unknown as BotContext['session'];

  const trialCallbackAnswers: string[] = [];

  const trialCtx = {
    chat: { id: 456, type: 'supergroup' },
    session: trialSession,
    auth: {} as Record<string, unknown>,
    telegram: {
      sendMessage: async () => ({ message_id: 1 }),
    },
    answerCbQuery: async (text?: string) => {
      trialCallbackAnswers.push(text ?? '');
    },
  } as unknown as BotContext;

  await __testing.handlePlanSelection(trialCtx, trialThreadKey, 'trial');

  const trialState = trialSession.moderationPlans.threads[trialThreadKey];
  assert.equal(
    trialState?.planChoice,
    'trial',
    'Выбор пробного тарифа должен сохраняться в состоянии мастера',
  );
  assert.equal(
    trialState?.step,
    'details',
    'После выбора пробного тарифа мастер должен переходить к заполнению деталей',
  );

  const trialLabel = __testing.formatPlanChoiceLabel('trial');
  assert.ok(
    trialCallbackAnswers.includes(`Выбран тариф: ${trialLabel}`),
    'Ответ на callback с пробным тарифом должен подтверждать выбор',
  );

  console.log('form command trial plan selection test: OK');
})();

void (async () => {
  const { __testing } = await import('../src/bot/channels/commands/form');

  const ctx = {
    channelPost: {
      text: '/block 123 Причина блокировки',
    },
  } as unknown as BotContext;

  const args = __testing.parseArgs(ctx);

  assert.deepEqual(
    args,
    ['123', 'Причина', 'блокировки'],
    'parseArgs должен корректно разбирать аргументы из channel_post',
  );

  console.log('form command parseArgs channel_post test: OK');
})();
