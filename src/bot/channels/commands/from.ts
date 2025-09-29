import { Telegraf } from 'telegraf';

import type { BotContext, ModerationPlanWizardState } from '../../types';
import { config, logger } from '../../../config';
import type {
  ExecutorPlanChoice,
  ExecutorPlanInsertInput,
  ExecutorPlanRecord,
} from '../../../types';
import {
  cancelExecutorPlanReminders,
  scheduleExecutorPlanReminder,
} from '../../../jobs/executorPlanReminders';
import {
  enqueueExecutorPlanMutation,
  flushExecutorPlanMutations,
  processExecutorPlanMutation,
  type ExecutorPlanMutation,
  type ExecutorPlanMutationOutcome,
} from '../../../infra/executorPlanQueue';
import { buildPlanSummary } from '../../../services/executorPlans/reminders';
import {
  EXECUTOR_PLAN_BLOCK_ACTION,
  EXECUTOR_PLAN_EDIT_ACTION,
  EXECUTOR_PLAN_EXTEND_ACTION,
  EXECUTOR_PLAN_TOGGLE_MUTE_ACTION,
  EXECUTOR_PLAN_UNBLOCK_ACTION,
} from '../../../services/executorPlans/actions';
import { getExecutorPlanById } from '../../../db/executorPlans';
import { ui } from '../../ui';
import { buildInlineKeyboard, buildConfirmCancelKeyboard } from '../../keyboards/common';
import { wrapCallbackData } from '../../services/callbackTokens';
import { buildExecutorPlanActionKeyboard } from '../../ui/executorPlans';

const VERIFY_COMMANDS = ['from', 'form'] as const;

const EXTEND_CALLBACK_PATTERN = new RegExp(
  `^${EXECUTOR_PLAN_EXTEND_ACTION}:(\\d+):(\\d+)$`,
);
const BLOCK_CALLBACK_PATTERN = new RegExp(
  `^${EXECUTOR_PLAN_BLOCK_ACTION}:(\\d+)$`,
);
const UNBLOCK_CALLBACK_PATTERN = new RegExp(
  `^${EXECUTOR_PLAN_UNBLOCK_ACTION}:(\\d+)$`,
);
const TOGGLE_MUTE_CALLBACK_PATTERN = new RegExp(
  `^${EXECUTOR_PLAN_TOGGLE_MUTE_ACTION}:(\\d+)$`,
);
const EDIT_CALLBACK_PATTERN = new RegExp(
  `^${EXECUTOR_PLAN_EDIT_ACTION}:(\\d+)$`,
);

const MONTHS: Record<string, number> = {
  янв: 0,
  фев: 1,
  мар: 2,
  апр: 3,
  май: 4,
  июн: 5,
  июл: 6,
  авг: 7,
  сен: 8,
  окт: 9,
  ноя: 10,
  дек: 11,
};

const PLAN_VALUES: ExecutorPlanChoice[] = ['7', '15', '30'];

const CALLBACK_TTL_SECONDS = 7 * 24 * 60 * 60;
const WIZARD_ACTION_PREFIX = 'executor-plan-wizard';
const PLAN_SELECT_ACTION = `${WIZARD_ACTION_PREFIX}:plan`;
const SUMMARY_CONFIRM_ACTION = `${WIZARD_ACTION_PREFIX}:confirm`;
const SUMMARY_CANCEL_ACTION = `${WIZARD_ACTION_PREFIX}:cancel`;

const PLAN_SELECT_CALLBACK_PATTERN = new RegExp(
  `^${PLAN_SELECT_ACTION}:(7|15|30)$`,
);
const SUMMARY_CONFIRM_CALLBACK_PATTERN = new RegExp(
  `^${SUMMARY_CONFIRM_ACTION}$`,
);
const SUMMARY_CANCEL_CALLBACK_PATTERN = new RegExp(
  `^${SUMMARY_CANCEL_ACTION}$`,
);

const PLAN_CHOICE_LABELS: Record<ExecutorPlanChoice, string> = {
  '7': 'План на 7 дней',
  '15': 'План на 15 дней',
  '30': 'План на 30 дней',
};

const sanitisePhone = (value: string): string | null => {
  const cleaned = value.replace(/[^\d+]/g, '');
  if (!cleaned) {
    return null;
  }

  if (cleaned.startsWith('+')) {
    return cleaned;
  }

  if (cleaned.startsWith('8') && cleaned.length === 11) {
    return `+7${cleaned.slice(1)}`;
  }

  if (cleaned.length >= 10) {
    return `+${cleaned}`;
  }

  return null;
};

const parseMonthName = (token: string): number | null => {
  const key = token.slice(0, 3).toLowerCase();
  return key in MONTHS ? MONTHS[key] : null;
};

