import { Queue, Worker, type JobsOptions } from 'bullmq';
import type { Telegraf, Telegram } from 'telegraf';

import type { BotContext } from '../bot/types';
import { config, logger } from '../config';
import {
  getExecutorPlanById,
  listExecutorPlansForScheduling,
  updateExecutorPlanReminderIndex,
} from '../db';
import type { ExecutorPlanRecord } from '../types';
import { buildReminderMessage, REMINDER_OFFSETS_HOURS } from '../services/executorPlans/reminders';
import {
  enqueueExecutorPlanMutation,
  flushExecutorPlanMutations,
  onExecutorPlanMutation,
  type ExecutorPlanMutationOutcome,
} from '../infra/executorPlanQueue';
import { buildExecutorPlanActionKeyboard } from '../bot/ui/executorPlans';

const QUEUE_NAME = 'executor-plan-reminders';
const REMINDER_JOB_NAME = 'executor-plan-reminder';

export const EXECUTOR_PLAN_REMINDER_QUEUE_WARNING_MESSAGE = [
  '⚠️ Напоминания по планам исполнителей временно отключены.',
  'Redis недоступен или не настроен.',
  'Проверьте переменную окружения REDIS_URL и убедитесь, что Redis запущен.',
  'После восстановления подключения перезапустите бота, чтобы возобновить отправку напоминаний.',
].join('\n');

interface ReminderJobData {
  planId: number;
  reminderIndex: number;
}

let queue: Queue<ReminderJobData> | null = null;
let worker: Worker<ReminderJobData> | null = null;
let botRef: Telegraf<BotContext> | null = null;
let started = false;
let reminderQueueWarningSent = false;

type ReminderModuleOverrides = {
  getExecutorPlanById?: typeof getExecutorPlanById;
  updateExecutorPlanReminderIndex?: typeof updateExecutorPlanReminderIndex;
  scheduleReminder?: (plan: ExecutorPlanRecord) => Promise<void>;
  enqueueExecutorPlanMutation?: typeof enqueueExecutorPlanMutation;
};

const overrides: ReminderModuleOverrides = {};

const buildJobId = (planId: number, reminderIndex: number): string =>
  `${planId}:${reminderIndex}`;

const computeReminderTime = (
  plan: ExecutorPlanRecord,
  reminderIndex: number,
): Date | null => {
  const offset = REMINDER_OFFSETS_HOURS[reminderIndex];
  if (offset === undefined) {
    return null;
  }

  const target = new Date(plan.endsAt.getTime() + offset * 60 * 60 * 1000);
  return target;
};

const removeScheduledReminders = async (planId: number): Promise<void> => {
  if (!queue) {
    return;
  }

  const ids = REMINDER_OFFSETS_HOURS.map((_, index) => buildJobId(planId, index));
  for (const id of ids) {
    try {
      await queue.remove(id);
    } catch (error) {
      logger.debug({ err: error, planId, jobId: id }, 'Failed to remove executor plan reminder job');
    }
  }
};

const scheduleReminder = async (plan: ExecutorPlanRecord): Promise<void> => {
  if (!queue) {
    return;
  }

  await removeScheduledReminders(plan.id);

  if (plan.status !== 'active' || plan.muted) {
    return;
  }

  if (plan.reminderIndex >= REMINDER_OFFSETS_HOURS.length) {
    return;
  }

  const dueAt = computeReminderTime(plan, plan.reminderIndex);
  if (!dueAt) {
    return;
  }

  const delay = Math.max(0, dueAt.getTime() - Date.now());

  const jobId = buildJobId(plan.id, plan.reminderIndex);
  const options: JobsOptions = {
    jobId,
    delay,
    removeOnComplete: true,
    removeOnFail: true,
  };

  await queue.add(REMINDER_JOB_NAME, { planId: plan.id, reminderIndex: plan.reminderIndex }, options);
};

