import type { MiddlewareFn } from 'telegraf';

import { config, logger } from '../../config';
import { deleteCallbackMapRecord, loadCallbackMapRecord } from '../../db/callbackMap';
import { withLatencyLog } from '../../metrics/latency';
import { sampleLatency } from '../../metrics/agg';
import { isShortCallbackId } from '../../utils/ids';
import type { BotContext } from '../types';
import { renderMenuFor } from '../ui/menus';
import {
  CALLBACK_SURROGATE_ACTION,
  CALLBACK_SURROGATE_TOKEN_PREFIX,
  type CallbackSurrogatePayload,
  tryDecodeCallbackData,
  verifyCallbackData,
  verifyCallbackForUser,
} from '../services/callbackTokens';
import { copy } from '../copy';

const resolveSecret = (): string => config.bot.hmacSecret;

const handleInvalidCallback = async (ctx: BotContext): Promise<void> => {
  const chatType = ctx.chat?.type;
  const isPrivateChat = chatType === 'private';

  if (typeof ctx.answerCbQuery === 'function') {
    try {
      await ctx.answerCbQuery(copy.expiredButtonToast ?? copy.expiredButton, {
        show_alert: false,
      });
    } catch (error) {
      logger.debug({ err: error }, 'Failed to answer callback query in callbackDecoder');
    }
  }

  if (!isPrivateChat) {
    return;
  }

  try {
    await renderMenuFor(ctx, { prompt: copy.expiredButton });
  } catch (error) {
    logger.debug({ err: error }, 'Failed to render menu after invalid callback payload');
  }
};

const resolveSurrogatePayload = async (
  token: string,
): Promise<CallbackSurrogatePayload | null> => {
  try {
    const record = await loadCallbackMapRecord<CallbackSurrogatePayload>(token);
    if (!record || record.action !== CALLBACK_SURROGATE_ACTION) {
      return null;
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      try {
        await deleteCallbackMapRecord(token);
      } catch (error) {
        logger.debug({ err: error, token }, 'Failed to delete expired callback surrogate');
      }
      return null;
    }

    return record.payload;
  } catch (error) {
    logger.error({ err: error, token }, 'Failed to load callback surrogate payload');
    return null;
  }
};

export const callbackDecoder = (): MiddlewareFn<BotContext> => async (ctx, next) => {
  const query = ctx.callbackQuery;
  if (!query || !('data' in query) || typeof query.data !== 'string') {
    await next();
    return;
  }

  let data = query.data;

  if (isShortCallbackId(data, CALLBACK_SURROGATE_TOKEN_PREFIX)) {
    const surrogate = await resolveSurrogatePayload(data);
    if (!surrogate) {
      await handleInvalidCallback(ctx);
      return;
    }

    data = surrogate.data;
    (query as { data?: string }).data = data;
  }

  const decoded = tryDecodeCallbackData(data);
  if (!decoded.ok) {
    await next();
    return;
  }

  const secret = resolveSecret();
  const requiresUserBinding = Boolean(decoded.wrapped.user || decoded.wrapped.nonce);
  const isValid = requiresUserBinding
    ? verifyCallbackForUser(ctx, decoded.wrapped, secret)
    : verifyCallbackData(decoded.wrapped, secret);

  if (!isValid) {
    await handleInvalidCallback(ctx);
    return;
  }

  const state = ctx.state as Record<string, unknown>;
  state.callbackPayload = decoded.wrapped;
  (query as { data?: string }).data = decoded.wrapped.raw;

  const startedAt = Date.now();
  try {
    await withLatencyLog(`callback:${decoded.wrapped.raw}`, async () => {
      await next();
    });
  } finally {
    sampleLatency('callback', Date.now() - startedAt);
  }
};

