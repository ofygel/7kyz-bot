import { Telegraf } from 'telegraf';

import { logger } from '../../../config';
import { withTx } from '../../../db/client';
import {
  findActiveOrderForExecutor,
  getOrderById,
  listOpenOrdersByCity,
  lockOrderById,
  tryClaimOrder,
  tryCompleteOrder,
  tryReleaseOrder,
} from '../../../db/orders';
import { getChannelBinding } from '../../channels/bindings';
import {
  publishOrderToDriversChannel,
  buildOrderDetailsMessage,
} from '../../channels/ordersChannel';
import { CITY_LABEL, type AppCity } from '../../../domain/cities';
import { buildOrderLocationsKeyboard } from '../../keyboards/orders';
import {
  buildInlineKeyboard,
  mergeInlineKeyboards,
} from '../../keyboards/common';
import type { KeyboardButton } from '../../keyboards/common';
import { copy } from '../../copy';
import { ui } from '../../ui';
import { sendClientMenuToChat } from '../../../ui/clientMenu';
import { withIdempotency } from '../../middlewares/idempotency';
import { sendProcessingFeedback } from '../../services/feedback';
import {
  reportJobCompleted,
  reportJobFeedViewed,
  reportJobReleased,
  reportJobViewed,
  reportJobTaken,
  reportOrderClaimed,
  reportOrderCompleted,
  reportOrderReleased,
  toUserIdentity,
} from '../../services/reports';
import type { BotContext, ExecutorFlowState } from '../../types';
import { EXECUTOR_MENU_ACTION, ensureExecutorState, requireExecutorRole } from './menu';
import { ensureCitySelected } from '../common/citySelect';
import { askPhone } from '../../middlewares/askPhone';
import type { OrderRecord } from '../../../types';
import { formatEtaMinutes } from '../../services/pricing';
import type { BotContext } from '../../types';

const SUPPORT_USERNAME = 'support_seven';

export const processOrdersRequest = async (ctx: BotContext): Promise<void> => {
  if (ctx.chat?.type !== 'private') {

    if (typeof ctx.answerCbQuery === 'function') {
      await ctx.answerCbQuery('Доступно только в личных сообщениях.');
    }
    return false;
  }
  return true;
};

export const ensureExecutorReady = async (
  ctx: BotContext,
  _state: ExecutorFlowState,
): Promise<boolean> => {
  const user = ctx.auth.user;

  if (user.isBlocked || user.status === 'suspended' || user.status === 'banned') {
    await ctx.reply(copy.orderAccessBlocked);
    return false;
  }

  const hasPhone = Boolean(ctx.session.phoneNumber || user.phone || user.phoneVerified);

  if (!hasPhone) {
    await askPhone(ctx);
    return false;
  }

  return true;
};

const loadActiveOrder = async (ctx: BotContext): Promise<OrderRecord | null> => {
  const executorId = ctx.auth.user.telegramId;
  if (typeof executorId !== 'number') {
    ctx.auth.user.hasActiveOrder = false;
    return null;
  }

  try {
    const order = await findActiveOrderForExecutor(executorId);
    ctx.auth.user.hasActiveOrder = Boolean(order);
    return order;
  } catch (error) {
    logger.error({ err: error, executorId }, 'Failed to load active order for executor');
    ctx.auth.user.hasActiveOrder = false;
    return null;
  }
};

const loadFeedOrders = async (city: AppCity): Promise<OrderRecord[]> => {
  try {
    return await listOpenOrdersByCity({ city, limit: FEED_LIMIT });
  } catch (error) {
    logger.error({ err: error, city }, 'Failed to load job feed orders');
    return [];
  }
};

interface ClaimOutcomeClaimed {
  status: 'claimed';
  order: OrderRecord;
}

interface ClaimOutcomeFailure {
  status:
    | 'not_found'
    | 'already_taken'
    | 'city_mismatch'
    | 'forbidden_kind'
    | 'phone_required'
    | 'blocked'
    | 'limit_exceeded';
  order?: OrderRecord;
}

type ClaimOutcome = ClaimOutcomeClaimed | ClaimOutcomeFailure;