const createDateAtUtc = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month, day, 6, 0, 0));

const parseStartDate = (value: string): Date | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const isoMatch = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoMatch) {
    const [, yearRaw, monthRaw, dayRaw] = isoMatch;
    const year = Number.parseInt(yearRaw, 10);
    const month = Number.parseInt(monthRaw, 10) - 1;
    const day = Number.parseInt(dayRaw, 10);
    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      return createDateAtUtc(year, month, day);
    }
  }

  const dottedMatch = trimmed.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/);
  if (dottedMatch) {
    const [, dayRaw, monthRaw, yearRaw] = dottedMatch;
    const now = new Date();
    const year = yearRaw ? Number.parseInt(yearRaw, 10) : now.getUTCFullYear();
    const month = Number.parseInt(monthRaw, 10) - 1;
    const day = Number.parseInt(dayRaw, 10);
    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      const normalisedYear = year < 100 ? 2000 + year : year;
      return createDateAtUtc(normalisedYear, month, day);
    }
  }

  const wordsMatch = trimmed.match(/^(\d{1,2})\s+([\p{L}]+)/u);
  if (wordsMatch) {
    const [, dayRaw, monthWord] = wordsMatch;
    const now = new Date();
    const day = Number.parseInt(dayRaw, 10);
    const month = parseMonthName(monthWord);
    if (Number.isFinite(day) && month !== null) {
      return createDateAtUtc(now.getUTCFullYear(), month, day);
    }
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  return null;
};

const ensureVerifyChannel = (ctx: BotContext): boolean => {
  const expectedId = config.channels.bindVerifyChannelId;
  if (!expectedId) {
    return true;
  }

  const chatId = ctx.chat?.id;
  if (chatId !== expectedId) {
    void ctx.reply('Эта команда доступна только в канале модерации.');
    return false;
  }

  return true;
};

const formatPlanChoiceLabel = (choice: ExecutorPlanChoice): string =>
  PLAN_CHOICE_LABELS[choice] ?? `План ${choice} дней`;

const ensureModerationPlansState = (ctx: BotContext): void => {
  if (!ctx.session.moderationPlans) {
    ctx.session.moderationPlans = { threads: {} };
    return;
  }

  if (!ctx.session.moderationPlans.threads) {
    ctx.session.moderationPlans.threads = {};
  }
};

const getThreadIdFromContext = (ctx: BotContext): number | undefined => {
  const message = ctx.message;
  if (message && typeof message === 'object' && 'message_thread_id' in message) {
    const threadId = (message as { message_thread_id?: number }).message_thread_id;
    if (typeof threadId === 'number') {
      return threadId;
    }
  }

  const callbackMessage =
    ctx.callbackQuery && 'message' in ctx.callbackQuery
      ? ctx.callbackQuery.message
      : undefined;
  if (callbackMessage && typeof callbackMessage === 'object' && 'message_thread_id' in callbackMessage) {
    const threadId = (callbackMessage as { message_thread_id?: number }).message_thread_id;
    if (typeof threadId === 'number') {
      return threadId;
    }
  }

  return undefined;
};

const getThreadKey = (threadId: number | undefined): string =>
  `thread:${threadId ?? 0}`;

const getWizardState = (
  ctx: BotContext,
  threadKey: string,
): ModerationPlanWizardState | undefined => {
  ensureModerationPlansState(ctx);
  return ctx.session.moderationPlans.threads[threadKey];
};

const setWizardState = (
  ctx: BotContext,
  threadKey: string,
  state: ModerationPlanWizardState | undefined,
): void => {
  ensureModerationPlansState(ctx);
  if (!state) {
    delete ctx.session.moderationPlans.threads[threadKey];
    return;
  }

  ctx.session.moderationPlans.threads[threadKey] = state;
};

const buildWizardStepId = (threadKey: string, step: string): string =>
  `moderation:from:${threadKey}:${step}`;

const getWizardStepIds = (threadKey: string): string[] => [
  buildWizardStepId(threadKey, 'phone'),
  buildWizardStepId(threadKey, 'nickname'),
  buildWizardStepId(threadKey, 'plan'),
  buildWizardStepId(threadKey, 'details'),
  buildWizardStepId(threadKey, 'summary'),
];

const clearWizardSteps = async (
  ctx: BotContext,
  threadKey: string,
  options: { keepSummary?: boolean } = {},
): Promise<void> => {
  const ids = getWizardStepIds(threadKey);
  const targetIds = options.keepSummary ? ids.slice(0, -1) : ids;
  if (targetIds.length === 0) {
    return;
  }

  await ui.clear(ctx, { ids: targetIds, cleanupOnly: false });
};

const formatDate = (value: Date): string =>
  new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeZone: config.timezone,
  }).format(value);

