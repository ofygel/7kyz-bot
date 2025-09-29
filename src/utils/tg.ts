import type { Telegram } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import { sleep } from './time';

const RETRYABLE_ERROR_CODES = new Set([429, 500, 502, 503, 504]);

interface TelegramErrorLike {
  message?: string;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
  response?: {
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  };
}

const getTelegramErrorCode = (error: unknown): number | undefined => {
  const telegramError = error as TelegramErrorLike;
  return telegramError?.error_code ?? telegramError?.response?.error_code;
};

const getTelegramErrorDescription = (error: unknown): string | undefined => {
  const telegramError = error as TelegramErrorLike;
  return (
    telegramError?.description ??
    telegramError?.response?.description ??
    telegramError?.message
  );
};

export const parseRetryAfterMs = (error: unknown): number | null => {
  const telegramError = error as TelegramErrorLike;
  const retryAfter =
    telegramError?.parameters?.retry_after ??
    telegramError?.response?.parameters?.retry_after;

  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    return retryAfter * 1000;
  }

  const description = getTelegramErrorDescription(error);
  if (description) {
    const match = description.match(/retry after (\d+)/i);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isInteger(parsed)) {
        return parsed * 1000;
      }
    }
  }

  return null;
};

export const isRetryableTelegramError = (error: unknown): boolean => {
  const code = getTelegramErrorCode(error);
  if (code !== undefined) {
    return RETRYABLE_ERROR_CODES.has(code);
  }

  const description = getTelegramErrorDescription(error);
  return Boolean(description && /retry after/i.test(description));
};

export interface TelegramRetryOptions {
  /** Maximum number of attempts including the initial one. */
  attempts?: number;
  /** Delay between retries when `retry_after` is not provided. */
  baseDelayMs?: number;
  /** Optional cap for exponentially growing delay. */
  maxDelayMs?: number;
  /** Invoked before sleeping prior to the next retry attempt. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export const withTelegramRetries = async <T>(
  operation: () => Promise<T>,
  options: TelegramRetryOptions = {},
): Promise<T> => {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelay = Math.max(0, options.baseDelayMs ?? 500);
  const maxDelay = options.maxDelayMs ?? baseDelay * 10;

  let lastError: unknown;
  let delay = baseDelay;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt >= attempts || !isRetryableTelegramError(error)) {
        throw error;
      }

      const retryAfter = parseRetryAfterMs(error);
      const waitFor = retryAfter ?? Math.min(delay, maxDelay);
      options.onRetry?.(error, attempt, waitFor);
      await sleep(waitFor);
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  throw lastError ?? new Error('Telegram retry operation failed');
};

export const safeEditReplyMarkup = async (
  telegram: Telegram,
  chatId: number,
  messageId: number,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<boolean> => {
  try {
    await withTelegramRetries(() =>
      telegram.editMessageReplyMarkup(chatId, messageId, undefined, replyMarkup),
    );
    return true;
  } catch (error) {
    return false;
  }
};

export const safeDeleteMessage = async (
  telegram: Telegram,
  chatId: number,
  messageId: number,
): Promise<boolean> => {
  try {
    await withTelegramRetries(() => telegram.deleteMessage(chatId, messageId));
    return true;
  } catch (error) {
    return false;
  }
};

export const safeAnswerCallback = async (
  telegram: Telegram,
  callbackQueryId: string,
  text?: string,
): Promise<boolean> => {
  try {
    await withTelegramRetries(() => telegram.answerCbQuery(callbackQueryId, text));
    return true;
  } catch (error) {
    return false;
  }
};