export const attemptClaimOrder = async (
  ctx: BotContext,
  state: ExecutorFlowState,
  city: AppCity,
  orderId: number,
): Promise<ClaimOutcome> => {
  const executorId = ctx.auth.user.telegramId;
  if (typeof executorId !== 'number') {
    return { status: 'not_found' };
  }

  const role = requireExecutorRole(state);
  const executorKind = ctx.auth.user.executorKind;

  if (ctx.auth.user.isBlocked || ctx.auth.user.status === 'suspended' || ctx.auth.user.status === 'banned') {
    return { status: 'blocked' };
  }

  const hasPhone = Boolean(ctx.auth.user.phone ?? ctx.session.phoneNumber);
  if (!hasPhone) {
    return { status: 'phone_required' };
  }

  try {
    return await withTx(async (client) => {
      const current = await lockOrderById(client, orderId);
      if (!current) {
        return { status: 'not_found' };
      }

      if (current.status !== 'open') {
        return { status: 'already_taken', order: current };
      }

      if (current.city !== city) {
        return { status: 'city_mismatch', order: current };
      }

      if (current.kind === 'taxi') {
        if (role !== 'driver' || executorKind !== 'driver') {
          return { status: 'forbidden_kind', order: current };
        }
      }

      if (role === 'driver') {
        const { rows } = await client.query<{ id: number }>(
          `SELECT id FROM orders WHERE claimed_by = $1 AND status = 'claimed' LIMIT 1`,
          [executorId],
        );
        if (rows.length > 0) {
          return { status: 'limit_exceeded' };
        }
      }

      const updated = await tryClaimOrder(client, orderId, executorId, city);
      if (!updated) {
        return { status: 'already_taken', order: current };
      }

      ctx.auth.user.hasActiveOrder = true;
      return { status: 'claimed', order: updated };
    });
  } catch (error) {
    logger.error({ err: error, orderId, executorId }, 'Failed to claim order from job feed');
    return { status: 'not_found' };
  }
};

type ReleaseOutcome =
  | { status: 'released'; order: OrderRecord }
  | { status: 'not_found' }
  | { status: 'forbidden'; order?: OrderRecord };

const attemptReleaseOrder = async (
  ctx: BotContext,
  orderId: number,
): Promise<ReleaseOutcome> => {
  const executorId = ctx.auth.user.telegramId;
  if (typeof executorId !== 'number') {
    return { status: 'not_found' };
  }

  try {
    return await withTx(async (client) => {
      const current = await lockOrderById(client, orderId);
      if (!current) {
        return { status: 'not_found' };
      }

      if (current.status !== 'claimed' || current.claimedBy !== executorId) {
        return { status: 'forbidden', order: current };
      }

      const updated = await tryReleaseOrder(client, orderId, executorId);
      if (!updated) {
        throw new Error(`Failed to release order ${orderId}`);
      }

      ctx.auth.user.hasActiveOrder = false;
      return { status: 'released', order: updated };
    });
  } catch (error) {
    logger.error({ err: error, orderId, executorId }, 'Failed to release order from job feed');
    return { status: 'forbidden' };
  }
};

type CompletionOutcome =
  | { status: 'completed'; order: OrderRecord }
  | { status: 'not_found' }
  | { status: 'forbidden'; order?: OrderRecord };

const attemptCompleteOrder = async (
  ctx: BotContext,
  orderId: number,
): Promise<CompletionOutcome> => {
  const executorId = ctx.auth.user.telegramId;
  if (typeof executorId !== 'number') {
    return { status: 'not_found' };
  }

  try {
    return await withTx(async (client) => {
      const current = await lockOrderById(client, orderId);
      if (!current) {
        return { status: 'not_found' };
      }

      if (current.status !== 'claimed' || current.claimedBy !== executorId) {
        return { status: 'forbidden', order: current };
      }

      const updated = await tryCompleteOrder(client, orderId, executorId);
      if (!updated) {
        throw new Error(`Failed to complete order ${orderId}`);
      }

      ctx.auth.user.hasActiveOrder = false;
      return { status: 'completed', order: updated };
    });
  } catch (error) {
    logger.error({ err: error, orderId, executorId }, 'Failed to complete order from job feed');
    return { status: 'forbidden' };
  }
};

const deleteOrderMessageFromChannel = async (
  ctx: BotContext,
  order: OrderRecord,
): Promise<void> => {
  if (!order.channelMessageId) {
    return;
  }

  try {
    const binding = await getChannelBinding('drivers');
    if (!binding) {
      return;
    }

    await ctx.telegram.deleteMessage(binding.chatId, order.channelMessageId);
  } catch (error) {
    logger.debug(
      { err: error, orderId: order.id, messageId: order.channelMessageId },
      'Failed to update drivers channel message after job claim',
    );
  }
};

