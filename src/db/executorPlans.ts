import type { Pool } from 'pg';

import type { PoolClient } from './client';
import { pool } from './client';
import { logger } from '../config';
import type {
  ExecutorPlanChoice,
  ExecutorPlanInsertInput,
  ExecutorPlanRecord,
  ExecutorPlanStatus,
} from '../types';
import { getPlanChoiceDurationDays } from '../domain/executorPlans';

interface ExecutorPlanRow {
  id: number;
  chat_id: string | number;
  thread_id: number | null;
  phone: string;
  nickname: string | null;
  plan_choice: string;
  start_at: Date | string;
  ends_at: Date | string | null;
  comment: string | null;
  status: string;
  muted: boolean;
  reminder_index: number;
  reminder_last_sent: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const PLAN_CHOICES: ExecutorPlanChoice[] = ['trial', '7', '15', '30'];
const PLAN_CHOICE_SET = new Set(PLAN_CHOICES);
const PLAN_CHOICE_DURATIONS: Record<ExecutorPlanChoice, number> = {
  trial: getPlanChoiceDurationDays('trial'),
  '7': getPlanChoiceDurationDays('7'),
  '15': getPlanChoiceDurationDays('15'),
  '30': getPlanChoiceDurationDays('30'),
};
const FALLBACK_PLAN_CHOICE: ExecutorPlanChoice = '7';
const PLAN_STATUSES: ExecutorPlanStatus[] = ['active', 'blocked', 'completed', 'cancelled'];
const PLAN_STATUS_SET = new Set(PLAN_STATUSES);

const getPlanChoiceDuration = (choice: ExecutorPlanChoice): number =>
  PLAN_CHOICE_DURATIONS[choice] ?? PLAN_CHOICE_DURATIONS[FALLBACK_PLAN_CHOICE];

const computeEndsAt = (startAt: Date, durationDays: number): Date =>
  new Date(startAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

const parseDate = (value: Date | string | null): Date | undefined => {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const parseNumber = (value: string | number | null): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
};

const normalisePlanChoice = (value: string): ExecutorPlanChoice => {
  if (PLAN_CHOICE_SET.has(value as ExecutorPlanChoice)) {
    return value as ExecutorPlanChoice;
  }

  const fallback = FALLBACK_PLAN_CHOICE;
  logger.warn({ value }, 'Unknown executor plan choice, using fallback');
  return fallback;
};

const normalisePlanStatus = (value: string): ExecutorPlanStatus => {
  if (PLAN_STATUS_SET.has(value as ExecutorPlanStatus)) {
    return value as ExecutorPlanStatus;
  }

  logger.warn({ value }, 'Unknown executor plan status, using fallback');
  return 'active';
};

const mapRow = (row: ExecutorPlanRow): ExecutorPlanRecord => {
  const startAt = parseDate(row.start_at) ?? new Date();
  const planChoice = normalisePlanChoice(row.plan_choice);
  const createdAt = parseDate(row.created_at) ?? new Date();
  const updatedAt = parseDate(row.updated_at) ?? createdAt;
  const threadId = row.thread_id ?? undefined;
  const reminderLastSent = parseDate(row.reminder_last_sent);
  const endsAt =
    parseDate(row.ends_at) ?? computeEndsAt(startAt, getPlanChoiceDuration(planChoice));

  return {
    id: row.id,
    chatId: parseNumber(row.chat_id) ?? 0,
    threadId,
    phone: row.phone,
    nickname: row.nickname ?? undefined,
    planChoice,
    startAt,
    endsAt,
    comment: row.comment ?? undefined,
    status: normalisePlanStatus(row.status),
    muted: Boolean(row.muted),
    reminderIndex: row.reminder_index ?? 0,
    reminderLastSent,
    createdAt,
    updatedAt,
  } satisfies ExecutorPlanRecord;
};

type DatabaseClient = Pool | PoolClient;

const getClient = (client?: DatabaseClient): DatabaseClient => client ?? pool;

export const createExecutorPlan = async (
  input: ExecutorPlanInsertInput,
  client?: DatabaseClient,
): Promise<ExecutorPlanRecord> => {
  const db = getClient(client);
  const now = new Date();
  const endsAt =
    input.endsAt ?? computeEndsAt(input.startAt, getPlanChoiceDuration(input.planChoice));

  const { rows } = await db.query<ExecutorPlanRow>(
    `
      INSERT INTO executor_plans (
        chat_id,
        thread_id,
        phone,
        nickname,
        plan_choice,
        start_at,
        ends_at,
        comment,
        status,
        muted,
        reminder_index,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', false, 0, $8, $8)
      RETURNING *
    `,
    [
      input.chatId,
      input.threadId ?? null,
      input.phone,
      input.nickname ?? null,
      input.planChoice,
      input.startAt,
      endsAt,
      input.comment ?? null,
      now,
    ],
  );

  return mapRow(rows[0]);
};

export const getExecutorPlanById = async (
  id: number,
  client?: DatabaseClient,
): Promise<ExecutorPlanRecord | null> => {
  const db = getClient(client);
  const { rows } = await db.query<ExecutorPlanRow>(
    `
      SELECT *
      FROM executor_plans
      WHERE id = $1
      LIMIT 1
    `,
    [id],
  );

  const [row] = rows;
  return row ? mapRow(row) : null;
};

export const updateExecutorPlanReminderIndex = async (
  id: number,
  expectedIndex: number,
  nextIndex: number,
  sentAt: Date,
  client?: DatabaseClient,
): Promise<ExecutorPlanRecord | null> => {
  const db = getClient(client);
  const { rows } = await db.query<ExecutorPlanRow>(
    `
      UPDATE executor_plans
      SET reminder_index = $3,
          reminder_last_sent = $4,
          updated_at = $4
      WHERE id = $1 AND reminder_index = $2
      RETURNING *
    `,
    [id, expectedIndex, nextIndex, sentAt],
  );

  const [row] = rows;
  return row ? mapRow(row) : null;
};

export const setExecutorPlanMuted = async (
  id: number,
  muted: boolean,
  client?: DatabaseClient,
): Promise<ExecutorPlanRecord | null> => {
  const db = getClient(client);
  const now = new Date();

  const { rows } = await db.query<ExecutorPlanRow>(
    `
      UPDATE executor_plans
      SET muted = $2,
          updated_at = $3
      WHERE id = $1
      RETURNING *
    `,
    [id, muted, now],
  );

  const [row] = rows;
  return row ? mapRow(row) : null;
};

export const setExecutorPlanStatus = async (
  id: number,
  status: ExecutorPlanStatus,
  client?: DatabaseClient,
): Promise<ExecutorPlanRecord | null> => {
  const db = getClient(client);
  const now = new Date();

  const { rows } = await db.query<ExecutorPlanRow>(
    `
      UPDATE executor_plans
      SET status = $2,
          updated_at = $3
      WHERE id = $1
      RETURNING *
    `,
    [id, status, now],
  );

  const [row] = rows;
  return row ? mapRow(row) : null;
};

export const extendExecutorPlanByDays = async (
  id: number,
  days: number,
  client?: DatabaseClient,
): Promise<ExecutorPlanRecord | null> => {
  const db = getClient(client);
  const now = new Date();

  const { rows } = await db.query<ExecutorPlanRow>(
    `
      UPDATE executor_plans
      SET start_at = COALESCE(ends_at, start_at),
          ends_at = start_at + ($2 || ' days')::interval,
          reminder_index = 0,
          reminder_last_sent = NULL,
          status = 'active',
          updated_at = $3
      WHERE id = $1
      RETURNING *
    `,
    [id, days, now],
  );

  const [row] = rows;
  return row ? mapRow(row) : null;
};

export const setExecutorPlanStartDate = async (
  id: number,
  startAt: Date,
  client?: DatabaseClient,
): Promise<ExecutorPlanRecord | null> => {
  const db = getClient(client);
  const now = new Date();

  const { rows } = await db.query<ExecutorPlanRow>(
    `
      UPDATE executor_plans
      SET ends_at = $2 + (ends_at - start_at),
          start_at = $2,
          reminder_index = 0,
          reminder_last_sent = NULL,
          updated_at = $3
      WHERE id = $1
      RETURNING *
    `,
    [id, startAt, now],
  );

  const [row] = rows;
  return row ? mapRow(row) : null;
};

export const updateExecutorPlanComment = async (
  id: number,
  comment: string | undefined,
  client?: DatabaseClient,
): Promise<ExecutorPlanRecord | null> => {
  const db = getClient(client);
  const now = new Date();

  const { rows } = await db.query<ExecutorPlanRow>(
    `
      UPDATE executor_plans
      SET comment = $2,
          updated_at = $3
      WHERE id = $1
      RETURNING *
    `,
    [id, comment ?? null, now],
  );

  const [row] = rows;
  return row ? mapRow(row) : null;
};

export const deleteExecutorPlan = async (
  id: number,
  client?: DatabaseClient,
): Promise<boolean> => {
  const db = getClient(client);
  const { rowCount } = await db.query(
    `
      DELETE FROM executor_plans
      WHERE id = $1
    `,
    [id],
  );

  return (rowCount ?? 0) > 0;
};

export interface ExecutorBlockRecord {
  id: number;
  phone: string;
  reason?: string;
  createdAt: Date;
}

interface ExecutorBlockRow {
  id: number;
  phone: string;
  reason: string | null;
  created_at: Date | string;
}

const mapBlockRow = (row: ExecutorBlockRow): ExecutorBlockRecord => ({
  id: row.id,
  phone: row.phone,
  reason: row.reason ?? undefined,
  createdAt: parseDate(row.created_at) ?? new Date(),
});

export const upsertExecutorBlock = async (
  phone: string,
  reason: string | undefined,
  client?: DatabaseClient,
): Promise<ExecutorBlockRecord> => {
  const db = getClient(client);
  const now = new Date();

  const { rows } = await db.query<ExecutorBlockRow>(
    `
      INSERT INTO executor_blocks (phone, reason, created_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (phone) DO UPDATE
      SET reason = EXCLUDED.reason,
          created_at = EXCLUDED.created_at
      RETURNING *
    `,
    [phone, reason ?? null, now],
  );

  return mapBlockRow(rows[0]);
};

export const removeExecutorBlock = async (
  phone: string,
  client?: DatabaseClient,
): Promise<boolean> => {
  const db = getClient(client);
  const { rowCount } = await db.query(
    `
      DELETE FROM executor_blocks
      WHERE phone = $1
    `,
    [phone],
  );

  return (rowCount ?? 0) > 0;
};

export const findExecutorBlock = async (
  phone: string,
  client?: DatabaseClient,
): Promise<ExecutorBlockRecord | null> => {
  const db = getClient(client);
  const { rows } = await db.query<ExecutorBlockRow>(
    `
      SELECT *
      FROM executor_blocks
      WHERE phone = $1
      LIMIT 1
    `,
    [phone],
  );

  const [row] = rows;
  return row ? mapBlockRow(row) : null;
};

export const listExecutorPlansForScheduling = async (
  client?: DatabaseClient,
): Promise<ExecutorPlanRecord[]> => {
  const db = getClient(client);
  const { rows } = await db.query<ExecutorPlanRow>(
    `
      SELECT *
      FROM executor_plans
      WHERE status IN ('active', 'blocked')
    `,
  );

  return rows.map(mapRow);
};