export const notifyExecutorPlanReminderQueueUnavailable = async (
  telegram: Telegram | null,
  chatId: number,
  threadId?: number | null,
): Promise<void> => {
  if (!telegram) {
    logger.warn(
      { chatId },
      'Telegram instance is not available to notify about executor plan reminders queue',
    );
    return;
  }

  if (reminderQueueWarningSent) {
    return;
  }

  try {
    await telegram.sendMessage(chatId, EXECUTOR_PLAN_REMINDER_QUEUE_WARNING_MESSAGE, {
      message_thread_id: threadId ?? undefined,
    });
    reminderQueueWarningSent = true;
  } catch (error) {
    logger.error(
      { err: error, chatId, threadId },
      'Failed to notify moderators about executor plan reminders queue unavailability',
    );
  }
};

const handleMutationOutcome = async (
  outcome: ExecutorPlanMutationOutcome,
): Promise<void> => {
  switch (outcome.type) {
    case 'created':
      await resolveScheduleReminder(outcome.plan);
      break;
    case 'updated':
      await resolveScheduleReminder(outcome.plan);
      break;
    case 'deleted':
      await removeScheduledReminders(outcome.id);
      break;
    default:
      break;
  }
};

const postReminderMessage = async (
  telegram: Telegram,
  plan: ExecutorPlanRecord,
  reminderIndex: number,
): Promise<void> => {
  const message = buildReminderMessage(plan, reminderIndex);
  const keyboard = await buildExecutorPlanActionKeyboard(plan);

  try {
    await telegram.sendMessage(plan.chatId, message, {
      message_thread_id: plan.threadId ?? undefined,
      reply_markup: keyboard,
    });
  } catch (error) {
    logger.error({ err: error, planId: plan.id }, 'Failed to send executor plan reminder');
  }
};

const resolveScheduleReminder = async (plan: ExecutorPlanRecord): Promise<void> => {
  const handler = overrides.scheduleReminder ?? scheduleReminder;
  await handler(plan);
};

const handleReminderJob = async (data: ReminderJobData): Promise<void> => {
  const getPlanById = overrides.getExecutorPlanById ?? getExecutorPlanById;
  const updateReminderIndex =
    overrides.updateExecutorPlanReminderIndex ?? updateExecutorPlanReminderIndex;
  const enqueueMutation = overrides.enqueueExecutorPlanMutation ?? enqueueExecutorPlanMutation;

  const plan = await getPlanById(data.planId);
  if (!plan) {
    await removeScheduledReminders(data.planId);
    return;
  }

  if (plan.reminderIndex !== data.reminderIndex) {
    await resolveScheduleReminder(plan);
    return;
  }

  if (plan.status !== 'active' || plan.muted) {
    await resolveScheduleReminder(plan);
    return;
  }

  const telegram = botRef?.telegram;
  if (!telegram) {
    logger.warn('Telegram instance is not available for executor reminders');
    return;
  }

  await postReminderMessage(telegram, plan, data.reminderIndex);

  const updated = await updateReminderIndex(
    plan.id,
    data.reminderIndex,
    data.reminderIndex + 1,
    new Date(),
  );

  if (updated) {
    if (updated.reminderIndex >= REMINDER_OFFSETS_HOURS.length) {
      try {
        await enqueueMutation({
          type: 'set-status',
          payload: { id: updated.id, status: 'completed' },
        });
      } catch (error) {
        logger.error(
          { err: error, planId: updated.id },
          'Failed to enqueue executor plan completion mutation',
        );
      }

      await removeScheduledReminders(updated.id);
      return;
    }

    await resolveScheduleReminder(updated);
  }
};

