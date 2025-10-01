import { Telegraf } from 'telegraf';
import type { ChatMemberUpdated } from 'telegraf/typings/core/types/typegram';

import { logger } from '../../config';
import { getChannelBinding, ORDERS_CHANNEL } from './bindings';
import {
  findActiveSubscriptionForUser,
  markSubscriptionsExpired,
  type ActiveSubscriptionDetails,
} from '../../db/subscriptions';
import type { BotContext } from '../types';
import { updateUserSubscriptionStatus } from '../../db/users';

const INACTIVE_STATUSES = new Set<ChatMemberUpdated['new_chat_member']['status']>([
  'left',
  'kicked',
  'restricted',
]);

const isInactiveStatus = (
  status: ChatMemberUpdated['new_chat_member']['status'],
): boolean => INACTIVE_STATUSES.has(status);

const loadActiveSubscription = async (
  chatId: number,
  userId: number,
): Promise<ActiveSubscriptionDetails | null> => {
  try {
    return await findActiveSubscriptionForUser(chatId, userId);
  } catch (error) {
    logger.error(
      { err: error, chatId, userId },
      'Failed to load subscription for membership update',
    );
    return null;
  }
};

export const registerMembershipSync = (
  bot: Telegraf<BotContext>,
): void => {
  bot.on('chat_member', async (ctx) => {
    const update = ctx.chatMember;
    if (!update) {
      return;
    }

    const status = update.new_chat_member.status;
    if (!isInactiveStatus(status)) {
      return;
    }

    const binding = await getChannelBinding(ORDERS_CHANNEL);
    if (!binding || binding.chatId !== update.chat.id) {
      return;
    }

    const chatId = binding.chatId;
    const userId = update.new_chat_member.user.id;

    const subscription = await loadActiveSubscription(chatId, userId);
    if (!subscription) {
      return;
    }

    const endedAt = new Date();

    try {
      await markSubscriptionsExpired([subscription.id], endedAt);
      logger.warn(
        {
          chatId,
          userId,
          subscriptionId: subscription.id,
          status,
        },
        'Marked subscription inactive after membership downgrade',
      );
      const subscriptionExpiresAt = subscription.expiresAt ?? endedAt;
      await updateUserSubscriptionStatus({
        telegramId: userId,
        subscriptionStatus: 'expired',
        subscriptionExpiresAt,
        hasActiveOrder: false,
        status: 'trial_expired',
        updatedAt: endedAt,
      });
    } catch (error) {
      logger.error(
        { err: error, chatId, userId, subscriptionId: subscription.id },
        'Failed to mark subscription inactive after membership downgrade',
      );
    }
  });
};
