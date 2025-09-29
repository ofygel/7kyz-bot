import cron, { type ScheduledTask } from 'node-cron';
import type { Telegraf } from 'telegraf';

import { ui } from '../bot/ui';
import { ensureExecutorState, showExecutorMenu } from '../bot/flows/executor/menu';
import { loadAuthStateByTelegramId } from '../bot/middlewares/auth';
import type { BotContext, SessionState } from '../bot/types';
import { config, logger } from '../config';
import type { PoolClient } from '../db/client';
import { pool } from '../db/client';
import { loadSessionState, saveSessionState, type SessionKey } from '../db/sessions';
import { updateUserSubscriptionStatus } from '../db/users';
import { HOUR } from '../utils/time';

type ReminderReason = 'awaitingReceipt' | 'trialEnding';

interface ReminderDescriptor {
  reasons: Set<ReminderReason>;
  trialExpiresAt?: Date;
}

interface ReminderCandidate extends ReminderDescriptor {
  key: SessionKey;
  session: SessionState;
}

const REMINDER_INTERVAL_MS = 2 * HOUR;
const TRIAL_WINDOW_MS = 6 * HOUR;
const REMINDER_STEP_ID = 'executor:subscription:reminder';

const parseScopeId = (value: string | number | null | undefined): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }

  return null;
};

const parseTimestamp = (value: Date | string | null | undefined): Date | undefined => {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return value;
  }

  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return undefined;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const parseReminderTimestamp = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
};

interface ExpiredTrialRow {
  tg_id: number | string;
  status: string | null;
  trial_expires_at: Date | string | null;
}

const parseTelegramId = (value: number | string): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
};

const expireExpiredTrials = async (client: PoolClient, now: Date): Promise<void> => {
  let rows: ExpiredTrialRow[] = [];
  try {
    ({ rows } = await client.query<ExpiredTrialRow>(
      `
        SELECT tg_id, status, trial_expires_at
        FROM users
        WHERE role = ANY($1::user_role[])
          AND sub_status = 'trial'
          AND trial_expires_at IS NOT NULL
          AND trial_expires_at <= $2
      `,
      [['executor'], now],
    ));
  } catch (error) {
    logger.error({ err: error }, 'Failed to load expired trials for reminders');
    return;
  }

  if (rows.length === 0) {
    return;
  }

  for (const row of rows) {
    const telegramId = parseTelegramId(row.tg_id);
    if (!telegramId) {
      logger.warn({ rawId: row.tg_id }, 'Skipping expired trial update due to invalid user id');
      continue;
    }

    const trialExpiresAt = parseTimestamp(row.trial_expires_at) ?? now;
    const preserveStatus = row.status === 'suspended' || row.status === 'banned';

    try {
      await updateUserSubscriptionStatus({
        client,
        telegramId,
        subscriptionStatus: 'expired',
        subscriptionExpiresAt: trialExpiresAt,
        trialExpiresAt: null,
        hasActiveOrder: false,
        status: preserveStatus ? undefined : 'trial_expired',
        updatedAt: now,
      });
      logger.info({ telegramId }, 'Marked trial as expired');
    } catch (error) {
      logger.error({ err: error, telegramId }, 'Failed to update user after trial expiration');
    }
  }
};

