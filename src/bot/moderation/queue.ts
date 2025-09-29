import crypto from 'crypto';

import { Telegraf, Telegram } from 'telegraf';
import type {
  ForceReply,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
} from 'telegraf/typings/core/types/typegram';
import type { ExtraEditMessageText, ExtraReplyMessage } from 'telegraf/typings/telegram-types';

import { getChannelBinding, type ChannelType } from '../channels/bindings';
import { logger } from '../../config';
import type { BotContext } from '../types';
import {
  deleteCallbackMapRecord,
  listCallbackMapRecords,
  loadCallbackMapRecord,
  upsertCallbackMapRecord,
} from '../../db';

const DEFAULT_REJECTION_PLACEHOLDER = 'без указания причины';

const formatModerator = (
  moderator: ModeratorInfo,
): string => {
  if (moderator.username) {
    return `@${moderator.username}`;
  }

  const fullName = [moderator.firstName, moderator.lastName]
    .filter((value) => Boolean(value && value.trim().length > 0))
    .join(' ') // separator only between provided parts
    .trim();

  if (fullName) {
    return `${fullName}${moderator.id ? ` (ID ${moderator.id})` : ''}`;
  }

  return moderator.id ? `ID ${moderator.id}` : 'неизвестный модератор';
};

const normaliseReason = (reason?: string): string => {
  const trimmed = reason?.trim();
  if (trimmed) {
    return trimmed;
  }

  return DEFAULT_REJECTION_PLACEHOLDER;
};

const createToken = (): string => crypto.randomBytes(8).toString('hex');

const MODERATION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISSING_CHANNEL_WARNING_THROTTLE_MS = 5 * 60 * 1000;

const pickFormatOptions = (
  options?: ExtraReplyMessage,
): MessageFormatOptions | undefined => {
  if (!options) {
    return undefined;
  }

  const formatOptions: MessageFormatOptions = {};
  if (options.parse_mode) {
    formatOptions.parse_mode = options.parse_mode;
  }
  if (options.link_preview_options) {
    formatOptions.link_preview_options = options.link_preview_options;
  }

  return Object.keys(formatOptions).length > 0 ? formatOptions : undefined;
};

const applyFormatOptions = (
  options: MessageFormatOptions | undefined,
): Pick<ExtraEditMessageText, 'parse_mode' | 'link_preview_options'> => ({
  parse_mode: options?.parse_mode,
  link_preview_options: options?.link_preview_options,
});

const DECISION_FAILURE_RESPONSE =
  'Не удалось обработать заявку. Требуется ручная проверка.';

const buildDecisionSuffix = (
  decision: ModerationDecision,
  moderator: ModeratorInfo,
  reason?: string,
): string => {
  const moderatorLabel = formatModerator(moderator);
  if (decision === 'approved') {
    return `✅ Одобрено модератором ${moderatorLabel}.`;
  }

  const cause = normaliseReason(reason);
  return `❌ Отклонено модератором ${moderatorLabel}. Причина: ${cause}.`;
};

const buildAlreadyProcessedResponse = (
  state: PendingModerationItem<any>,
): string => {
  if (state.failed) {
    return DECISION_FAILURE_RESPONSE;
  }

  if (state.decision?.status === 'approved') {
    const moderatorLabel = state.decision.moderator
      ? formatModerator(state.decision.moderator)
      : 'другим модератором';
    return `Заявка уже одобрена ${moderatorLabel}.`;
  }

  if (state.decision?.status === 'rejected') {
    const moderatorLabel = state.decision.moderator
      ? formatModerator(state.decision.moderator)
      : 'другим модератором';
    const cause = normaliseReason(state.decision.reason);
    return `Заявка уже отклонена ${moderatorLabel}. Причина: ${cause}.`;
  }

  return 'Заявка уже обработана.';
};

const ensureArray = (value: string | string[]): string[] =>
  Array.isArray(value) ? value : [value];

