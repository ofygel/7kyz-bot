import { config, logger } from '../config';
import {
  createExecutorPlan,
  deleteExecutorPlan,
  extendExecutorPlanByDays,
  removeExecutorBlock,
  setExecutorPlanMuted,
  setExecutorPlanStartDate,
  setExecutorPlanStatus,
  upsertExecutorBlock,
  updateExecutorPlanComment,
} from '../db';
import type {
  ExecutorPlanInsertInput,
  ExecutorPlanRecord,
  ExecutorPlanStatus,
} from '../types';
import { getRedisClient } from './redis';
import { parseDateTimeInTimezone } from '../utils/time';
import { refreshExecutorOrderAccessCacheForPlan } from '../services/executorPlans/accessCache';

const MUTATION_QUEUE_KEY = 'executor-plan-mutations';
const MAX_MUTATIONS_PER_FLUSH = 100;

export type ExecutorPlanMutation =
  | { type: 'create'; payload: ExecutorPlanInsertInput }
  | { type: 'extend'; payload: { id: number; days: number } }
  | {
      type: 'set-status';
      payload: { id: number; status: ExecutorPlanStatus; reason?: string };
    }
  | { type: 'mute'; payload: { id: number; muted: boolean } }
  | { type: 'set-start'; payload: { id: number; startAt: string } }
  | { type: 'comment'; payload: { id: number; comment?: string } }
  | { type: 'delete'; payload: { id: number } };

export type ExecutorPlanMutationOutcome =
  | { type: 'created'; plan: ExecutorPlanRecord }
  | { type: 'updated'; plan: ExecutorPlanRecord }
  | { type: 'deleted'; id: number };

let mutationListener:
  | ((outcome: ExecutorPlanMutationOutcome) => Promise<void> | void)
  | undefined;

const getQueueKey = (): string => {
  const prefix = config.session.redis?.keyPrefix ?? 'session:';
  return `${prefix}${MUTATION_QUEUE_KEY}`;
};

export const onExecutorPlanMutation = (
  listener: (outcome: ExecutorPlanMutationOutcome) => Promise<void> | void,
): void => {
  mutationListener = listener;
};

const notify = async (outcome: ExecutorPlanMutationOutcome): Promise<void> => {
  if (!mutationListener) {
    return;
  }

  try {
    await mutationListener(outcome);
  } catch (error) {
    logger.error({ err: error }, 'Executor plan mutation listener failed');
  }
};

const parseStartDate = (value: string): Date | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return parseDateTimeInTimezone(trimmed, config.timezone);
};

const applyMutation = async (
  mutation: ExecutorPlanMutation,
): Promise<ExecutorPlanMutationOutcome | null> => {
  switch (mutation.type) {
    case 'create': {
      const plan = await createExecutorPlan(mutation.payload);
      return { type: 'created', plan };
    }
    case 'extend': {
      const plan = await extendExecutorPlanByDays(
        mutation.payload.id,
        mutation.payload.days,
      );
      return plan ? { type: 'updated', plan } : null;
    }
    case 'set-status': {
      const plan = await setExecutorPlanStatus(
        mutation.payload.id,
        mutation.payload.status,
      );
      if (!plan) {
        return null;
      }

      if (mutation.payload.status === 'blocked') {
        try {
          await upsertExecutorBlock(plan.phone, mutation.payload.reason);
        } catch (error) {
          logger.error(
            { err: error, planId: plan.id },
            'Failed to persist executor block entry',
          );
        }
        await refreshExecutorOrderAccessCacheForPlan(plan);
      } else if (mutation.payload.status === 'active') {
        try {
          await removeExecutorBlock(plan.phone);
        } catch (error) {
          logger.error(
            { err: error, planId: plan.id },
            'Failed to remove executor block entry',
          );
        }
        await refreshExecutorOrderAccessCacheForPlan(plan);
      }

      return { type: 'updated', plan };
    }
    case 'mute': {
      const plan = await setExecutorPlanMuted(
        mutation.payload.id,
        mutation.payload.muted,
      );
      return plan ? { type: 'updated', plan } : null;
    }
    case 'set-start': {
      const startAt = parseStartDate(mutation.payload.startAt);
      if (!startAt) {
        logger.warn(
          { mutation },
          'Skipping executor plan start update due to invalid date',
        );
        return null;
      }
      const plan = await setExecutorPlanStartDate(
        mutation.payload.id,
        startAt,
      );
      return plan ? { type: 'updated', plan } : null;
    }
    case 'comment': {
      const plan = await updateExecutorPlanComment(
        mutation.payload.id,
        mutation.payload.comment,
      );
      return plan ? { type: 'updated', plan } : null;
    }
    case 'delete': {
      const deleted = await deleteExecutorPlan(mutation.payload.id);
      return deleted ? { type: 'deleted', id: mutation.payload.id } : null;
    }
    default: {
      const neverMutation: never = mutation;
      logger.warn({ mutation: neverMutation }, 'Unsupported executor plan mutation');
      return null;
    }
  }
};

export const processExecutorPlanMutation = async (
  mutation: ExecutorPlanMutation,
): Promise<ExecutorPlanMutationOutcome | null> => {
  const outcome = await applyMutation(mutation);
  if (outcome) {
    await notify(outcome);
  }
  return outcome;
};

export const enqueueExecutorPlanMutation = async (
  mutation: ExecutorPlanMutation,
): Promise<void> => {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Redis is not configured; cannot enqueue executor plan mutation');
  }

  const payload = JSON.stringify(mutation);
  await redis.rpush(getQueueKey(), payload);
};

export const __testing = {
  parseStartDate,
};

export const flushExecutorPlanMutations = async (): Promise<void> => {
  const redis = getRedisClient();
  if (!redis) {
    return;
  }

  for (let processed = 0; processed < MAX_MUTATIONS_PER_FLUSH; processed += 1) {
    const raw = await redis.lpop(getQueueKey());
    if (!raw) {
      break;
    }

    let parsed: ExecutorPlanMutation;
    try {
      parsed = JSON.parse(raw) as ExecutorPlanMutation;
    } catch (error) {
      logger.error({ err: error, raw }, 'Failed to parse executor plan mutation');
      continue;
    }

    try {
      await processExecutorPlanMutation(parsed);
    } catch (error) {
      logger.error({ err: error, mutation: parsed }, 'Failed to apply executor plan mutation');
      // Push back to queue and stop processing to avoid busy loop.
      await redis.lpush(getQueueKey(), raw);
      break;
    }
  }
};
