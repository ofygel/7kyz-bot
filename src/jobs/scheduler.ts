import cron, { type ScheduledTask } from 'node-cron';
import type { Telegraf, Telegram } from 'telegraf';

import type { BotContext } from '../bot/types';
import { config, logger } from '../config';
import {
  findSubscriptionsExpiringSoon,
  findSubscriptionsToExpire,
  markSubscriptionsExpired,
  recordSubscriptionWarning,
  type SubscriptionWithUser,
} from '../db/subscriptions';
import {
  reportSubscriptionExpired,
  reportSubscriptionWarning,
  type SubscriptionIdentity,
} from '../bot/services/reports';
import { updateUserSubscriptionStatus } from '../db/users';

let task: ScheduledTask | null = null;
let running = false;

const isPromiseLike = (value: unknown): value is PromiseLike<void> =>
  typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';

const runSafely = (action: () => void | Promise<void>, errorMessage: string): void => {
  try {
    const result = action();

    if (isPromiseLike(result)) {
      void result.catch((error) => {
        logger.error({ err: error }, errorMessage);
      });
    }
  } catch (error) {
    logger.error({ err: error }, errorMessage);
  }
};

const formatDateTime = (date: Date): string =>
  new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: config.timezone,
  }).format(date);

const buildUserLabel = (subscription: SubscriptionWithUser): string => {
  const parts = [subscription.firstName, subscription.lastName]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .map((part) => part.trim());

  if (subscription.username) {
    parts.push(`@${subscription.username}`);
  }

  if (parts.length === 0 && subscription.telegramId) {
    parts.push(`ID ${subscription.telegramId}`);
  }

  const label = parts.join(' ').trim();
  return label || String(subscription.telegramId);
};

const sendWarningMessage = async (
  telegram: Telegram,
  subscription: SubscriptionWithUser,
): Promise<void> => {
  if (!subscription.telegramId) {
    logger.warn(
      { subscriptionId: subscription.id },
      'Skipping warning message, missing telegram identifier',
    );
    return;
  }

  const message = [
    '⚠️ Ваша подписка скоро закончится.',
    `Доступ к каналу будет отключён ${formatDateTime(subscription.expiresAt)}.`,
    '',
    'Продлите подписку заранее, чтобы не потерять доступ.',
  ].join('\n');

  await telegram.sendMessage(subscription.telegramId, message);

  const identity: SubscriptionIdentity = {
    telegramId: subscription.telegramId,
    username: subscription.username ?? undefined,
    firstName: subscription.firstName ?? undefined,
    lastName: subscription.lastName ?? undefined,
    shortId: subscription.shortId ?? undefined,
    subscriptionStatus: 'active',
    subscriptionExpiresAt: subscription.expiresAt,
  };

  await reportSubscriptionWarning(telegram, identity, subscription.expiresAt);
};

const sendExpirationMessage = async (
  telegram: Telegram,
  subscription: SubscriptionWithUser,
): Promise<void> => {
  if (!subscription.telegramId) {
    logger.warn(
      { subscriptionId: subscription.id },
      'Skipping expiration message, missing telegram identifier',
    );
    return;
  }

  const message = [
    '⛔️ Срок вашей подписки истёк.',
    'Доступ к каналу ограничен. Продлите подписку, чтобы вернуть доступ.',
  ].join('\n');

  await telegram.sendMessage(subscription.telegramId, message);

  const identity: SubscriptionIdentity = {
    telegramId: subscription.telegramId,
    username: subscription.username ?? undefined,
    firstName: subscription.firstName ?? undefined,
    lastName: subscription.lastName ?? undefined,
    shortId: subscription.shortId ?? undefined,
    subscriptionStatus: 'expired',
    subscriptionExpiresAt: subscription.expiresAt,
  };

  await reportSubscriptionExpired(telegram, identity, subscription.expiresAt);
};

const removeUserFromChannel = async (
  telegram: Telegram,
  subscription: SubscriptionWithUser,
): Promise<void> => {
  if (!subscription.telegramId) {
    logger.warn(
      { subscriptionId: subscription.id },
      'Cannot remove user from channel without telegram identifier',
    );
    return;
  }

  try {
    const untilDate = Math.floor(Date.now() / 1000) + 60;
    await telegram.kickChatMember(subscription.chatId, subscription.telegramId, untilDate);
    await telegram.unbanChatMember(subscription.chatId, subscription.telegramId, {
      only_if_banned: true,
    });
    logger.info(
      {
        subscriptionId: subscription.id,
        chatId: subscription.chatId,
        telegramId: subscription.telegramId,
        user: buildUserLabel(subscription),
      },
      'Removed user from channel due to expired subscription',
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        subscriptionId: subscription.id,
        chatId: subscription.chatId,
        telegramId: subscription.telegramId,
      },
      'Failed to remove user from channel after subscription expiration',
    );
  }
};