const buildMessageKeyboard = (
  token: string,
  reasons: string[],
  acceptAction: string,
  rejectAction: string,
): InlineKeyboardMarkup => {
  const rows: InlineKeyboardButton[][] = [
    [
      {
        text: '✅ Одобрить',
        callback_data: `${acceptAction}:${token}`,
      },
    ],
  ];

  reasons.forEach((reason, index) => {
    const trimmed = reason.trim();
    const label = trimmed ? `❌ ${trimmed}` : '❌ Отклонить';
    rows.push([
      {
        text: label,
        callback_data: `${rejectAction}:${token}:${index.toString(10)}`,
      },
    ]);
  });

  const manualIndex = reasons.length;
  const manualLabel =
    reasons.length > 0 ? '❌ Отклонить с комментарием' : '❌ Отклонить';
  rows.push([
    {
      text: manualLabel,
      callback_data: `${rejectAction}:${token}:${manualIndex.toString(10)}`,
    },
  ]);

  return { inline_keyboard: rows } satisfies InlineKeyboardMarkup;
};

const toModeratorInfo = (from?: BotContext['from']): ModeratorInfo => ({
  id: from?.id,
  username: from?.username ?? undefined,
  firstName: from?.first_name ?? undefined,
  lastName: from?.last_name ?? undefined,
});

interface MessageFormatOptions {
  parse_mode?: ExtraReplyMessage['parse_mode'];
  link_preview_options?: ExtraReplyMessage['link_preview_options'];
}

interface PendingModerationItem<T> {
  token: string;
  item: T;
  status: ModerationDecision | 'pending';
  message: {
    chatId: number;
    messageId: number;
    text: string;
    formatOptions?: MessageFormatOptions;
  };
  rejectionReasons: string[];
  failed?: boolean;
  decision?: {
    status: ModerationDecision;
    moderator?: ModeratorInfo;
    reason?: string;
    decidedAt: number;
  };
}

interface StoredModerationEntry<TSerialized> {
  token: string;
  item: TSerialized;
  status: PendingModerationItem<any>['status'];
  message: PendingModerationItem<any>['message'];
  rejectionReasons: string[];
  failed?: boolean;
  decision?: PendingModerationItem<any>['decision'];
}

const cloneSerializable = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export type ModerationDecision = 'approved' | 'rejected';

