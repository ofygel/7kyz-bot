import { Telegraf } from 'telegraf';
import type { ChatJoinRequest } from 'telegraf/typings/core/types/typegram';

import { logger } from '../../config';
import { hasActiveSubscription } from '../../db/subscriptions';
import { EXECUTOR_SUBSCRIPTION_REQUIRED_MESSAGE } from '../flows/executor/orders';
import type { BotContext } from '../types';

export interface JoinRequestDecisionContext {
  chatId: number;
  userId: number;
  request: ChatJoinRequest;
}

export type SubscriptionChecker = (
  userId: number,
  chatId: number,
  request: ChatJoinRequest,
) => Promise<boolean>;

export interface JoinRequestsOptions {
  hasActiveSubscription?: SubscriptionChecker;
  onApprove?: (context: JoinRequestDecisionContext) => void | Promise<void>;
  onDecline?: (context: JoinRequestDecisionContext) => void | Promise<void>;
}

const defaultChecker: SubscriptionChecker = async (userId, chatId) =>
  hasActiveSubscription(chatId, userId);

const formatUserForLog = (request: ChatJoinRequest): string => {
  const username = request.from.username ? `@${request.from.username}` : undefined;
  const fullName = [request.from.first_name, request.from.last_name]
    .filter((value) => Boolean(value && value.trim().length > 0))
    .join(' ')
    .trim();

  if (username && fullName) {
    return `${fullName} (${username}, ID ${request.from.id})`;
  }

  if (username) {
    return `${username} (ID ${request.from.id})`;
  }

  if (fullName) {
    return `${fullName} (ID ${request.from.id})`;
  }

  return `ID ${request.from.id}`;
};

export const registerJoinRequests = (
  bot: Telegraf<BotContext>,
  options: JoinRequestsOptions = {},
): void => {
  const hasActiveSubscription = options.hasActiveSubscription ?? defaultChecker;

  bot.on('chat_join_request', async (ctx) => {
    const request = ctx.chatJoinRequest;
    if (!request) {
      return;
    }

    const chatId = request.chat.id;
    const userId = request.from.id;
    let approved = false;

    try {
      approved = await hasActiveSubscription(userId, chatId, request);
    } catch (error) {
      logger.error(
        { err: error, chatId, userId },
        'Failed to determine subscription status for join request',
      );
    }

    const context: JoinRequestDecisionContext = { chatId, userId, request };

    if (approved) {
      try {
        await ctx.telegram.approveChatJoinRequest(chatId, userId);
        await options.onApprove?.(context);
        logger.info(
          { chatId, userId, user: formatUserForLog(request) },
          'Approved chat join request automatically',
        );
      } catch (error) {
        logger.error(
          { err: error, chatId, userId },
          'Failed to approve chat join request',
        );
      }
      return;
    }

    try {
      await ctx.telegram.declineChatJoinRequest(chatId, userId);

      try {
        await ctx.telegram.sendMessage(userId, EXECUTOR_SUBSCRIPTION_REQUIRED_MESSAGE);
      } catch (error) {
        logger.warn(
          { err: error, chatId, userId },
          'Failed to notify user about declined chat join request',
        );
      }

      await options.onDecline?.(context);
      logger.info(
        { chatId, userId, user: formatUserForLog(request) },
        'Declined chat join request automatically',
      );
    } catch (error) {
      logger.error(
        { err: error, chatId, userId },
        'Failed to decline chat join request',
      );
    }
  });
};
