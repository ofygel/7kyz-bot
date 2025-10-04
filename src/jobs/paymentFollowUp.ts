import cron, { type ScheduledTask } from 'node-cron';
import { Markup, type Telegraf } from 'telegraf';

import type { BotContext, ExecutorSubscriptionState } from '../bot/types';
import { config, logger } from '../config';
import { loadSessionState, saveSessionState, type SessionKey } from '../db/sessions';
import { pool, withTx } from '../db/client';

const REMINDER_DELAY_MS = 15 * 60 * 1000;
const BATCH_LIMIT = 100;

interface PendingSubscriptionRow {
  scope_id: string;
}

interface ReminderPlan {
  scopeId: string;
  chatId: string;
  reminderTimestamp: number;
}

const normaliseTimestamp = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }

    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }

  return null;
};

const fetchPendingSubscriptions = async (): Promise<PendingSubscriptionRow[]> => {
  const { rows } = await pool.query<PendingSubscriptionRow>(
    `
      SELECT scope_id::text AS scope_id
      FROM sessions
      WHERE scope = 'chat'
        AND state -> 'executor' -> 'subscription' ->> 'status' = 'await_payment_manual'
        AND (
          state -> 'executor' -> 'subscription' ->> 'lastReminderAt' IS NULL
          OR state -> 'executor' -> 'subscription' ->> 'lastReminderAt' = 'null'
        )
      ORDER BY updated_at ASC
      LIMIT $1
    `,
    [BATCH_LIMIT],
  );

  return rows;
};

const buildReminderMessage = (): string => {
  const supportMention = config.support.mention;
  const supportUrl = config.support.url;

  const segments = [
    '👋 Напоминаем: доступ к заказам откроем после оплаты подписки.',
    `Если уже оплатили — отправьте чек в этот чат, чтобы ${supportMention} быстрее подключили доступ.`,
    `Если остались вопросы, напишите нам по кнопке ниже или напрямую: ${supportUrl}.`,
  ];

  return segments.join('\n\n');
};

const buildReminderKeyboard = () =>
  Markup.inlineKeyboard([[Markup.button.url('Написать в поддержку', config.support.url)]]).reply_markup;

const shouldSendReminder = (
  subscription: ExecutorSubscriptionState,
  now: number,
): boolean => {
  if (subscription.status !== 'await_payment_manual') {
    return false;
  }

  const lastReminderAt = normaliseTimestamp(subscription.lastReminderAt);
  if (lastReminderAt) {
    return false;
  }

  const paymentRequestedAt = normaliseTimestamp(subscription.paymentRequestedAt);
  if (!paymentRequestedAt) {
    return false;
  }

  return now - paymentRequestedAt >= REMINDER_DELAY_MS;
};

const planReminder = async (scopeId: string): Promise<ReminderPlan | null> => {
  const key: SessionKey = { scope: 'chat', scopeId };
  const now = Date.now();

  return withTx(async (client) => {
    const state = await loadSessionState(client, key, { forUpdate: true });
    if (!state?.executor) {
      return null;
    }

    const subscription = state.executor.subscription;
    if (!shouldSendReminder(subscription, now)) {
      return null;
    }

    subscription.lastReminderAt = now;
    await saveSessionState(client, key, state);

    return { scopeId, chatId: scopeId, reminderTimestamp: now } satisfies ReminderPlan;
  });
};

const revertReminderFlag = async (scopeId: string, reminderTimestamp: number): Promise<void> => {
  try {
    await withTx(async (client) => {
      const key: SessionKey = { scope: 'chat', scopeId };
      const state = await loadSessionState(client, key, { forUpdate: true });
      if (!state?.executor) {
        return;
      }

      const subscription = state.executor.subscription;
      const currentReminder = normaliseTimestamp(subscription.lastReminderAt);
      if (currentReminder !== reminderTimestamp) {
        return;
      }

      delete subscription.lastReminderAt;
      await saveSessionState(client, key, state);
    });
  } catch (error) {
    logger.error({ err: error, scopeId }, 'Failed to revert payment follow-up flag');
  }
};

const processReminderPlan = async (
  bot: Telegraf<BotContext>,
  plan: ReminderPlan,
): Promise<void> => {
  try {
    await bot.telegram.sendMessage(plan.chatId, buildReminderMessage(), {
      reply_markup: buildReminderKeyboard(),
    });
  } catch (error) {
    logger.error({ err: error, chatId: plan.chatId }, 'Failed to send payment follow-up reminder');
    await revertReminderFlag(plan.scopeId, plan.reminderTimestamp);
  }
};

const runPaymentFollowUp = async (bot: Telegraf<BotContext>): Promise<void> => {
  if (!config.jobs.paymentFollowUpEnabled) {
    return;
  }

  const rows = await fetchPendingSubscriptions();
  if (rows.length === 0) {
    return;
  }

  for (const row of rows) {
    const scopeId = row.scope_id;
    if (!scopeId) {
      continue;
    }

    try {
      const plan = await planReminder(scopeId);
      if (plan) {
        await processReminderPlan(bot, plan);
      }
    } catch (error) {
      logger.error({ err: error, scopeId }, 'Failed to schedule payment follow-up reminder');
    }
  }
};

let task: ScheduledTask | null = null;
let running = false;

export const startPaymentFollowUpJob = (bot: Telegraf<BotContext>): void => {
  if (task || !config.jobs.paymentFollowUpEnabled) {
    if (!config.jobs.paymentFollowUpEnabled) {
      logger.info('Payment follow-up job disabled via configuration');
    }
    return;
  }

  task = cron.schedule(
    config.jobs.paymentFollowUp,
    async () => {
      if (running) {
        return;
      }

      running = true;
      try {
        await runPaymentFollowUp(bot);
      } catch (error) {
        logger.error({ err: error }, 'payment_follow_up_job_failed');
      } finally {
        running = false;
      }
    },
    { timezone: config.timezone },
  );

  logger.info({ cron: config.jobs.paymentFollowUp }, 'Payment follow-up job scheduled');
};

export const stopPaymentFollowUpJob = (): void => {
  if (!task) {
    return;
  }

  task.stop();
  task = null;
  running = false;
};