export interface ModeratorInfo {
  id?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface ModerationDecisionContext<T> {
  item: T;
  moderator: ModeratorInfo;
  decidedAt: number;
  telegram: Telegram;
}

export interface ModerationRejectionContext<T> extends ModerationDecisionContext<T> {
  reason: string;
}

export interface ModerationQueueItemBase<TContext = unknown> {
  id: string | number;
  /**
   * Optional list of rejection reasons to render in the inline keyboard.
   * When omitted, defaults from the queue configuration are used.
   */
  rejectionReasons?: string[];
  /**
   * Additional options to pass to `sendMessage` when publishing the item.
   */
  messageOptions?: ExtraReplyMessage;
  /**
   * Callback invoked after the item has been approved by a moderator.
   */
  onApprove?: (context: ModerationDecisionContext<TContext>) => void | Promise<void>;
  /**
   * Callback invoked after the item has been rejected by a moderator.
   */
  onReject?: (context: ModerationRejectionContext<TContext>) => void | Promise<void>;
}

export interface PublishModerationResult {
  status: 'published' | 'missing_channel';
  chatId?: number;
  messageId?: number;
  token?: string;
}

export interface ModerationQueueConfig<T extends ModerationQueueItemBase<T>> {
  /**
   * Unique identifier for the queue, used in callback data and logging.
   */
  type: string;
  /**
   * Channel binding type where items should be published.
   */
  channelType: ChannelType;
  /**
   * Fallback rejection reasons if none are provided by the published item.
   */
  defaultRejectionReasons: string[];
  /**
   * Function that renders a human-readable message for the moderation item.
   */
  renderMessage: (item: T) => string | string[];
  /**
   * Optional custom serialiser for moderation items.
   * When omitted, items are serialised using JSON.stringify/parse.
   */
  serializeItem?: (item: T) => unknown;
  /**
   * Optional custom deserialiser invoked when restoring persisted items.
   */
  deserializeItem?: (payload: unknown) => T | null;
}

export interface ModerationQueue<T extends ModerationQueueItemBase<T>> {
  publish: (telegram: Telegram, item: T) => Promise<PublishModerationResult>;
  register: (bot: Telegraf<BotContext>) => void;
  restore: () => Promise<void>;
}

export const createModerationQueue = <T extends ModerationQueueItemBase<T>>(
  config: ModerationQueueConfig<T>,
): ModerationQueue<T> => {
  const acceptAction = `mod:${config.type}:accept`;
  const rejectAction = `mod:${config.type}:reject`;
  const actionKey = `moderation:${config.type}`;
  const serializeItem = config.serializeItem ?? ((item: T) => cloneSerializable(item));
  const deserializeItem = config.deserializeItem ?? ((payload: unknown) => {
    if (payload === null || payload === undefined) {
      return null;
    }

    return payload as T;
  });
  const state = new Map<string, PendingModerationItem<T>>();
  const pendingRejectionPrompts = new Map<string, { token: string; moderatorId?: number }>();
  const promptsByToken = new Map<string, Set<string>>();
  let lastMissingChannelWarningAt = 0;

  const buildPromptKey = (chatId: number, messageId: number): string =>
    `${chatId.toString(10)}:${messageId.toString(10)}`;

  const registerPrompt = (
    token: string,
    chatId: number,
    messageId: number,
    moderatorId?: number,
  ): void => {
    const key = buildPromptKey(chatId, messageId);
    pendingRejectionPrompts.set(key, { token, moderatorId });

    let promptKeys = promptsByToken.get(token);
    if (!promptKeys) {
      promptKeys = new Set<string>();
      promptsByToken.set(token, promptKeys);
    }
    promptKeys.add(key);
  };

  const clearPromptByKey = (key: string): void => {
    const prompt = pendingRejectionPrompts.get(key);
    if (!prompt) {
      return;
    }

    pendingRejectionPrompts.delete(key);

    const promptKeys = promptsByToken.get(prompt.token);
    if (!promptKeys) {
      return;
    }

    promptKeys.delete(key);
    if (promptKeys.size === 0) {
      promptsByToken.delete(prompt.token);
    }
  };

  const clearPendingPromptsForToken = (token: string): void => {
    const keys = promptsByToken.get(token);
    if (!keys) {
      return;
    }

    for (const key of keys) {
      pendingRejectionPrompts.delete(key);
    }
    promptsByToken.delete(token);
  };

  const toStoredEntry = (
    entry: PendingModerationItem<T>,
  ): StoredModerationEntry<unknown> => ({
    token: entry.token,
    item: serializeItem(entry.item),
    status: entry.status,
    message: entry.message,
    rejectionReasons: entry.rejectionReasons,
    failed: entry.failed === true ? true : undefined,
    decision: entry.decision,
  });

  const persistEntry = async (entry: PendingModerationItem<T>): Promise<void> => {
    const payload = toStoredEntry(entry);
    const expiresAt = new Date(Date.now() + MODERATION_TOKEN_TTL_MS);

    try {
      await upsertCallbackMapRecord<StoredModerationEntry<unknown>>({
        token: entry.token,
        action: actionKey,
        chatId: entry.message.chatId,
        messageId: entry.message.messageId,
        payload,
        expiresAt,
      });
    } catch (error) {
      logger.error(
        { err: error, queue: config.type, token: entry.token },
        'Failed to persist moderation entry',
      );
    }
  };

  const removePersistedEntry = async (token: string): Promise<void> => {
    try {
      await deleteCallbackMapRecord(token);
    } catch (error) {
      logger.error(
        { err: error, queue: config.type, token },
        'Failed to remove moderation entry from store',
      );
    }
  };

  const hydrateStoredEntry = (
    token: string,
    stored: StoredModerationEntry<unknown>,
  ): PendingModerationItem<T> | null => {
    const item = deserializeItem(stored.item);
    if (!item) {
      return null;
    }

    const rejectionReasons = Array.isArray(stored.rejectionReasons)
      ? stored.rejectionReasons
      : [];

    const entry: PendingModerationItem<T> = {
      token,
      item,
      status: stored.status ?? 'pending',
      message: stored.message,
      rejectionReasons,
      failed: stored.failed === true ? true : undefined,
      decision: stored.decision,
    } satisfies PendingModerationItem<T>;

    return entry;
  };

  const loadEntryFromStore = async (
    token: string,
  ): Promise<PendingModerationItem<T> | undefined> => {
    try {
      const record = await loadCallbackMapRecord<StoredModerationEntry<unknown>>(token);
      if (!record || record.action !== actionKey || !record.payload) {
        return undefined;
      }

      const entry = hydrateStoredEntry(record.token, record.payload);
      if (!entry) {
        logger.warn(
          { queue: config.type, token },
          'Failed to restore moderation entry payload',
        );
        return undefined;
      }

      state.set(record.token, entry);
      return entry;
    } catch (error) {
      logger.error(
        { err: error, queue: config.type, token },
        'Failed to load moderation entry from store',
      );
      return undefined;
    }
  };

  const getEntry = async (token: string): Promise<PendingModerationItem<T> | undefined> => {
    const existing = state.get(token);
    if (existing) {
      return existing;
    }

    return loadEntryFromStore(token);
  };

  const restore = async (): Promise<void> => {
    try {
      const records = await listCallbackMapRecords<StoredModerationEntry<unknown>>(actionKey);
      for (const record of records) {
        if (!record.payload) {
          continue;
        }

        const entry = hydrateStoredEntry(record.token, record.payload);
        if (!entry) {
          logger.warn(
            { queue: config.type, token: record.token },
            'Failed to restore moderation entry during bootstrap',
          );
          continue;
        }

        state.set(record.token, entry);
      }
    } catch (error) {
      logger.error(
        { err: error, queue: config.type },
        'Failed to restore moderation queue state',
      );
    }
  };

  const publish = async (telegram: Telegram, item: T): Promise<PublishModerationResult> => {
    const binding = await getChannelBinding(config.channelType);
    if (!binding) {
      const now = Date.now();
      if (now - lastMissingChannelWarningAt > MISSING_CHANNEL_WARNING_THROTTLE_MS) {
        logger.warn(
          { queue: config.type, itemId: item.id },
          'Target moderation channel is not configured, skipping publish',
        );
        lastMissingChannelWarningAt = now;
      }
      return { status: 'missing_channel' };
    }

    lastMissingChannelWarningAt = 0;

    const messageText = ensureArray(config.renderMessage(item)).join('\n');
    const rejectionReasons =
      item.rejectionReasons && item.rejectionReasons.length > 0
        ? item.rejectionReasons
        : config.defaultRejectionReasons;

    const token = createToken();
    const keyboard = buildMessageKeyboard(token, rejectionReasons, acceptAction, rejectAction);
    const message = await telegram.sendMessage(binding.chatId, messageText, {
      ...item.messageOptions,
      reply_markup: keyboard,
    });

    const entry: PendingModerationItem<T> = {
      token,
      item,
      status: 'pending',
      message: {
        chatId: binding.chatId,
        messageId: message.message_id,
        text: messageText,
        formatOptions: pickFormatOptions(item.messageOptions),
      },
      rejectionReasons,
    } satisfies PendingModerationItem<T>;

    state.set(token, entry);
    await persistEntry(entry);

    return {
      status: 'published',
      chatId: binding.chatId,
      messageId: message.message_id,
      token,
    } satisfies PublishModerationResult;
  };

  const updateMessage = async (
    telegram: Telegram,
    entry: PendingModerationItem<T>,
    decision: ModerationDecision,
    moderator: ModeratorInfo,
    reason?: string,
  ): Promise<void> => {
    const suffix = buildDecisionSuffix(decision, moderator, reason);
    const newText = `${entry.message.text}\n\n${suffix}`.trim();

    try {
      await telegram.editMessageText(
        entry.message.chatId,
        entry.message.messageId,
        undefined,
        newText,
        {
          ...applyFormatOptions(entry.message.formatOptions),
          reply_markup: { inline_keyboard: [] },
        },
      );
    } catch (error) {
      logger.warn(
        {
          err: error,
          queue: config.type,
          chatId: entry.message.chatId,
          messageId: entry.message.messageId,
        },
        'Failed to update moderation message after decision',
      );
    }
  };

  const applyDecision = async (
    telegram: Telegram,
    entry: PendingModerationItem<T>,
    decision: ModerationDecision,
    moderator: ModeratorInfo,
    decidedAt: number,
    reason?: string,
  ): Promise<string> => {
    if (entry.failed) {
      return DECISION_FAILURE_RESPONSE;
    }

    const rejectionReason = normaliseReason(reason);

    try {
      if (decision === 'approved') {
        await entry.item.onApprove?.({
          item: entry.item,
          moderator,
          decidedAt,
          telegram,
        });
      } else {
        await entry.item.onReject?.({
          item: entry.item,
          moderator,
          decidedAt,
          telegram,
          reason: rejectionReason,
        });
      }
    } catch (callbackError) {
      logger.error(
        { err: callbackError, queue: config.type, itemId: entry.item.id },
        'Error while running moderation decision callback',
      );
      entry.failed = true;
      entry.status = 'pending';
      entry.decision = undefined;
      clearPendingPromptsForToken(entry.token);
      await persistEntry(entry);
      logger.warn(
        { queue: config.type, itemId: entry.item.id, token: entry.token, decision },
        'Moderation decision requires manual review after callback failure',
      );
      return DECISION_FAILURE_RESPONSE;
    }

    entry.status = decision;
    entry.decision = {
      status: decision,
      moderator,
      reason,
      decidedAt,
    };

    await updateMessage(telegram, entry, decision, moderator, reason);

    clearPendingPromptsForToken(entry.token);
    await removePersistedEntry(entry.token);

    return decision === 'approved'
      ? 'Заявка одобрена.'
      : `Заявка отклонена (${rejectionReason}).`;
  };

  const resolveDecision = async (
    ctx: BotContext,
    token: string,
    decision: ModerationDecision,
    reason?: string,
  ): Promise<void> => {
    const entry = await getEntry(token);
    if (!entry) {
      await ctx.answerCbQuery('Не удалось найти заявку. Вероятно, она уже обработана.');
      return;
    }

    if (entry.failed) {
      await ctx.answerCbQuery(DECISION_FAILURE_RESPONSE, { show_alert: true });
      return;
    }

    const chatId = ctx.chat?.id;
    const isPrivateChat = ctx.chat?.type === 'private';
    const isModerationChat = chatId !== undefined && chatId === entry.message.chatId;
    if (!isPrivateChat && !isModerationChat) {
      await ctx.answerCbQuery('Действие доступно только в личном чате с ботом или в чате модерации.');
      return;
    }

    if (entry.status !== 'pending') {
      await ctx.answerCbQuery(buildAlreadyProcessedResponse(entry));
      return;
    }

    const moderator = toModeratorInfo(ctx.from);
    const decidedAt = Date.now();
    const responseMessage = await applyDecision(
      ctx.telegram,
      entry,
      decision,
      moderator,
      decidedAt,
      reason,
    );
    await ctx.answerCbQuery(responseMessage);
  };

  const promptRejectionReason = async (
    ctx: BotContext,
    token: string,
    reasonIndex: number,
  ): Promise<void> => {
    const entry = await getEntry(token);
    if (!entry) {
      await ctx.answerCbQuery('Не удалось найти заявку. Вероятно, она уже обработана.');
      return;
    }

    if (entry.failed) {
      await ctx.answerCbQuery(DECISION_FAILURE_RESPONSE, { show_alert: true });
      return;
    }

    const chatId = ctx.chat?.id;
    const isPrivateChat = ctx.chat?.type === 'private';
    const isModerationChat = chatId !== undefined && chatId === entry.message.chatId;
    if (!isPrivateChat && !isModerationChat) {
      await ctx.answerCbQuery('Доступно только в личном чате с ботом или в чате модерации.');
      return;
    }

    if (entry.status !== 'pending') {
      await ctx.answerCbQuery(buildAlreadyProcessedResponse(entry));
      return;
    }

    if (chatId === undefined) {
      await ctx.answerCbQuery('Не удалось запросить причину отклонения. Попробуйте ещё раз.');
      return;
    }

    const suggestion = entry.rejectionReasons?.[reasonIndex];
    const trimmedSuggestion = suggestion?.trim();

    if (trimmedSuggestion) {
      await resolveDecision(ctx, token, 'rejected', trimmedSuggestion);
      return;
    }

    const promptLines = [
      'Укажите причину отклонения заявки в ответ на это сообщение.',
      suggestion ? `Предложенный вариант: ${suggestion}` : undefined,
    ].filter((value): value is string => Boolean(value && value.trim().length > 0));
    const promptText = promptLines.join('\n') || 'Укажите причину отклонения заявки в ответ на это сообщение.';

    try {
      const forceReply: ForceReply = { force_reply: true, selective: true };
      const prompt = await ctx.reply(promptText, { reply_markup: forceReply });
      registerPrompt(token, prompt.chat.id, prompt.message_id, ctx.from?.id);
      await ctx.answerCbQuery('Отправьте причину отклонения сообщением.');
    } catch (error) {
      logger.error(
        { err: error, queue: config.type, chatId, token },
        'Failed to request moderation rejection reason',
      );
      await ctx.answerCbQuery('Не удалось запросить причину. Попробуйте ещё раз.');
    }
  };

  const register = (bot: Telegraf<BotContext>): void => {
    const acceptPattern = new RegExp(`^${acceptAction}:([a-f0-9]+)$`);
    const rejectPattern = new RegExp(`^${rejectAction}:([a-f0-9]+):(\d+)$`);

    bot.action(acceptPattern, async (ctx) => {
      const match = ctx.match as RegExpMatchArray | undefined;
      const token = match?.[1];
      if (!token) {
        await ctx.answerCbQuery('Некорректное действие.');
        return;
      }

      await resolveDecision(ctx, token, 'approved');
    });

    bot.action(rejectPattern, async (ctx) => {
      const match = ctx.match as RegExpMatchArray | undefined;
      const token = match?.[1];
      const indexText = match?.[2];
      if (!token || !indexText) {
        await ctx.answerCbQuery('Некорректное действие.');
        return;
      }

      const index = Number.parseInt(indexText, 10);
      if (Number.isNaN(index)) {
        await ctx.answerCbQuery('Некорректное действие.');
        return;
      }

      await promptRejectionReason(ctx, token, index);
    });

    bot.on('text', async (ctx, next) => {
      const replyTo = ctx.message.reply_to_message;
      const chatId = ctx.chat?.id;
      if (!replyTo || chatId === undefined) {
        if (next) {
          await next();
        }
        return;
      }

      const promptKey = buildPromptKey(chatId, replyTo.message_id);
      const prompt = pendingRejectionPrompts.get(promptKey);
      if (!prompt) {
        if (next) {
          await next();
        }
        return;
      }

      if (prompt.moderatorId !== undefined && ctx.from?.id !== prompt.moderatorId) {
        if (next) {
          await next();
        }
        return;
      }

      const entry = await getEntry(prompt.token);
      if (!entry) {
        clearPendingPromptsForToken(prompt.token);
        await ctx.reply('Заявка уже обработана.', {
          reply_parameters: {
            message_id: ctx.message.message_id,
            allow_sending_without_reply: true,
          },
        });
        return;
      }

      if (entry.failed) {
        clearPromptByKey(promptKey);
        await ctx.reply(DECISION_FAILURE_RESPONSE, {
          reply_parameters: {
            message_id: ctx.message.message_id,
            allow_sending_without_reply: true,
          },
        });
        return;
      }

      if (entry.status !== 'pending') {
        clearPendingPromptsForToken(prompt.token);
        await ctx.reply(buildAlreadyProcessedResponse(entry), {
          reply_parameters: {
            message_id: ctx.message.message_id,
            allow_sending_without_reply: true,
          },
        });
        return;
      }

      const reason = ctx.message.text?.trim();
      if (!reason) {
        await ctx.reply('Причина отклонения не может быть пустой. Укажите её, пожалуйста.', {
          reply_parameters: {
            message_id: replyTo.message_id,
            allow_sending_without_reply: true,
          },
        });
        return;
      }

      clearPromptByKey(promptKey);

      const moderator = toModeratorInfo(ctx.from);
      const decidedAt = Date.now();
      const responseMessage = await applyDecision(
        ctx.telegram,
        entry,
        'rejected',
        moderator,
        decidedAt,
        reason,
      );

      try {
        await ctx.reply(responseMessage, {
          reply_parameters: {
            message_id: ctx.message.message_id,
            allow_sending_without_reply: true,
          },
        });
      } catch (error) {
        logger.warn(
          {
            err: error,
            queue: config.type,
            chatId,
            token: prompt.token,
          },
          'Failed to acknowledge moderation decision in chat',
        );
      }
    });
  };

  return {
    publish,
    register,
    restore,
  } satisfies ModerationQueue<T>;
};