const formatDateTime = (value: Date): string =>
  new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: config.timezone,
  }).format(value);

const buildPlanChoiceKeyboard = (): ReturnType<typeof buildInlineKeyboard> => {
  const secret = config.bot.callbackSignSecret ?? config.bot.token;
  const rows = [
    PLAN_VALUES.map((choice) => ({
      label: PLAN_CHOICE_LABELS[choice],
      action: wrapCallbackData(`${PLAN_SELECT_ACTION}:${choice}`, {
        secret,
        ttlSeconds: CALLBACK_TTL_SECONDS,
      }),
    })),
  ];

  return buildInlineKeyboard(rows);
};

const renderPhoneStep = async (
  ctx: BotContext,
  threadKey: string,
  state: ModerationPlanWizardState,
): Promise<void> => {
  const lines = state.phone
    ? [
        `✅ Телефон сохранён: ${state.phone}`,
        '',
        'Чтобы изменить, отправьте новый номер телефона.',
      ]
    : [
        '📞 Введите номер телефона исполнителя.',
        'Например: +77001234567.',
      ];

  await ui.step(ctx, {
    id: buildWizardStepId(threadKey, 'phone'),
    text: lines.join('\n'),
    messageThreadId: state.threadId,
  });
};

const renderNicknameStep = async (
  ctx: BotContext,
  threadKey: string,
  state: ModerationPlanWizardState,
): Promise<void> => {
  const lines = state.nickname
    ? [
        `✅ Ник/ID сохранён: ${state.nickname}`,
        '',
        'Чтобы очистить поле, отправьте «-».',
      ]
    : [
        '👤 Укажите ник или ID исполнителя.',
        'Если данных нет, отправьте «-».',
      ];

  await ui.step(ctx, {
    id: buildWizardStepId(threadKey, 'nickname'),
    text: lines.join('\n'),
    messageThreadId: state.threadId,
  });
};

const renderPlanStep = async (
  ctx: BotContext,
  threadKey: string,
  state: ModerationPlanWizardState,
): Promise<void> => {
  const lines = state.planChoice
    ? [
        `✅ Выбран тариф: ${formatPlanChoiceLabel(state.planChoice)}.`,
        '',
        'Можно выбрать другой вариант кнопками ниже.',
      ]
    : [
        '📦 Выберите тариф плана.',
        'Нажмите на одну из кнопок ниже.',
      ];

  await ui.step(ctx, {
    id: buildWizardStepId(threadKey, 'plan'),
    text: lines.join('\n'),
    keyboard: buildPlanChoiceKeyboard(),
    messageThreadId: state.threadId,
  });
};

const renderDetailsStep = async (
  ctx: BotContext,
  threadKey: string,
  state: ModerationPlanWizardState,
): Promise<void> => {
  const lines: string[] = [];
  if (state.startAt || state.comment) {
    lines.push('✅ Дополнительные данные сохранены.');
    if (state.startAt) {
      lines.push(`Дата старта: ${formatDate(state.startAt)}`);
    }
    if (state.comment) {
      lines.push(`Комментарий: ${state.comment}`);
    }
    lines.push('', 'Чтобы изменить данные, отправьте новое сообщение или «-» для сброса.');
  } else {
    lines.push('📝 При необходимости укажите дату старта и комментарий.');
    lines.push('Можно отправить дату отдельной строкой или вместе с комментарием.');
    lines.push('Например: 2024-02-01', 'или: 2024-02-01 Комментарий');
    lines.push('Отправьте «-», чтобы пропустить шаг.');
  }

  await ui.step(ctx, {
    id: buildWizardStepId(threadKey, 'details'),
    text: lines.join('\n'),
    messageThreadId: state.threadId,
  });
};

const renderSummaryStep = async (
  ctx: BotContext,
  threadKey: string,
  state: ModerationPlanWizardState,
): Promise<void> => {
  if (!state.phone || !state.planChoice) {
    return;
  }

  const startAt = state.startAt ?? new Date();
  state.startAt = startAt;

  const lines = [
    '📋 Проверьте данные плана:',
    `Телефон: ${state.phone}`,
  ];

  if (state.nickname) {
    lines.push(`Ник/ID: ${state.nickname}`);
  }

  lines.push(`Тариф: ${formatPlanChoiceLabel(state.planChoice)}`);
  lines.push(`Старт: ${formatDateTime(startAt)}`);
  lines.push(`Комментарий: ${state.comment ?? '—'}`);
  lines.push('', 'Нажмите «Сохранить», чтобы создать запись, или «Отмена», чтобы сбросить форму.');

  const secret = config.bot.callbackSignSecret ?? config.bot.token;
  const keyboard = buildConfirmCancelKeyboard(
    wrapCallbackData(SUMMARY_CONFIRM_ACTION, {
      secret,
      ttlSeconds: CALLBACK_TTL_SECONDS,
    }),
    wrapCallbackData(SUMMARY_CANCEL_ACTION, {
      secret,
      ttlSeconds: CALLBACK_TTL_SECONDS,
    }),
    { confirmLabel: '✅ Сохранить', cancelLabel: '❌ Отмена', layout: 'horizontal' },
  );

  await ui.step(ctx, {
    id: buildWizardStepId(threadKey, 'summary'),
    text: lines.join('\n'),
    keyboard,
    messageThreadId: state.threadId,
  });
};

