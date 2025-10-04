import { Markup } from 'telegraf';
import type {
  InlineKeyboardMarkup,
  LinkPreviewOptions,
  ParseMode,
  ReplyKeyboardMarkup,
} from 'telegraf/typings/core/types/typegram';

import { config, logger } from '../config';
import { pool } from '../db';
import { updateFlowMeta } from '../db/sessions';
import { mergeInlineKeyboards, buildInlineKeyboard } from './keyboards/common';
import type { BotContext, UiSessionState } from './types';
import { resolveSessionKey } from './middlewares/session';
import { bindInlineKeyboardToUser } from './services/callbackTokens';
import { copy } from './copy';

const HOME_BUTTON_LABEL = copy.home;

export const contactModeratorBtn = () =>
  Markup.button.url('📤 Отправить чек', config.support.url);

export interface FlowRecoveryDescriptor {
  type: string;
  payload?: unknown;
}

export interface UiTrackOptions {
  /** Identifier of the step whose metadata is being tracked. */
  id: string;
  /** Action triggered when the user presses the automatically added «На главную» button. */
  homeAction?: string;
  /** Information that allows restoring the step after a failure. */
  recovery?: FlowRecoveryDescriptor;
  /** Arbitrary payload stored alongside the flow state (used by nudger, hints, etc.). */
  payload?: unknown;
}

const ensureUiState = (ctx: BotContext): UiSessionState => {
  if (!ctx.session.ui) {
    ctx.session.ui = {
      steps: {},
      homeActions: [],
      pendingCityAction: undefined,
      clientMenuVariant: undefined,
    } satisfies UiSessionState;
  }

  return ctx.session.ui;
};

const isMessageNotModifiedError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const description = (error as { description?: unknown }).description;
  if (typeof description === 'string' && description.includes('message is not modified')) {
    return true;
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('message is not modified');
};

const isReplyMessageNotFoundError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const description = (error as { description?: unknown }).description;
  if (
    typeof description === 'string' &&
    (description.includes('message to reply not found') ||
      description.includes('reply message not found') ||
      description.includes('REPLY_MESSAGE_NOT_FOUND'))
  ) {
    return true;
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') {
    return false;
  }

  return (
    message.includes('message to reply not found') ||
    message.includes('reply message not found') ||
    message.includes('REPLY_MESSAGE_NOT_FOUND')
  );
};

const registerHomeAction = (state: UiSessionState, action: string): void => {
  if (!state.homeActions.includes(action)) {
    state.homeActions.push(action);
  }
};

const appendHomeButton = (
  keyboard: InlineKeyboardMarkup | undefined,
  action: string,
  label = HOME_BUTTON_LABEL,
): InlineKeyboardMarkup => {
  const homeKeyboard = buildInlineKeyboard([[{ label, action }]]);
  return mergeInlineKeyboards(keyboard, homeKeyboard) ?? homeKeyboard;
};

const trackFlowStep = async (ctx: BotContext, options: UiTrackOptions): Promise<void> => {
  try {
    const key = resolveSessionKey(ctx);
    if (!key) {
      return;
    }

    const payload: Record<string, unknown> = {
      homeAction: options.homeAction ?? null,
      recovery: options.recovery ?? null,
    };

    if (options.payload !== undefined) {
      if (options.payload && typeof options.payload === 'object') {
        Object.assign(payload, options.payload as Record<string, unknown>);
      } else {
        payload.payload = options.payload;
      }
    }

    await updateFlowMeta(pool, key, options.id, payload);
  } catch (error) {
    logger.debug({ err: error, stepId: options.id }, 'Failed to update flow metadata');
  }
};

const isInlineKeyboard = (
  keyboard: InlineKeyboardMarkup | ReplyKeyboardMarkup | undefined,
): keyboard is InlineKeyboardMarkup | undefined =>
  !keyboard || 'inline_keyboard' in keyboard;

export interface UiStepOptions extends UiTrackOptions {
  /** Text displayed in the step message. */
  text: string;
  /** Optional keyboard shown alongside the message. */
  keyboard?: InlineKeyboardMarkup | ReplyKeyboardMarkup;
  /** Parse mode used when sending the message. */
  parseMode?: ParseMode;
  /** Link preview behaviour configuration. */
  linkPreviewOptions?: LinkPreviewOptions;
  /** Custom label for the «На главную» button. */
  homeLabel?: string;
  /** Whether the step should be removed when navigating home. */
  cleanup?: boolean;
  /** Identifier of the forum topic where the step should be posted. */
  messageThreadId?: number;
}