const gatherReminderDescriptors = async (
  client: PoolClient,
  now: Date,
): Promise<Map<string, ReminderDescriptor>> => {
  const descriptors = new Map<string, ReminderDescriptor>();

  const awaiting = await client.query<{ scope_id: string | number | null }>(
    `
      SELECT scope_id
      FROM sessions
      WHERE scope = 'chat'
        AND state->'executor'->'subscription'->>'status' = 'awaitingReceipt'
    `,
  );

  for (const row of awaiting.rows) {
    const scopeId = parseScopeId(row.scope_id);
    if (!scopeId) {
      continue;
    }

    const descriptor = descriptors.get(scopeId) ?? { reasons: new Set<ReminderReason>() };
    descriptor.reasons.add('awaitingReceipt');
    descriptors.set(scopeId, descriptor);
  }

  const trialDeadline = new Date(now.getTime() + TRIAL_WINDOW_MS);
  const trialRows = await client.query<{
    scope_id: string | number | null;
    trial_expires_at: Date | string | null;
  }>(
    `
      SELECT s.scope_id, u.trial_expires_at
      FROM sessions s
      JOIN users u ON u.tg_id = s.scope_id
      WHERE s.scope = 'chat'
        AND u.role = ANY($3::user_role[])
        AND u.trial_expires_at IS NOT NULL
        AND u.trial_expires_at > $1
        AND u.trial_expires_at <= $2
    `,
    [now, trialDeadline, ['executor']],
  );

  for (const row of trialRows.rows) {
    const scopeId = parseScopeId(row.scope_id);
    if (!scopeId) {
      continue;
    }

    const trialExpiresAt = parseTimestamp(row.trial_expires_at);
    if (!trialExpiresAt) {
      continue;
    }

    const descriptor = descriptors.get(scopeId) ?? { reasons: new Set<ReminderReason>() };
    descriptor.reasons.add('trialEnding');
    descriptor.trialExpiresAt = trialExpiresAt;
    descriptors.set(scopeId, descriptor);
  }

  return descriptors;
};

const loadReminderCandidates = async (
  client: PoolClient,
  descriptors: Map<string, ReminderDescriptor>,
): Promise<ReminderCandidate[]> => {
  const candidates: ReminderCandidate[] = [];

  for (const [scopeId, descriptor] of descriptors.entries()) {
    const key: SessionKey = { scope: 'chat', scopeId };
    try {
      const session = await loadSessionState(client, key);
      if (!session) {
        continue;
      }

      if (!session.executor || !session.executor.subscription) {
        continue;
      }

      candidates.push({
        key,
        session,
        reasons: new Set(descriptor.reasons),
        trialExpiresAt: descriptor.trialExpiresAt,
      });
    } catch (error) {
      logger.error({ err: error, scopeId }, 'Failed to load session for payment reminder');
    }
  }

  return candidates;
};

const determineEffectiveReasons = (
  candidate: ReminderCandidate,
  now: Date,
): Set<ReminderReason> => {
  const reasons = new Set<ReminderReason>();
  const subscription = candidate.session.executor?.subscription;
  if (!subscription) {
    return reasons;
  }

  if (
    candidate.reasons.has('awaitingReceipt') &&
    subscription.status === 'awaitingReceipt'
  ) {
    reasons.add('awaitingReceipt');
  }

  if (candidate.reasons.has('trialEnding')) {
    const trialExpiresAt = candidate.trialExpiresAt;
    if (trialExpiresAt && trialExpiresAt.getTime() > now.getTime()) {
      reasons.add('trialEnding');
    }
  }

  return reasons;
};

const formatDateTime = (date: Date): string =>
  new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: config.timezone,
  }).format(date);

const buildReminderMessage = (
  reasons: Set<ReminderReason>,
  trialExpiresAt?: Date,
): string => {
  const lines: string[] = [];

  if (reasons.has('awaitingReceipt')) {
    lines.push(
      '💸 Мы всё ещё ожидаем чек об оплате.',
      'Отправьте чек в этот чат, чтобы мы подтвердили оплату и выдали ссылку на канал.',
    );
  }

  if (reasons.has('trialEnding') && trialExpiresAt) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(
      '🕑 Пробный период скоро закончится.',
      `Доступ будет отключён ${formatDateTime(trialExpiresAt)}. Оформите подписку заранее, чтобы не потерять доступ.`,
    );
  }

  if (lines.length === 0) {
    return '';
  }

  lines.push(
    '',
    'Мы обновили меню ниже — используйте кнопку «📨 Получить ссылку на канал», чтобы завершить оплату.',
  );

  return lines.join('\n');
};