interface WizardDetailsResult {
  skip: boolean;
  startAt?: Date;
  comment?: string;
}

const parseWizardDetailsInput = (value: string): WizardDetailsResult => {
  const trimmed = value.trim();
  if (!trimmed) {
    return { skip: true };
  }

  const lower = trimmed.toLowerCase();
  if (lower === '-' || lower === 'нет') {
    return { skip: true };
  }

  const lines = trimmed.split(/\r?\n/u);
  const firstLine = lines[0]?.trim() ?? '';
  const firstLineDate = firstLine ? parseStartDate(firstLine) : null;
  if (firstLineDate) {
    const comment = lines.slice(1).join('\n').trim();
    return {
      skip: false,
      startAt: firstLineDate,
      comment: comment.length > 0 ? comment : undefined,
    } satisfies WizardDetailsResult;
  }

  const tokens = trimmed.split(/\s+/u);
  const firstToken = tokens[0] ?? '';
  const tokenDate = firstToken ? parseStartDate(firstToken) : null;
  if (tokenDate) {
    const remainder = trimmed.slice(firstToken.length).trim();
    return {
      skip: false,
      startAt: tokenDate,
      comment: remainder.length > 0 ? remainder : undefined,
    } satisfies WizardDetailsResult;
  }

  const inlineDate = parseStartDate(trimmed);
  if (inlineDate) {
    return { skip: false, startAt: inlineDate } satisfies WizardDetailsResult;
  }

  return { skip: false, comment: trimmed } satisfies WizardDetailsResult;
};

const buildPlanInputFromState = (
  ctx: BotContext,
  state: ModerationPlanWizardState,
): ExecutorPlanInsertInput | null => {
  if (!state.phone || !state.planChoice) {
    return null;
  }

  const startAt = state.startAt ?? new Date();
  const chatId = ctx.chat?.id ?? config.channels.bindVerifyChannelId ?? 0;

  return {
    chatId,
    threadId: state.threadId,
    phone: state.phone,
    nickname: state.nickname,
    planChoice: state.planChoice,
    startAt,
    comment: state.comment?.trim() || undefined,
  } satisfies ExecutorPlanInsertInput;
};

const startWizard = async (
  ctx: BotContext,
  threadKey: string,
  threadId: number | undefined,
): Promise<void> => {
  await clearWizardSteps(ctx, threadKey);
  const state: ModerationPlanWizardState = { step: 'phone', threadId };
  setWizardState(ctx, threadKey, state);
  await renderPhoneStep(ctx, threadKey, state);
};

const handleWizardTextMessage = async (ctx: BotContext): Promise<boolean> => {
  const expectedId = config.channels.bindVerifyChannelId;
  if (expectedId && ctx.chat?.id !== expectedId) {
    return false;
  }

  const message = ctx.message;
  if (!message || typeof message !== 'object' || !('text' in message)) {
    return false;
  }

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text || text.startsWith('/')) {
    return false;
  }

  const threadId = 'message_thread_id' in message ? message.message_thread_id : undefined;
  const threadKey = getThreadKey(typeof threadId === 'number' ? threadId : undefined);
  const state = getWizardState(ctx, threadKey);
  if (!state) {
    return false;
  }

  switch (state.step) {
    case 'phone': {
      const phone = sanitisePhone(text);
      if (!phone) {
        await ctx.reply('Не удалось распознать номер. Используйте формат +77001234567.');
        return true;
      }

      state.phone = phone;
      state.step = 'nickname';
      await renderPhoneStep(ctx, threadKey, state);
      await renderNicknameStep(ctx, threadKey, state);
      return true;
    }
    case 'nickname': {
      if (text === '-' || text.toLowerCase() === 'нет') {
        state.nickname = undefined;
      } else {
        state.nickname = text;
      }

      state.step = 'plan';
      await renderNicknameStep(ctx, threadKey, state);
      await renderPlanStep(ctx, threadKey, state);
      return true;
    }
    case 'plan': {
      await ctx.reply('Выберите тариф с помощью кнопок под сообщением.');
      return true;
    }
    case 'details':
    case 'summary': {
      const details = parseWizardDetailsInput(text);
      if (details.skip) {
        state.startAt = undefined;
        state.comment = undefined;
      } else {
        if (details.startAt) {
          state.startAt = details.startAt;
        }
        if (details.comment !== undefined) {
          state.comment = details.comment;
        }
      }

      state.step = 'summary';
      await renderDetailsStep(ctx, threadKey, state);
      await renderSummaryStep(ctx, threadKey, state);
      return true;
    }
    default:
      return false;
  }
};