const notifyClientAboutRelease = async (
  ctx: BotContext,
  order: OrderRecord,
  republished: boolean | undefined,
): Promise<void> => {
  const clientId = order.clientId;
  if (typeof clientId !== 'number') {
    return;
  }

  const shortId = order.shortId ?? order.id.toString();
  const lines = [`⚠️ Ваш заказ №${shortId} отменён исполнителем.`];
  const willRepublish = republished === true;
  lines.push(willRepublish ? 'Мы снова ищем свободного исполнителя.' : 'Мы свяжемся с вами вручную.');

  try {
    await ctx.telegram.sendMessage(clientId, lines.join('\n'));
    const prompt = willRepublish
      ? 'Хотите изменить заказ или оформить новый?'
      : 'Мы на связи. Что дальше?';
    await sendClientMenuToChat(ctx.telegram, clientId, prompt);
  } catch (error) {
    logger.debug({ err: error, orderId: order.id, clientId }, 'Failed to notify client about release');
  }
};

const notifyClientAboutCompletion = async (ctx: BotContext, order: OrderRecord): Promise<void> => {
  const clientId = order.clientId;
  if (typeof clientId !== 'number') {

    return;
  }

  await ctx.reply(
    `Чтобы получить заказы, напишите @${SUPPORT_SEVEN} — поддержка подскажет, как подключиться к каналу.`,
  );
};


const processJobFeed = async (ctx: BotContext): Promise<void> => {
  if (!(await ensurePrivateChat(ctx))) {
    return;
  }

  const state = ensureExecutorState(ctx);
  if (!state.role) {
    return;
  }

  const active = await loadActiveOrder(ctx);
  if (active) {
    await showJobInProgress(ctx, state, active);
    return;
  }

  ctx.auth.user.hasActiveOrder = false;

  if (!(await ensureExecutorReady(ctx, state))) {
    return;
  }

  const city = await ensureCitySelected(ctx, 'Выберите город, чтобы получать заказы.');
  if (!city) {
    return;
  }

  const orders = await loadFeedOrders(city);
  await showJobFeed(ctx, state, city, orders);
};

const handleViewAction = async (ctx: BotContext, orderId: number): Promise<void> => {
  if (!(await ensurePrivateChat(ctx))) {
    return;
  }

  const state = ensureExecutorState(ctx);
  const city = ctx.auth.user.citySelected;
  if (!city) {
    await ctx.answerCbQuery('Сначала выберите город.');
    return;
  }

  let order: OrderRecord | null = null;
  try {
    order = await getOrderById(orderId);
  } catch (error) {
    logger.error({ err: error, orderId }, 'Failed to load order for confirmation');
  }

  if (!order || order.status !== 'open' || order.city !== city) {
    await ctx.answerCbQuery('Заказ недоступен. Обновляю список.');
    await processJobFeed(ctx);
    return;
  }

  await ctx.answerCbQuery();
  await showJobConfirmation(ctx, state, order);
  await reportJobViewed(ctx.telegram, order, toUserIdentity(ctx.from));
};

const handleAcceptAction = async (ctx: BotContext, orderId: number): Promise<void> => {
  if (!(await ensurePrivateChat(ctx))) {
    return;
  }

  const state = ensureExecutorState(ctx);
  const city = ctx.auth.user.citySelected;
  if (!city) {
    await ctx.answerCbQuery('Сначала выберите город.');
    return;
  }

  const guard = await withIdempotency(ctx, 'executor:jobs:accept', String(orderId), async () => {
    await sendProcessingFeedback(ctx);
    return attemptClaimOrder(ctx, state, city, orderId);
  });

  if (guard.status === 'duplicate') {
    await ctx.answerCbQuery('Запрос уже обрабатывается.');
    return;
  }

  const result = guard.result;
  switch (result.status) {
    case 'claimed': {
      await deleteOrderMessageFromChannel(ctx, result.order);
      await reportOrderClaimed(ctx.telegram, result.order, toUserIdentity(ctx.from));
      await reportJobTaken(ctx.telegram, result.order, toUserIdentity(ctx.from));
      await ctx.answerCbQuery(copy.orderAcceptedToast);
      await showJobInProgress(ctx, state, result.order);
      return;
    }
    case 'already_taken':
      await ctx.answerCbQuery(copy.orderAlreadyTakenToast, { show_alert: true });
      break;
    case 'city_mismatch':
      await ctx.answerCbQuery('⚠️ Заказ не из вашего города.', { show_alert: true });
      break;
    case 'forbidden_kind':
      await ctx.answerCbQuery('🚫 Этот заказ доступен только водителям.', { show_alert: true });
      break;
    case 'phone_required':
      await ctx.answerCbQuery(copy.orderPhoneRequired, { show_alert: true });
      await askPhone(ctx);
      return;
    case 'blocked':
      await ctx.answerCbQuery(copy.orderAccessBlocked, { show_alert: true });
      return;
    case 'limit_exceeded':
      await ctx.answerCbQuery('У вас уже есть активный заказ. Сначала завершите его.', {
        show_alert: true,
      });
      break;
    default:
      await ctx.answerCbQuery('Не удалось взять заказ. Попробуйте позже.');
      break;
  }

  await processJobFeed(ctx);
};