export interface UiStepResult {
  /** Identifier of the Telegram message associated with the step. */
  messageId: number;
  /** Indicates whether a brand new message was sent. */
  sent: boolean;
}

export interface UiClearOptions {
  /** Identifiers of the steps to clear. */
  ids?: string | string[];
  /** Whether only steps marked for cleanup should be removed. */
  cleanupOnly?: boolean;
}

export const ui = {
  step: async (ctx: BotContext, options: UiStepOptions): Promise<UiStepResult | undefined> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return undefined;
    }

    const state = ensureUiState(ctx);
    const cleanup = options.cleanup ?? Boolean(options.homeAction);

    let replyMarkup = options.keyboard;
    if (options.homeAction) {
      registerHomeAction(state, options.homeAction);

      if (isInlineKeyboard(replyMarkup)) {
        replyMarkup = appendHomeButton(
          replyMarkup,
          options.homeAction,
          options.homeLabel,
        );
      }
    }

    const existing = state.steps[options.id];
    if (isInlineKeyboard(replyMarkup)) {
      replyMarkup = await bindInlineKeyboardToUser(ctx, replyMarkup);
    }
    if (existing && existing.chatId === chatId && isInlineKeyboard(replyMarkup)) {
      try {
        await ctx.telegram.editMessageText(chatId, existing.messageId, undefined, options.text, {
          parse_mode: options.parseMode,
          reply_markup: replyMarkup,
          link_preview_options: options.linkPreviewOptions,
        });
        existing.cleanup = cleanup;
        await trackFlowStep(ctx, options);
        return { messageId: existing.messageId, sent: false };
      } catch (error) {
        if (isMessageNotModifiedError(error)) {
          logger.debug(
            { chatId, messageId: existing.messageId, stepId: options.id },
            'Step message not modified, skipping edit',
          );
          existing.cleanup = cleanup;
          await trackFlowStep(ctx, options);
          return { messageId: existing.messageId, sent: false };
        }

        logger.debug(
          { err: error, chatId, messageId: existing.messageId, stepId: options.id },
          'Failed to edit step message, sending a new one',
        );
      }
    }

    const extra = {
      reply_markup: replyMarkup,
      parse_mode: options.parseMode,
      link_preview_options: options.linkPreviewOptions,
      ...(options.messageThreadId !== undefined
        ? { message_thread_id: options.messageThreadId }
        : {}),
    };

    let message;
    try {
      message = await ctx.reply(options.text, extra);
    } catch (error) {
      if (!isReplyMessageNotFoundError(error)) {
        throw error;
      }

      logger.debug(
        { err: error, chatId, stepId: options.id },
        'Reply failed, retrying step message without reply reference',
      );

      message = await ctx.telegram.sendMessage(chatId, options.text, extra);
    }

    const messageId = message.message_id;
    state.steps[options.id] = { chatId, messageId, cleanup };
    await trackFlowStep(ctx, options);
    return { messageId, sent: true };
  },
  trackStep: async (ctx: BotContext, options: UiTrackOptions): Promise<void> => {
    const state = ensureUiState(ctx);
    if (options.homeAction) {
      registerHomeAction(state, options.homeAction);
    }

    await trackFlowStep(ctx, options);
  },
  clear: async (ctx: BotContext, options: UiClearOptions = {}): Promise<void> => {
    const state = ensureUiState(ctx);
    const entries = Object.entries(state.steps);
    if (entries.length === 0) {
      return;
    }

    const ids =
      options.ids === undefined
        ? undefined
        : Array.isArray(options.ids)
          ? options.ids
          : [options.ids];
    const cleanupOnly = options.cleanupOnly ?? true;

    for (const [stepId, step] of entries) {
      if (!step) {
        delete state.steps[stepId];
        continue;
      }

      if (ids && !ids.includes(stepId)) {
        continue;
      }

      if (cleanupOnly && !step.cleanup) {
        continue;
      }

      try {
        await ctx.telegram.deleteMessage(step.chatId, step.messageId);
      } catch (error) {
        logger.debug(
          { err: error, chatId: step.chatId, messageId: step.messageId, stepId },
          'Failed to delete step message',
        );
      }

      delete state.steps[stepId];
    }
  },
};