const handlePlanSelection = async (
  ctx: BotContext,
  threadKey: string,
  choice: ExecutorPlanChoice,
): Promise<void> => {
  const state = getWizardState(ctx, threadKey);
  if (!state) {
    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery('Форма не найдена');
      } catch (error) {
        logger.debug({ err: error }, 'Failed to answer plan selection callback without state');
      }
    }
    return;
  }

  if (!state.phone) {
    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery('Сначала укажите номер телефона');
      } catch (error) {
        logger.debug({ err: error }, 'Failed to answer plan selection callback without phone');
      }
    }
    return;
  }

  state.planChoice = choice;
  state.step = 'details';

  if (typeof ctx.answerCbQuery === 'function') {
    try {
      await ctx.answerCbQuery(`Выбран тариф: ${PLAN_CHOICE_LABELS[choice]}`);
    } catch (error) {
      logger.debug({ err: error }, 'Failed to answer plan selection callback');
    }
  }

  await renderPlanStep(ctx, threadKey, state);
  await renderDetailsStep(ctx, threadKey, state);
};

const handleSummaryDecision = async (
  ctx: BotContext,
  threadKey: string,
  decision: 'confirm' | 'cancel',
): Promise<void> => {
  const state = getWizardState(ctx, threadKey);
  if (!state) {
    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery('Форма устарела', { show_alert: true });
      } catch (error) {
        logger.debug({ err: error }, 'Failed to answer summary callback without state');
      }
    }
    return;
  }

  if (decision === 'cancel') {
    await clearWizardSteps(ctx, threadKey, { keepSummary: true });
    await ui.step(ctx, {
      id: buildWizardStepId(threadKey, 'summary'),
      text: 'Создание плана отменено.',
      messageThreadId: state.threadId,
    });
    setWizardState(ctx, threadKey, undefined);
    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery('Операция отменена');
      } catch (error) {
        logger.debug({ err: error }, 'Failed to answer cancellation callback');
      }
    }
    return;
  }

  if (!state.phone || !state.planChoice) {
    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery('Заполните все поля', { show_alert: true });
      } catch (error) {
        logger.debug({ err: error }, 'Failed to answer summary callback without data');
      }
    }
    return;
  }

  state.startAt = state.startAt ?? new Date();
  const input = buildPlanInputFromState(ctx, state);
  if (!input) {
    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery('Не удалось собрать данные', { show_alert: true });
      } catch (error) {
        logger.debug({ err: error }, 'Failed to answer summary callback without input');
      }
    }
    return;
  }

  const mutation: ExecutorPlanMutation = { type: 'create', payload: input };

  await handleMutationWithFallback(ctx, mutation, async (outcome) => {
    if (!outcome || outcome.type !== 'created') {
      await ctx.reply('Не удалось создать запись. Попробуйте позже.');
      return;
    }

    const plan = outcome.plan;

    await clearWizardSteps(ctx, threadKey, { keepSummary: true });
    await ui.step(ctx, {
      id: buildWizardStepId(threadKey, 'summary'),
      text: ['План сохранён ✅', buildPlanSummary(plan)].join('\n\n'),
      messageThreadId: state.threadId,
    });
    setWizardState(ctx, threadKey, undefined);

    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery('План сохранён');
      } catch (error) {
        logger.debug({ err: error }, 'Failed to answer confirmation callback');
      }
    }

    try {
      await ctx.telegram.sendMessage(plan.chatId, buildPlanSummary(plan), {
        message_thread_id: plan.threadId ?? undefined,
        reply_markup: buildExecutorPlanActionKeyboard(plan),
      });
    } catch (error) {
      logger.error({ err: error, planId: plan.id }, 'Failed to post executor plan card');
    }

    await scheduleExecutorPlanReminder(plan);
  });
};

const sendQueueAck = async (ctx: BotContext): Promise<void> => {
  await ctx.reply('База данных недоступна. Данные поставлены в очередь и будут сохранены позже.');
};