const processExpiringSubscriptions = async (
  telegram: Telegram,
  now: Date,
): Promise<void> => {
  const warnHours = config.subscriptions.warnHoursBefore;
  const warnUntil = new Date(now.getTime() + warnHours * 60 * 60 * 1000);

  let expiring: SubscriptionWithUser[] = [];
  try {
    expiring = await findSubscriptionsExpiringSoon(now, warnUntil, warnHours);
  } catch (error) {
    logger.error({ err: error }, 'Failed to load expiring subscriptions');
    return;
  }

  for (const subscription of expiring) {
    try {
      await sendWarningMessage(telegram, subscription);
      logger.info(
        {
          subscriptionId: subscription.id,
          user: buildUserLabel(subscription),
          expiresAt: subscription.expiresAt.toISOString(),
        },
        'Sent subscription expiration warning',
      );
    } catch (error) {
      logger.error(
        {
          err: error,
          subscriptionId: subscription.id,
          telegramId: subscription.telegramId,
        },
        'Failed to send subscription expiration warning',
      );
    } finally {
      try {
        await recordSubscriptionWarning(subscription.id, new Date());
      } catch (error) {
        logger.error(
          { err: error, subscriptionId: subscription.id },
          'Failed to record subscription warning event',
        );
      }
    }
  }
};

const processExpiredSubscriptions = async (
  telegram: Telegram,
  now: Date,
): Promise<void> => {
  let expired: SubscriptionWithUser[] = [];
  try {
    expired = await findSubscriptionsToExpire(now);
  } catch (error) {
    logger.error({ err: error }, 'Failed to load expired subscriptions');
    return;
  }

  if (expired.length === 0) {
    return;
  }

  try {
    await markSubscriptionsExpired(
      expired.map((subscription) => subscription.id),
      now,
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to mark subscriptions as expired');
    return;
  }

  for (const subscription of expired) {
    if (!subscription.telegramId) {
      continue;
    }

    try {
      await updateUserSubscriptionStatus({
        telegramId: subscription.telegramId,
        subscriptionStatus: 'expired',
        subscriptionExpiresAt: subscription.expiresAt,
        trialExpiresAt: null,
        hasActiveOrder: false,
        status: 'trial_expired',
        updatedAt: now,
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          subscriptionId: subscription.id,
          telegramId: subscription.telegramId,
        },
        'Failed to update user state after subscription expiration',
      );
    }
  }

  for (const subscription of expired) {
    try {
      await sendExpirationMessage(telegram, subscription);
    } catch (error) {
      logger.error(
        {
          err: error,
          subscriptionId: subscription.id,
          telegramId: subscription.telegramId,
        },
        'Failed to notify user about expired subscription',
      );
    }

    await removeUserFromChannel(telegram, subscription);
  }
};

const runMaintenance = async (telegram: Telegram): Promise<void> => {
  const startedAt = new Date();
  logger.debug({ startedAt: startedAt.toISOString() }, 'Running subscription maintenance');

  try {
    await processExpiringSubscriptions(telegram, startedAt);
    await processExpiredSubscriptions(telegram, startedAt);
  } catch (error) {
    logger.error({ err: error }, 'Subscription maintenance failed');
  }

  logger.debug('Subscription maintenance finished');
};

export const startSubscriptionScheduler = (
  bot: Telegraf<BotContext>,
): void => {
  if (task) {
    return;
  }

  task = cron.schedule(
    config.jobs.subscription,
    () => {
      if (running) {
        logger.warn('Previous subscription maintenance is still running, skipping');
        return;
      }

      running = true;
      void runMaintenance(bot.telegram).finally(() => {
        running = false;
      });
    },
    { timezone: config.timezone },
  );

  logger.info('Subscription scheduler initialised');
};

export const stopSubscriptionScheduler = (): void => {
  if (!task) {
    return;
  }

  const scheduledTask = task;
  task = null;
  running = false;

  runSafely(() => scheduledTask.stop(), 'Failed to stop subscription scheduler task');
  runSafely(() => scheduledTask.destroy(), 'Failed to destroy subscription scheduler task');

  logger.info('Subscription scheduler stopped');
};