const sendReminder = async (
  bot: Telegraf<BotContext>,
  candidate: ReminderCandidate,
  reasons: Set<ReminderReason>,
  now: Date,
): Promise<void> => {
  const chatId = Number.parseInt(candidate.key.scopeId, 10);
  if (!Number.isFinite(chatId)) {
    logger.warn({ scopeId: candidate.key.scopeId }, 'Skipping reminder, invalid chat identifier');
    return;
  }

  let auth;
  try {
    auth = await loadAuthStateByTelegramId(chatId);
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to load auth state for payment reminder');
    return;
  }

  const session = candidate.session;
  session.ui = session.ui ?? {
    steps: {},
    homeActions: [],
    pendingCityAction: undefined,
    clientMenuVariant: undefined,
  };

  const ctx = {
    chat: { id: chatId, type: 'private' as const },
    from: { id: chatId } as NonNullable<BotContext['from']>,
    session,
    auth,
    telegram: bot.telegram,
    reply: (text: string, extra?: Parameters<typeof bot.telegram.sendMessage>[2]) =>
      bot.telegram.sendMessage(chatId, text, extra),
    answerCbQuery: async () => undefined,
  } as unknown as BotContext;

  ensureExecutorState(ctx);

  const message = buildReminderMessage(reasons, candidate.trialExpiresAt);
  if (message) {
    await ui.step(ctx, {
      id: REMINDER_STEP_ID,
      text: message,
      cleanup: false,
    });
  }

  await showExecutorMenu(ctx, { promptRoleSelection: false });

  const subscription = ctx.session.executor.subscription;
  subscription.lastReminderAt = now.getTime();

  await saveSessionState(pool, candidate.key, ctx.session);
  logger.info(
    { chatId, reasons: Array.from(reasons), trialExpiresAt: candidate.trialExpiresAt?.toISOString() },
    'Sent executor payment reminder',
  );
};

const executeReminderCycle = async (
  bot: Telegraf<BotContext>,
  now = new Date(),
): Promise<void> => {
  const client = await pool.connect();
  let candidates: ReminderCandidate[] = [];
  try {
    await expireExpiredTrials(client, now);
    const descriptors = await gatherReminderDescriptors(client, now);
    candidates = await loadReminderCandidates(client, descriptors);
  } catch (error) {
    logger.error({ err: error }, 'Failed to prepare payment reminder candidates');
  } finally {
    client.release();
  }

  for (const candidate of candidates) {
    const reasons = determineEffectiveReasons(candidate, now);
    if (reasons.size === 0) {
      continue;
    }

    const subscription = candidate.session.executor?.subscription;
    if (!subscription) {
      continue;
    }

    const lastReminderAt = parseReminderTimestamp(subscription.lastReminderAt);
    if (
      lastReminderAt !== undefined &&
      now.getTime() - lastReminderAt < REMINDER_INTERVAL_MS
    ) {
      continue;
    }

    try {
      await sendReminder(bot, candidate, reasons, now);
    } catch (error) {
      logger.error(
        { err: error, chatId: candidate.key.scopeId },
        'Failed to send payment reminder',
      );
    }
  }
};

let task: ScheduledTask | null = null;
let running = false;

const runSafely = (bot: Telegraf<BotContext>): void => {
  if (running) {
    logger.warn('Payment reminder task is already running, skipping this tick');
    return;
  }

  running = true;
  void executeReminderCycle(bot)
    .catch((error) => {
      logger.error({ err: error }, 'Unhandled payment reminder error');
    })
    .finally(() => {
      running = false;
    });
};

export const startPaymentReminderJob = (bot: Telegraf<BotContext>): void => {
  if (task) {
    return;
  }

  task = cron.schedule(
    config.jobs.paymentReminder,
    () => runSafely(bot),
    { timezone: config.timezone },
  );
};

export const stopPaymentReminderJob = (): void => {
  if (!task) {
    return;
  }

  task.stop();
  task = null;
  running = false;
};

export const __testing__ = {
  executeReminderCycle,
  REMINDER_INTERVAL_MS,
};
