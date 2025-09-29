import { Telegraf } from 'telegraf';

import type { BotContext } from '../../types';
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

interface ParsedPlanForm {
  phone?: string;
  nickname?: string;
  planChoice?: ExecutorPlanChoice;
  startAt?: Date;
  comment?: string;
}

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

const parsePlanChoice = (value: string): ExecutorPlanChoice | null => {
  const digits = value.replace(/\D+/g, '');
  const candidate = PLAN_VALUES.find((option) => option === digits);
  return candidate ?? null;
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

const splitKeyValue = (line: string): { key: string; value: string } | null => {
  const match = line.match(/^([^:=\-]+)[:=\-]\s*(.+)$/u);
  if (!match) {
    return null;
  }

  const [, keyRaw, valueRaw] = match;
  const key = keyRaw.trim().toLowerCase();
  const value = valueRaw.trim();
  if (!key || !value) {
    return null;
  }

  return { key, value };
};

const parsePlanForm = (payload: string): ParsedPlanForm => {
  const result: ParsedPlanForm = {};
  if (!payload.trim()) {
    return result;
  }

  const lines = payload
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const remainder: string[] = [];

  for (const line of lines) {
    const kv = splitKeyValue(line);
    if (kv) {
      if (!result.phone && /(тел|phone|номер)/u.test(kv.key)) {
        const phone = sanitisePhone(kv.value);
        if (phone) {
          result.phone = phone;
          continue;
        }
      }

      if (!result.nickname && /(ник|id|tg|user)/u.test(kv.key)) {
        result.nickname = kv.value.trim();
        continue;
      }

      if (!result.planChoice && /(план|plan|тариф)/u.test(kv.key)) {
        const choice = parsePlanChoice(kv.value);
        if (choice) {
          result.planChoice = choice;
          continue;
        }
      }

      if (!result.startAt && /(старт|start|дата|начало)/u.test(kv.key)) {
        const date = parseStartDate(kv.value);
        if (date) {
          result.startAt = date;
          continue;
        }
      }

      if (!result.comment && /(комм|comment|заметка)/u.test(kv.key)) {
        result.comment = kv.value;
        continue;
      }
    }

    remainder.push(line);
  }

  const remainderJoined = remainder.join(' ');

  if (!result.phone) {
    const phoneMatch = remainderJoined.match(/(\+?\d[\d\s()-]{6,})/);
    if (phoneMatch) {
      const phone = sanitisePhone(phoneMatch[1]);
      if (phone) {
        result.phone = phone;
      }
    }
  }

  if (!result.nickname) {
    const nickMatch = remainderJoined.match(/@([a-z0-9_]{3,32})/i);
    if (nickMatch) {
      result.nickname = `@${nickMatch[1]}`;
    }
  }

  if (!result.planChoice) {
    const planMatch = remainderJoined.match(/\b(7|15|30)\b/);
    if (planMatch) {
      result.planChoice = planMatch[1] as ExecutorPlanChoice;
    }
  }

  if (!result.startAt) {
    const dateMatch = remainder.find((line) => /\d/.test(line));
    if (dateMatch) {
      const parsed = parseStartDate(dateMatch);
      if (parsed) {
        result.startAt = parsed;
      }
    }
  }

  if (!result.comment && remainder.length > 0) {
    result.comment = remainder.join('\n');
  }

  return result;
};

const extractPayload = (ctx: BotContext, command: string): string => {
  const message = ctx.message;
  if (!message) {
    return '';
  }

  const text = 'text' in message ? message.text ?? '' : '';
  let replyText = '';
  if ('reply_to_message' in message) {
    const replyCandidate = (message as { reply_to_message?: unknown }).reply_to_message;
    if (replyCandidate && typeof replyCandidate === 'object') {
      const reply = replyCandidate as { text?: unknown; caption?: unknown };
      if (typeof reply.text === 'string') {
        replyText = reply.text.trim();
      } else if (typeof reply.caption === 'string') {
        replyText = reply.caption.trim();
      }
    }
  }
  const pattern = new RegExp(`^/${command}(?:@\\w+)?\\s*`, 'i');
  const ownPayload = text.replace(pattern, '').trim();

  return [ownPayload, replyText].filter(Boolean).join('\n').trim();
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

const buildPlanInput = (
  ctx: BotContext,
  parsed: ParsedPlanForm,
): ExecutorPlanInsertInput | null => {
  if (!parsed.phone || !parsed.planChoice || !parsed.startAt) {
    return null;
  }

  const message = ctx.message;
  const threadId = message && 'message_thread_id' in message ? message.message_thread_id : undefined;

  return {
    chatId: ctx.chat?.id ?? config.channels.bindVerifyChannelId ?? 0,
    threadId,
    phone: parsed.phone,
    nickname: parsed.nickname,
    planChoice: parsed.planChoice,
    startAt: parsed.startAt,
    comment: parsed.comment,
  } satisfies ExecutorPlanInsertInput;
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

const handleCreateCommand = async (ctx: BotContext, command: string): Promise<void> => {
  if (!ensureVerifyChannel(ctx)) {
    return;
  }

  const payload = extractPayload(ctx, command);
  const parsed = parsePlanForm(payload);
  const input = buildPlanInput(ctx, parsed);

  if (!input) {
    await ctx.reply(
      [
        'Не удалось разобрать данные формы. Укажите телефон, тариф (7/15/30) и дату старта.',
        'Пример:\n/from +77001234567 @nickname 7 2024-11-20 Комментарий',
      ].join('\n'),
    );
    return;
  }

  const mutation: ExecutorPlanMutation = { type: 'create', payload: input };

  await handleMutationWithFallback(ctx, mutation, async (outcome) => {
    if (!outcome || outcome.type !== 'created') {
      await ctx.reply('Не удалось создать запись. Попробуйте позже.');
      return;
    }

    const summary = buildPlanSummary(outcome.plan);
    await ctx.reply(['План сохранён ✅', summary].join('\n\n'));
    await scheduleExecutorPlanReminder(outcome.plan);
  });
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
      await handleCreateCommand(ctx, command);
    });
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