const handleMutationWithFallback = async (
  ctx: BotContext,
  mutation: ExecutorPlanMutation,
  onSuccess: (outcome: ExecutorPlanMutationOutcome | null) => Promise<void>,
): Promise<void> => {
  await flushExecutorPlanMutations();

  try {
    const outcome = await processExecutorPlanMutation(mutation);
    await onSuccess(outcome);
  } catch (error) {
    logger.error({ err: error, mutation }, 'Executor plan mutation failed, enqueuing');
    try {
      await enqueueExecutorPlanMutation(mutation);
      await sendQueueAck(ctx);
      if (typeof ctx.answerCbQuery === 'function') {
        try {
          await ctx.answerCbQuery('Действие поставлено в очередь');
        } catch (answerError) {
          logger.debug({ err: answerError }, 'Failed to answer callback query after enqueue');
        }
      }
    } catch (queueError) {
      logger.error({ err: queueError, mutation }, 'Failed to enqueue executor plan mutation');
      await ctx.reply('Не удалось выполнить действие. Попробуйте позже.');
      if (typeof ctx.answerCbQuery === 'function') {
        try {
          await ctx.answerCbQuery('Ошибка при выполнении');
        } catch (answerError) {
          logger.debug({ err: answerError }, 'Failed to answer callback query after failure');
        }
      }
    }
  }
};

const handleFromCommand = async (ctx: BotContext): Promise<void> => {
  if (!ensureVerifyChannel(ctx)) {
    return;
  }

  const threadId = getThreadIdFromContext(ctx);
  const threadKey = getThreadKey(threadId);
  await startWizard(ctx, threadKey, threadId);
};

const handleExtendCommand = async (ctx: BotContext, args: string[]): Promise<void> => {
  if (!ensureVerifyChannel(ctx)) {
    return;
  }

  if (args.length < 2) {
    await ctx.reply('Использование: /extend <ID> <дни|дата|comment>');
    return;
  }

  const planId = Number.parseInt(args[0], 10);
  if (!Number.isFinite(planId)) {
    await ctx.reply('Укажите корректный идентификатор плана.');
    return;
  }

  const action = args[1].toLowerCase();
  if (action === 'comment') {
    const comment = args.slice(2).join(' ').trim();
    const mutation: ExecutorPlanMutation = {
      type: 'comment',
      payload: { id: planId, comment: comment || undefined },
    };

    await handleMutationWithFallback(ctx, mutation, async (outcome) => {
      if (!outcome || outcome.type !== 'updated') {
        await ctx.reply('Не удалось обновить комментарий.');
        return;
      }

      await ctx.reply(['Комментарий обновлён ✅', buildPlanSummary(outcome.plan)].join('\n\n'));
    });

    return;
  }

  const numeric = Number.parseInt(action.replace(/^\+/u, ''), 10);
  if (Number.isFinite(numeric) && numeric !== 0) {
    const days = numeric;
    const mutation: ExecutorPlanMutation = {
      type: 'extend',
      payload: { id: planId, days },
    };

    await handleMutationWithFallback(ctx, mutation, async (outcome) => {
      if (!outcome || outcome.type !== 'updated') {
        await ctx.reply('Не удалось продлить план.');
        return;
      }

      await ctx.reply(['План продлён ✅', buildPlanSummary(outcome.plan)].join('\n\n'));
      await scheduleExecutorPlanReminder(outcome.plan);
    });

    return;
  }

  const date = parseStartDate(args.slice(1).join(' '));
  if (!date) {
    await ctx.reply('Укажите количество дней (+7/+15/+30) или дату в формате 2024-11-20.');
    return;
  }

  const mutation: ExecutorPlanMutation = {
    type: 'set-start',
    payload: { id: planId, startAt: date.toISOString() },
  };

  await handleMutationWithFallback(ctx, mutation, async (outcome) => {
    if (!outcome || outcome.type !== 'updated') {
      await ctx.reply('Не удалось обновить дату старта.');
      return;
    }

    await ctx.reply(['Дата старта обновлена ✅', buildPlanSummary(outcome.plan)].join('\n\n'));
    await scheduleExecutorPlanReminder(outcome.plan);
  });
};

const handleStatusCommand = async (ctx: BotContext, args: string[]): Promise<void> => {
  if (!ensureVerifyChannel(ctx)) {
    return;
  }

  if (args.length === 0) {
    await ctx.reply('Использование: /status <ID>');
    return;
  }

  await flushExecutorPlanMutations();

  const planId = Number.parseInt(args[0], 10);
  if (!Number.isFinite(planId)) {
    await ctx.reply('Укажите корректный идентификатор плана.');
    return;
  }

  try {
    const plan = await getExecutorPlanById(planId);
    if (!plan) {
      await ctx.reply('План не найден.');
      return;
    }

    await ctx.reply(buildPlanSummary(plan));
  } catch (error) {
    logger.error({ err: error, planId }, 'Failed to load executor plan status');
    await ctx.reply('Не удалось загрузить данные. Попробуйте позже.');
  }
};