const handleReleaseAction = async (ctx: BotContext, orderId: number): Promise<void> => {
  if (!(await ensurePrivateChat(ctx))) {
    return;
  }

  const guard = await withIdempotency(ctx, 'executor:jobs:release', String(orderId), async () => {
    await sendProcessingFeedback(ctx);
    return attemptReleaseOrder(ctx, orderId);
  });

  if (guard.status === 'duplicate') {
    await ctx.answerCbQuery('Запрос уже обрабатывается.');
    return;
  }

  const result = guard.result;
  if (result.status !== 'released') {
    await ctx.answerCbQuery('Не удалось отменить заказ. Возможно, он уже недоступен.');
    await processJobFeed(ctx);
    return;
  }

  let publishStatus: Awaited<ReturnType<typeof publishOrderToDriversChannel>> | undefined;
  try {
    publishStatus = await publishOrderToDriversChannel(ctx.telegram, orderId);
  } catch (error) {
    logger.error({ err: error, orderId }, 'Failed to republish order after release');
  }

  const republished = publishStatus
    ? publishStatus.status !== 'missing_channel'
    : undefined;

  await notifyClientAboutRelease(ctx, result.order, republished);
  await ctx.answerCbQuery(copy.orderReleasedToast);
  ctx.auth.user.hasActiveOrder = false;

  await reportOrderReleased(ctx.telegram, result.order, toUserIdentity(ctx.from), republished);
  await reportJobReleased(ctx.telegram, result.order, toUserIdentity(ctx.from), republished);

  const state = ensureExecutorState(ctx);
  await showJobFeed(ctx, state, result.order.city, await loadFeedOrders(result.order.city));
};

const handleCompletionAction = async (ctx: BotContext, orderId: number): Promise<void> => {
  if (!(await ensurePrivateChat(ctx))) {
    return;
  }

  const guard = await withIdempotency(ctx, 'executor:jobs:complete', String(orderId), async () => {
    await sendProcessingFeedback(ctx);
    return attemptCompleteOrder(ctx, orderId);
  });

  if (guard.status === 'duplicate') {
    await ctx.answerCbQuery('Запрос уже обрабатывается.');
    return;
  }

  const result = guard.result;
  if (result.status !== 'completed') {
    await ctx.answerCbQuery('Не удалось завершить заказ. Попробуйте позже.');
    await processJobFeed(ctx);
    return;
  }

  await notifyClientAboutCompletion(ctx, result.order);
  await ctx.answerCbQuery('Заказ завершён. Спасибо!');
  await reportOrderCompleted(ctx.telegram, result.order, toUserIdentity(ctx.from));
  await reportJobCompleted(ctx.telegram, result.order, toUserIdentity(ctx.from));

  const state = ensureExecutorState(ctx);
  await showCompletionSummary(ctx, state, '🏁 Заказ завершён. Готовы взять новый?');
};

const parseOrderId = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
};

export const processOrdersRequest = async (ctx: BotContext): Promise<void> => {
  await processJobFeed(ctx);
};

export const registerExecutorJobs = (bot: Telegraf<BotContext>): void => {
  bot.action(JOB_REFRESH_ACTION, async (ctx) => {
    await ctx.answerCbQuery(copy.waiting);
    await processJobFeed(ctx);
  });

  bot.action(JOB_FEED_ACTION, async (ctx) => {
    await ctx.answerCbQuery();
    await processJobFeed(ctx);
  });

  bot.action(JOB_VIEW_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const orderId = parseOrderId(match?.[1]);
    if (!orderId) {
      await ctx.answerCbQuery('Некорректный заказ.');
      return;
    }

    await handleViewAction(ctx, orderId);
  });

  bot.action(JOB_ACCEPT_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const orderId = parseOrderId(match?.[1]);
    if (!orderId) {
      await ctx.answerCbQuery('Некорректный заказ.');
      return;
    }

    await handleAcceptAction(ctx, orderId);
  });

  bot.action(JOB_RELEASE_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const orderId = parseOrderId(match?.[1]);
    if (!orderId) {
      await ctx.answerCbQuery('Некорректный заказ.');
      return;
    }

    await handleReleaseAction(ctx, orderId);
  });

  bot.action(JOB_COMPLETE_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const orderId = parseOrderId(match?.[1]);
    if (!orderId) {
      await ctx.answerCbQuery('Некорректный заказ.');
      return;
    }

    await handleCompletionAction(ctx, orderId);
  });

export const registerExecutorJobs = (_bot: Telegraf<BotContext>): void => {
  // Интерактивная лента заказов отключена.

};

export const registerExecutorOrders = registerExecutorJobs;