const ensureQueue = (): boolean => {
  const redisConfig = config.session.redis;
  if (!redisConfig) {
    throw new Error(
      'Redis configuration is missing. Set REDIS_URL to enable executor plan reminders.',
    );
  }

  if (queue && worker) {
    return true;
  }

  const prefix = `${redisConfig.keyPrefix ?? 'bot:'}bull`;

  queue = new Queue<ReminderJobData>(QUEUE_NAME, {
    connection: { url: redisConfig.url },
    prefix,
  });
  worker = new Worker<ReminderJobData>(
    QUEUE_NAME,
    async (job: { data: ReminderJobData; id?: string | number | null }) => {
      try {
        await handleReminderJob(job.data);
      } catch (error) {
        logger.error({ err: error, jobId: job.id }, 'Executor plan reminder job failed');
        throw error;
      }
    },
    {
      connection: { url: redisConfig.url },
      prefix,
    },
  );

  worker.on('error', (error: unknown) => {
    logger.error({ err: error }, 'Executor plan reminder worker error');
  });

  return true;
};

export const ensureExecutorPlanReminderQueue = (): boolean => ensureQueue();

const initialisePlanSchedules = async (): Promise<void> => {
  if (!ensureQueue()) {
    return;
  }

  let plans: ExecutorPlanRecord[] = [];
  try {
    plans = await listExecutorPlansForScheduling();
  } catch (error) {
    logger.error({ err: error }, 'Failed to load executor plans for scheduling');
    return;
  }

  for (const plan of plans) {
    await resolveScheduleReminder(plan);
  }
};

export const __testing = {
  computeReminderTime,
  handleReminderJob,
  resetBotRef: () => {
    botRef = null;
  },
  resetQueueWarning: () => {
    reminderQueueWarningSent = false;
  },
  setBotRef: (bot: Telegraf<BotContext> | null) => {
    botRef = bot;
  },
  setEnqueueExecutorPlanMutationOverride: (
    handler: typeof enqueueExecutorPlanMutation | undefined,
  ) => {
    overrides.enqueueExecutorPlanMutation = handler;
  },
  setGetExecutorPlanByIdOverride: (
    handler: typeof getExecutorPlanById | undefined,
  ) => {
    overrides.getExecutorPlanById = handler;
  },
  setScheduleReminderOverride: (
    handler: ((plan: ExecutorPlanRecord) => Promise<void>) | undefined,
  ) => {
    overrides.scheduleReminder = handler;
  },
  setUpdateExecutorPlanReminderIndexOverride: (
    handler: typeof updateExecutorPlanReminderIndex | undefined,
  ) => {
    overrides.updateExecutorPlanReminderIndex = handler;
  },
  resetOverrides: () => {
    overrides.getExecutorPlanById = undefined;
    overrides.updateExecutorPlanReminderIndex = undefined;
    overrides.scheduleReminder = undefined;
    overrides.enqueueExecutorPlanMutation = undefined;
  },
};

export const startExecutorPlanReminderService = (
  bot: Telegraf<BotContext>,
): void => {
  if (started) {
    return;
  }

  botRef = bot;

  if (!ensureQueue()) {
    return;
  }

  onExecutorPlanMutation((outcome) => {
    void handleMutationOutcome(outcome);
  });

  void flushExecutorPlanMutations();
  void initialisePlanSchedules();

  started = true;
};

export const stopExecutorPlanReminderService = async (): Promise<void> => {
  if (!started) {
    return;
  }

  started = false;

  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
};

export const scheduleExecutorPlanReminder = async (
  plan: ExecutorPlanRecord,
): Promise<void> => {
  if (!ensureQueue()) {
    await notifyExecutorPlanReminderQueueUnavailable(
      botRef?.telegram ?? null,
      plan.chatId,
      plan.threadId,
    );
    return;
  }

  await scheduleReminder(plan);
};

export const refreshExecutorPlanReminderState = async (
  plan: ExecutorPlanRecord,
): Promise<void> => {
  if (!ensureQueue()) {
    return;
  }

  await scheduleReminder(plan);
};

export const cancelExecutorPlanReminders = async (planId: number): Promise<void> => {
  if (!ensureQueue()) {
    return;
  }

  await removeScheduledReminders(planId);
};