const handleBlockCommand = async (
  ctx: BotContext,
  args: string[],
  status: 'blocked' | 'active',
): Promise<void> => {
  if (!ensureVerifyChannel(ctx)) {
    return;
  }

  if (args.length === 0) {
    await ctx.reply(`Использование: /${status === 'blocked' ? 'block' : 'unblock'} <ID> [комментарий]`);
    return;
  }

  const planId = Number.parseInt(args[0], 10);
  if (!Number.isFinite(planId)) {
    await ctx.reply('Укажите корректный идентификатор плана.');
    return;
  }

  const reason = status === 'blocked' ? args.slice(1).join(' ').trim() || undefined : undefined;

  const mutation: ExecutorPlanMutation = {
    type: 'set-status',
    payload: { id: planId, status, reason },
  };

  await handleMutationWithFallback(ctx, mutation, async (outcome) => {
    if (!outcome || outcome.type !== 'updated') {
      await ctx.reply('Не удалось обновить статус плана.');
      return;
    }

    await ctx.reply(['Статус обновлён ✅', buildPlanSummary(outcome.plan)].join('\n\n'));
    if (status !== 'blocked') {
      await scheduleExecutorPlanReminder(outcome.plan);
    }
  });
};

const handleDeleteCommand = async (ctx: BotContext, args: string[]): Promise<void> => {
  if (!ensureVerifyChannel(ctx)) {
    return;
  }

  if (args.length === 0) {
    await ctx.reply('Использование: /delete <ID>');
    return;
  }

  const planId = Number.parseInt(args[0], 10);
  if (!Number.isFinite(planId)) {
    await ctx.reply('Укажите корректный идентификатор плана.');
    return;
  }

  const mutation: ExecutorPlanMutation = { type: 'delete', payload: { id: planId } };

  await handleMutationWithFallback(ctx, mutation, async (outcome) => {
    if (!outcome || outcome.type !== 'deleted') {
      await ctx.reply('Не удалось удалить план.');
      return;
    }

    await ctx.reply('План удалён ✅');
    await cancelExecutorPlanReminders(planId);
  });
};

const parseArgs = (ctx: BotContext): string[] => {
  const message = ctx.message;
  if (!message || !('text' in message) || !message.text) {
    return [];
  }

  const text = message.text.trim();
  const parts = text.split(/\s+/u);
  return parts.slice(1);
};

const handleExtendCallback = async (ctx: BotContext, planId: number, days: number): Promise<void> => {
  const mutation: ExecutorPlanMutation = {
    type: 'extend',
    payload: { id: planId, days },
  };

  await handleMutationWithFallback(ctx, mutation, async (outcome) => {
    if (!outcome || outcome.type !== 'updated') {
      await ctx.answerCbQuery('Не удалось продлить план');
      return;
    }

    await ctx.answerCbQuery('План продлён');
    await scheduleExecutorPlanReminder(outcome.plan);
  });
};

const handleStatusCallback = async (
  ctx: BotContext,
  planId: number,
  targetStatus: 'blocked' | 'active',
): Promise<void> => {
  const mutation: ExecutorPlanMutation = {
    type: 'set-status',
    payload: { id: planId, status: targetStatus },
  };

  await handleMutationWithFallback(ctx, mutation, async (outcome) => {
    if (!outcome || outcome.type !== 'updated') {
      await ctx.answerCbQuery('Не удалось изменить статус');
      return;
    }

    await ctx.answerCbQuery('Статус обновлён');
    if (targetStatus !== 'blocked') {
      await scheduleExecutorPlanReminder(outcome.plan);
    }
  });
};

const handleToggleMuteCallback = async (ctx: BotContext, planId: number): Promise<void> => {
  await flushExecutorPlanMutations();

  let plan: ExecutorPlanRecord | null = null;
  try {
    plan = await getExecutorPlanById(planId);
  } catch (error) {
    logger.error({ err: error, planId }, 'Failed to load plan for mute toggle');
  }

  if (!plan) {
    await ctx.answerCbQuery('План не найден');
    return;
  }

  const mutation: ExecutorPlanMutation = {
    type: 'mute',
    payload: { id: planId, muted: !plan.muted },
  };

  await handleMutationWithFallback(ctx, mutation, async (outcome) => {
    if (!outcome || outcome.type !== 'updated') {
      await ctx.answerCbQuery('Не удалось обновить уведомления');
      return;
    }

    await ctx.answerCbQuery(outcome.plan.muted ? 'Уведомления отключены' : 'Уведомления включены');
    if (!outcome.plan.muted) {
      await scheduleExecutorPlanReminder(outcome.plan);
    }
  });
};

const handleEditCallback = async (ctx: BotContext, planId: number): Promise<void> => {
  await ctx.answerCbQuery('Используйте /extend <ID> comment <текст> для редактирования.');
  await ctx.reply(`Чтобы обновить комментарий, выполните команду:\n/extend ${planId} comment <новый текст>`);
};

export const registerFromCommand = (bot: Telegraf<BotContext>): void => {
  VERIFY_COMMANDS.forEach((command) => {
    bot.command(command, async (ctx) => {
      await handleFromCommand(ctx);
    });
  });

  bot.on('text', async (ctx, next) => {
    const handled = await handleWizardTextMessage(ctx);
    if (handled) {
      return;
    }

    await next();
  });

  bot.action(PLAN_SELECT_CALLBACK_PATTERN, async (ctx) => {
    const data =
      ctx.callbackQuery && 'data' in ctx.callbackQuery
        ? ctx.callbackQuery.data
        : undefined;
    if (!data) {
      return;
    }

    const match = data.match(PLAN_SELECT_CALLBACK_PATTERN);
    if (!match) {
      return;
    }

    const choice = match[1] as ExecutorPlanChoice;
    const threadId = getThreadIdFromContext(ctx);
    const threadKey = getThreadKey(threadId);
    await handlePlanSelection(ctx, threadKey, choice);
  });

  bot.action(SUMMARY_CONFIRM_CALLBACK_PATTERN, async (ctx) => {
    const threadId = getThreadIdFromContext(ctx);
    const threadKey = getThreadKey(threadId);
    await handleSummaryDecision(ctx, threadKey, 'confirm');
  });

  bot.action(SUMMARY_CANCEL_CALLBACK_PATTERN, async (ctx) => {
    const threadId = getThreadIdFromContext(ctx);
    const threadKey = getThreadKey(threadId);
    await handleSummaryDecision(ctx, threadKey, 'cancel');
  });

  bot.command('extend', async (ctx) => {
    await handleExtendCommand(ctx, parseArgs(ctx));
  });

  bot.command('block', async (ctx) => {
    await handleBlockCommand(ctx, parseArgs(ctx), 'blocked');
  });

  bot.command('unblock', async (ctx) => {
    await handleBlockCommand(ctx, parseArgs(ctx), 'active');
  });

  bot.command('status', async (ctx) => {
    await handleStatusCommand(ctx, parseArgs(ctx));
  });

  bot.command('delete', async (ctx) => {
    await handleDeleteCommand(ctx, parseArgs(ctx));
  });

  bot.action(EXTEND_CALLBACK_PATTERN, async (ctx) => {
    const match = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data.match(EXTEND_CALLBACK_PATTERN) : null;
    if (!match) {
      return;
    }
    const planId = Number.parseInt(match[1], 10);
    const days = Number.parseInt(match[2], 10);
    if (Number.isFinite(planId) && Number.isFinite(days)) {
      await handleExtendCallback(ctx, planId, days);
    }
  });

  bot.action(BLOCK_CALLBACK_PATTERN, async (ctx) => {
    const match = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data.match(BLOCK_CALLBACK_PATTERN) : null;
    if (!match) {
      return;
    }
    const planId = Number.parseInt(match[1], 10);
    if (Number.isFinite(planId)) {
      await handleStatusCallback(ctx, planId, 'blocked');
    }
  });

  bot.action(UNBLOCK_CALLBACK_PATTERN, async (ctx) => {
    const match = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data.match(UNBLOCK_CALLBACK_PATTERN) : null;
    if (!match) {
      return;
    }
    const planId = Number.parseInt(match[1], 10);
    if (Number.isFinite(planId)) {
      await handleStatusCallback(ctx, planId, 'active');
    }
  });

  bot.action(TOGGLE_MUTE_CALLBACK_PATTERN, async (ctx) => {
    const match = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data.match(TOGGLE_MUTE_CALLBACK_PATTERN) : null;
    if (!match) {
      return;
    }
    const planId = Number.parseInt(match[1], 10);
    if (Number.isFinite(planId)) {
      await handleToggleMuteCallback(ctx, planId);
    }
  });

  bot.action(EDIT_CALLBACK_PATTERN, async (ctx) => {
    const match = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data.match(EDIT_CALLBACK_PATTERN) : null;
    if (!match) {
      return;
    }
    const planId = Number.parseInt(match[1], 10);
    if (Number.isFinite(planId)) {
      await handleEditCallback(ctx, planId);
    }
  });
};

export const __testing = {
  sanitisePhone,
  parseStartDate,
  parseWizardDetailsInput,
  formatPlanChoiceLabel,
  getThreadKey,
  startWizard,
  handleWizardTextMessage,
  handlePlanSelection,
  handleSummaryDecision,
  buildPlanInputFromState,
};
