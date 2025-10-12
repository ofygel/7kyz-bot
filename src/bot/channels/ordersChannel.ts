import { Telegraf, Telegram } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import { getChannelBinding, ORDERS_CHANNEL } from './bindings';
import { config, logger } from '../../config';
import { withTx } from '../../db/client';
import { formatEtaMinutes } from '../services/pricing';
import { CITY_LABEL } from '../../domain/cities';
import {
  lockOrderById,
  setOrderChannelMessageId,
  getOrderWithExecutorById,
  tryClaimOrder,
  tryCompleteOrder,
  tryReclaimOrder,
  tryReleaseOrder,
  tryRestoreCompletedOrder,
  markOrderAsOpen,
} from '../../db/orders';
import type { OrderKind, OrderRecord, OrderWithExecutor } from '../../types';
import type { BotContext, ExecutorRole, UserRole } from '../types';
import type { AppCity } from '../../domain/cities';
import { buildOrderLocationsKeyboard } from '../keyboards/orders';
import { buildInlineKeyboard, mergeInlineKeyboards } from '../keyboards/common';
import { wrapCallbackData } from '../services/callbackTokens';
import { copy } from '../copy';
import { sendClientMenuToChat } from '../../ui/clientMenu';
import {
  buildOrderContactKeyboard,
  buildOrderDetailText,
  formatExecutorLabel,
} from '../orders/formatting';
import {
  reportOrderClaimed,
  reportOrderCompleted,
  reportOrderPublished,
  reportOrderReleased,
  toUserIdentity,
} from '../services/reports';
import { withIdempotency } from '../middlewares/idempotency';
import { sendProcessingFeedback } from '../services/feedback';
import { answerCallbackQuerySafely } from '../utils/callbacks';
import { getExecutorOrderAccess } from '../services/executorAccess';

export type PublishOrderStatus = 'published' | 'already_published' | 'missing_channel';

export interface PublishOrderResult {
  status: PublishOrderStatus;
  messageId?: number;
}

const ACCEPT_ACTION_PREFIX = 'order:accept';
const DECLINE_ACTION_PREFIX = 'order:decline';
const RELEASE_ACTION_PREFIX = 'order:release';
const COMPLETE_ACTION_PREFIX = 'order:complete';
const ACCEPT_ACTION_PATTERN = /^order:accept:(\d+)$/;
const DECLINE_ACTION_PATTERN = /^order:decline:(\d+)$/;
const RELEASE_ACTION_PATTERN = /^order:release:(\d+)$/;
const COMPLETE_ACTION_PATTERN = /^order:complete:(\d+)$/;
const UNDO_RELEASE_ACTION_PREFIX = 'order:undo-release';
const UNDO_RELEASE_ACTION_PATTERN = /^order:undo-release:(\d+)$/;
const UNDO_COMPLETE_ACTION_PREFIX = 'order:undo-complete';
const UNDO_COMPLETE_ACTION_PATTERN = /^order:undo-complete:(\d+)$/;
const UNDO_TTL_MS = 2 * 60 * 1000;

const callbackSecret = config.bot.hmacSecret;

const formatOrderType = (kind: OrderKind): string =>
  kind === 'taxi' ? 'Такси' : 'Доставка';

const formatDistance = (distanceKm: number): string => {
  if (!Number.isFinite(distanceKm)) {
    return 'н/д';
  }

  if (distanceKm < 0.1) {
    return '<0.1';
  }

  return distanceKm.toFixed(1);
};

const formatPrice = (amount: number, currency: string): string =>
  `${new Intl.NumberFormat('ru-RU').format(amount)} ${currency}`;

const buildOrderBaseLines = (order: OrderRecord): string[] => [
  copy.orderChannelCard(order.kind, formatPrice(order.price.amount, order.price.currency), CITY_LABEL[order.city]),
  `#${order.shortId}`,
  '',
  `📍 Подача: ${order.pickup.address}`,
  `🎯 Назначение: ${order.dropoff.address}`,
  `📏 Расстояние: ${formatDistance(order.price.distanceKm)} км`,
  `⏱️ В пути: ≈${formatEtaMinutes(order.price.etaMinutes)} мин`,
  `💰 Стоимость: ${formatPrice(order.price.amount, order.price.currency)}`,
];

export const buildOrderDetailsMessage = (order: OrderRecord): string => {
  const lines = [...buildOrderBaseLines(order)];

  if (order.clientPhone) {
    lines.push(`📞 Телефон клиента: ${order.clientPhone}`);
  }

  if (order.recipientPhone) {
    lines.push(`📱 Телефон получателя: ${order.recipientPhone}`);
  }

  if (typeof order.isPrivateHouse === 'boolean') {
    lines.push(`🏠 Тип адреса: ${order.isPrivateHouse ? 'Частный дом' : 'Многоквартирный дом'}`);
  }

  if (order.isPrivateHouse === false) {
    if (order.apartment) {
      lines.push(`🚪 Квартира: ${order.apartment}`);
    }
    if (order.entrance) {
      lines.push(`📮 Подъезд: ${order.entrance}`);
    }
    if (order.floor) {
      lines.push(`⬆️ Этаж: ${order.floor}`);
    }
  }

  const customerName = order.customerName?.trim();
  if (customerName) {
    lines.push(`👤 Имя: ${customerName}`);
  }

  const username = order.customerUsername?.trim();
  if (username) {
    lines.push(`🔗 Telegram: @${username}`);
  }

  if (order.clientComment) {
    lines.push('', `📝 Комментарий: ${order.clientComment}`);
  }

  return lines.join('\n');
};

export const buildOrderChannelMessage = (order: OrderRecord): string => {
  const lines = [...buildOrderBaseLines(order)];

  if (order.clientComment) {
    lines.push('', `📝 Комментарий: ${order.clientComment}`);
  }

  return lines.join('\n');
};

interface OrderDirectMessage {
  text: string;
  keyboard: InlineKeyboardMarkup;
}

const buildOrderDirectMessage = (order: OrderRecord): OrderDirectMessage => {
  const baseMessage = buildOrderDetailsMessage(order);
  const locationsKeyboard = buildOrderLocationsKeyboard(order.city, order.pickup, order.dropoff);
  const actionsKeyboard = buildInlineKeyboard([
    [
      { label: '✅ Завершить заказ', action: `${COMPLETE_ACTION_PREFIX}:${order.id}` },
      { label: '❌ Отменить заказ', action: `${RELEASE_ACTION_PREFIX}:${order.id}` },
    ],
  ]);
  const keyboard = mergeInlineKeyboards(locationsKeyboard, actionsKeyboard) ?? actionsKeyboard;

  return { text: baseMessage, keyboard } satisfies OrderDirectMessage;
};

const CONTROL_REMINDER_LINE = 'Используйте кнопки ниже, чтобы управлять заказом.';
const CLIENT_ORDER_UPDATE_FALLBACK_TEXT = 'ℹ️ Статус заказа обновлён.';

const stripControlReminder = (text: string): string => {
  const lines = text.split('\n');

  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
    lines.pop();
  }

  if (lines.length > 0 && lines[lines.length - 1] === CONTROL_REMINDER_LINE) {
    lines.pop();
    while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
      lines.pop();
    }
  }

  return lines.join('\n');
};

interface ClientOrderNotificationOptions {
  orderId: number;
  clientId: number;
  introText: string;
  menuPrompt: string;
}

const notifyClientAboutOrderUpdate = async (
  telegram: Telegram,
  { orderId, clientId, introText, menuPrompt }: ClientOrderNotificationOptions,
): Promise<void> => {
  const intro = introText.trim();
  const fallbackText = intro || CLIENT_ORDER_UPDATE_FALLBACK_TEXT;
  let introLine = intro;
  let messageText = fallbackText;
  const messageOptions: { reply_markup?: InlineKeyboardMarkup } = {};

  try {
    const detailedOrder = await getOrderWithExecutorById(orderId);
    if (detailedOrder) {
      if (detailedOrder.status === 'claimed') {
        const executorLine = `👤 Исполнитель: ${formatExecutorLabel(detailedOrder)}.`;
        introLine = introLine ? `${introLine}\n${executorLine}` : executorLine;
      }
      const detailText = stripControlReminder(buildOrderDetailText(detailedOrder, {}));
      messageText = introLine ? `${introLine}\n\n${detailText}` : detailText;

      const contactKeyboard = buildOrderContactKeyboard(detailedOrder);
      if (contactKeyboard) {
        messageOptions.reply_markup = contactKeyboard;
      }
    }
  } catch (error) {
    logger.warn({ err: error, orderId, clientId }, 'Failed to prepare client order update');
  }

  try {
    await telegram.sendMessage(clientId, messageText, messageOptions);
  } catch (error) {
    logger.debug({ err: error, orderId, clientId }, 'Failed to notify client about order update');
  }

  try {
    await sendClientMenuToChat(telegram, clientId, menuPrompt);
  } catch (error) {
    logger.debug({ err: error, orderId, clientId }, 'Failed to send client menu after order update');
  }
};

type OrderChannelStatus = 'pending' | 'claimed' | 'declined';

interface UserInfo {
  id?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
}

interface OrderDecisionInfo {
  moderator?: UserInfo;
  decidedAt: number;
}

interface OrderChannelState {
  orderId: number;
  chatId: number;
  messageId: number;
  baseText: string;
  status: OrderChannelStatus;
  renderedStatus?: 'claimed' | 'declined';
  decision?: OrderDecisionInfo;
}

const orderStates = new Map<number, OrderChannelState>();
const orderDismissals = new Map<number, Set<number>>();
interface OrderUndoState {
  executorId: number;
  expiresAt: number;
}

const releaseUndoStates = new Map<number, OrderUndoState>();
const completionUndoStates = new Map<number, OrderUndoState>();

const parseChatId = (chatId: number | string | undefined): number | undefined => {
  if (typeof chatId === 'number' && Number.isFinite(chatId)) {
    return chatId;
  }

  if (typeof chatId === 'string') {
    const parsed = Number(chatId);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
};

const resolveConfiguredOrdersChannelId = (): number | null => {
  const configured =
    config.channels.ordersChannelId ?? config.subscriptions.payment.ordersChannelId;
  return typeof configured === 'number' ? configured : null;
};

const getOrdersChannelChatId = async (): Promise<number | null> => {
  const configured = resolveConfiguredOrdersChannelId();
  if (configured !== null) {
    return configured;
  }

  const binding = await getChannelBinding(ORDERS_CHANNEL);
  return binding?.chatId ?? null;
};

const resolveAuthorizedChatId = async (
  orderId: number,
  chat: { id: number | string | undefined; type?: string | undefined },
): Promise<number | null> => {
  const chatId = parseChatId(chat.id);
  if (typeof chatId !== 'number') {
    return null;
  }

  if (!chat.type || chat.type === 'private') {
    return chatId;
  }

  const state = orderStates.get(orderId);
  if (state?.chatId === chatId) {
    return chatId;
  }

  const ordersChannelId = await getOrdersChannelChatId();
  if (ordersChannelId === chatId) {
    return chatId;
  }

  return null;
};

const rememberUndoState = (
  map: Map<number, OrderUndoState>,
  orderId: number,
  executorId: number,
): void => {
  map.set(orderId, {
    executorId,
    expiresAt: Date.now() + UNDO_TTL_MS,
  });
};

const consumeUndoState = (map: Map<number, OrderUndoState>, orderId: number): OrderUndoState | undefined => {
  const state = map.get(orderId);
  if (!state) {
    return undefined;
  }

  if (Date.now() > state.expiresAt) {
    map.delete(orderId);
    return undefined;
  }

  map.delete(orderId);
  return state;
};

const peekUndoState = (map: Map<number, OrderUndoState>, orderId: number): OrderUndoState | undefined => {
  const state = map.get(orderId);
  if (!state) {
    return undefined;
  }

  if (Date.now() > state.expiresAt) {
    map.delete(orderId);
    return undefined;
  }

  return state;
};

const getOrderDismissals = (orderId: number): Set<number> => {
  let dismissals = orderDismissals.get(orderId);
  if (!dismissals) {
    dismissals = new Set<number>();
    orderDismissals.set(orderId, dismissals);
  }

  return dismissals;
};

const hasOrderBeenDismissedBy = (orderId: number, moderatorId: number): boolean =>
  orderDismissals.get(orderId)?.has(moderatorId) ?? false;

const markOrderDismissedBy = (orderId: number, moderatorId: number): void => {
  getOrderDismissals(orderId).add(moderatorId);
};

const clearOrderDismissals = (orderId: number): void => {
  orderDismissals.delete(orderId);
};

const removeOrderState = async (telegram: Telegram, orderId: number): Promise<void> => {
  const state = orderStates.get(orderId);
  if (state) {
    try {
      await telegram.deleteMessage(state.chatId, state.messageId);
    } catch (error) {
      logger.debug(
        { err: error, orderId, chatId: state.chatId, messageId: state.messageId },
        'Failed to delete existing order message before republish',
      );
    }
  }

  orderStates.delete(orderId);
  clearOrderDismissals(orderId);
};

export const handleClientOrderCancellation = async (
  telegram: Telegram,
  order: OrderWithExecutor,
): Promise<void> => {
  const state = orderStates.get(order.id);

  if (state) {
    await removeOrderState(telegram, order.id);
  } else {
    clearOrderDismissals(order.id);
    orderStates.delete(order.id);

    if (typeof order.channelMessageId === 'number') {
      const ordersChannelId = await getOrdersChannelChatId();
      if (!ordersChannelId) {
        logger.warn({ orderId: order.id }, 'Drivers channel binding missing during cancellation');
      } else {
        try {
          await telegram.deleteMessage(ordersChannelId, order.channelMessageId);
        } catch (error) {
          logger.debug(
            { err: error, orderId: order.id, chatId: ordersChannelId, messageId: order.channelMessageId },
            'Failed to delete drivers channel message for cancelled order',
          );
        }
      }
    }
  }

  const executorTelegramId = order.executor?.telegramId ?? order.claimedBy;
  if (typeof executorTelegramId === 'number') {
    const notificationText = [
      '\uD83D\uDEAB Заказ отменён клиентом.',
      '',
      buildOrderDetailsMessage(order),
    ].join('\n');

    try {
      await telegram.sendMessage(executorTelegramId, notificationText);
    } catch (error) {
      logger.warn(
        { err: error, orderId: order.id, executorId: executorTelegramId },
        'Failed to notify executor about client cancellation',
      );
    }
  }
};

const clearInlineKeyboard = async (
  telegram: Telegram,
  orderId: number,
  chatId: number,
  messageId: number,
): Promise<void> => {
  try {
    await telegram.editMessageReplyMarkup(chatId, messageId, undefined, { inline_keyboard: [] });
  } catch (error) {
    logger.warn(
      { err: error, orderId, chatId, messageId },
      'Failed to clear inline keyboard for order dismissal',
    );
  }
};

const toUserInfo = (from?: BotContext['from']): UserInfo => ({
  id: from?.id,
  username: from?.username ?? undefined,
  firstName: from?.first_name ?? undefined,
  lastName: from?.last_name ?? undefined,
});

const formatUserInfo = (info?: UserInfo): string => {
  if (!info) {
    return 'неизвестный участник';
  }

  if (info.username) {
    return `@${info.username}`;
  }

  const fullName = [info.firstName, info.lastName]
    .filter((value) => Boolean(value && value.trim().length > 0))
    .join(' ')
    .trim();

  if (fullName) {
    return info.id ? `${fullName} (ID ${info.id})` : fullName;
  }

  return info.id ? `ID ${info.id}` : 'неизвестный участник';
};

const mapOrderStatus = (order: OrderRecord): OrderChannelStatus => {
  if (order.status === 'claimed' || order.status === 'finished') {
    return 'claimed';
  }

  if (order.status === 'cancelled' || order.status === 'expired') {
    return 'declined';
  }

  return 'pending';
};

const ensureOrderState = (
  orderId: number,
  chatId: number,
  messageId: number,
  order?: OrderRecord,
): OrderChannelState => {
  let existing = orderStates.get(orderId);
  if (!existing) {
    const baseText = order ? buildOrderChannelMessage(order) : '';
    existing = {
      orderId,
      chatId,
      messageId,
      baseText,
      status: order ? mapOrderStatus(order) : 'pending',
    } satisfies OrderChannelState;
    orderStates.set(orderId, existing);
  } else {
    existing.chatId = chatId;
    existing.messageId = messageId;
    if (order) {
      existing.baseText = buildOrderChannelMessage(order);
      existing.status = mapOrderStatus(order);
    }
  }

  return existing;
};

const buildDecisionSuffix = (state: OrderChannelState): string => {
  const moderatorLabel = formatUserInfo(state.decision?.moderator);

  if (state.status === 'claimed') {
    return `✅ Заказ принят: ${moderatorLabel}.`;
  }

  if (state.status === 'declined') {
    return `❌ Заказ недоступен. Отметил ${moderatorLabel}.`;
  }

  return '';
};

const updateOrderMessage = async (telegram: Telegram, state: OrderChannelState): Promise<void> => {
  if (state.status === 'claimed') {
    try {
      await telegram.deleteMessage(state.chatId, state.messageId);
      state.renderedStatus = 'claimed';
      return;
    } catch (error) {
      logger.warn(
        { err: error, orderId: state.orderId, chatId: state.chatId, messageId: state.messageId },
        'Failed to delete order message in drivers channel',
      );
      // Fall back to updating the message when deletion is not possible.
    }
  }

  const suffix = buildDecisionSuffix(state);
  const text = suffix ? `${state.baseText}\n\n${suffix}`.trim() : state.baseText;

  try {
    await telegram.editMessageText(state.chatId, state.messageId, undefined, text, {
      reply_markup: suffix ? { inline_keyboard: [] } : undefined,
    });
    state.renderedStatus = state.status === 'pending' ? undefined : state.status;
  } catch (error) {
    logger.warn(
      { err: error, orderId: state.orderId, chatId: state.chatId, messageId: state.messageId },
      'Failed to update order message in drivers channel',
    );
  }
};

const ensureMessageReflectsState = async (
  telegram: Telegram,
  state: OrderChannelState,
): Promise<void> => {
  if (state.status === 'pending') {
    return;
  }

  if (state.renderedStatus === state.status) {
    return;
  }

  await updateOrderMessage(telegram, state);
};

const buildAlreadyProcessedResponse = (state: OrderChannelState): string => {
  if (state.status === 'claimed') {
    const moderatorLabel = formatUserInfo(state.decision?.moderator);
    return moderatorLabel
      ? `${copy.orderAlreadyTakenToast} (${moderatorLabel})`
      : copy.orderAlreadyTakenToast;
  }

  if (state.status === 'declined') {
    const moderatorLabel = formatUserInfo(state.decision?.moderator);
    return moderatorLabel ? `${copy.orderReleasedToast} (${moderatorLabel})` : copy.orderReleasedToast;
  }

  return copy.orderAlreadyTakenToast;
};

const buildActionKeyboard = async (order: OrderRecord): Promise<InlineKeyboardMarkup> => {
  const locationsKeyboard = buildOrderLocationsKeyboard(order.city, order.pickup, order.dropoff);
  const acceptRaw = `${ACCEPT_ACTION_PREFIX}:${order.id}`;
  const declineRaw = `${DECLINE_ACTION_PREFIX}:${order.id}`;
  const decisionsKeyboard = buildInlineKeyboard([
    [
      {
        label: '✅ Беру заказ',
        action: await wrapCallbackData(acceptRaw, {
          secret: callbackSecret,
          bindToUser: false,
          ttlSeconds: config.bot.callbackTtlSeconds,
        }),
      },
    ],
    [
      {
        label: '❌ Недоступен',
        action: await wrapCallbackData(declineRaw, {
          secret: callbackSecret,
          bindToUser: false,
          ttlSeconds: config.bot.callbackTtlSeconds,
        }),
      },
    ],
  ]);

  return mergeInlineKeyboards(locationsKeyboard, decisionsKeyboard) ?? decisionsKeyboard;
};

export const publishOrderToDriversChannel = async (
  telegram: Telegram,
  orderId: number,
): Promise<PublishOrderResult> => {
  const chatId = await getOrdersChannelChatId();
  if (!chatId) {
    logger.warn({ orderId }, 'Drivers channel is not configured, skipping publish');
    return { status: 'missing_channel' } satisfies PublishOrderResult;
  }

  try {
    return await withTx(
      async (client) => {
        const locked = await lockOrderById(client, orderId);
        if (!locked) {
          throw new Error(`Order ${orderId} not found`);
        }

        const order =
          locked.status === 'new' ? (await markOrderAsOpen(client, locked.id)) ?? locked : locked;

        const messageText = buildOrderChannelMessage(order);

        if (order.channelMessageId) {
          orderStates.set(order.id, {
            orderId: order.id,
            chatId,
            messageId: order.channelMessageId,
            baseText: messageText,
            status: mapOrderStatus(order),
          });
          return {
            status: 'already_published',
            messageId: order.channelMessageId,
          } satisfies PublishOrderResult;
        }

        const keyboard = await buildActionKeyboard(order);
        const message = await telegram.sendMessage(chatId, messageText, {
          reply_markup: keyboard,
        });

        await setOrderChannelMessageId(client, order.id, message.message_id);

        orderStates.set(order.id, {
          orderId: order.id,
          chatId,
          messageId: message.message_id,
          baseText: messageText,
          status: 'pending',
        });
        clearOrderDismissals(order.id);

        await reportOrderPublished(telegram, order);

        return {
          status: 'published',
          messageId: message.message_id,
        } satisfies PublishOrderResult;
      },
      { isolationLevel: 'serializable' },
    );
  } catch (error) {
    logger.error({ err: error, orderId }, 'Failed to publish order to drivers channel');
    throw error;
  }
};

type OrderActionOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'already_processed'; order: OrderRecord }
  | { outcome: 'claimed'; order: OrderRecord }
  | { outcome: 'dismissed'; order: OrderRecord }
  | { outcome: 'already_dismissed' }
  | { outcome: 'limit_exceeded' }
  | { outcome: 'forbidden_kind'; order: OrderRecord }
  | { outcome: 'phone_required' }
  | { outcome: 'executor_blocked' }
  | { outcome: 'city_mismatch'; order: OrderRecord };

interface OrderActionActor {
  id?: number;
  role?: UserRole;
  executorKind?: ExecutorRole;
  city?: AppCity;
}

type OrderReleaseOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'not_claimed'; order: OrderRecord }
  | { outcome: 'forbidden'; order: OrderRecord }
  | { outcome: 'released'; order: OrderRecord };

type OrderCompletionOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'not_claimed'; order: OrderRecord }
  | { outcome: 'forbidden'; order: OrderRecord }
  | { outcome: 'completed'; order: OrderRecord };

type UndoReleaseOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'already_taken'; order: OrderRecord }
  | { outcome: 'reclaimed'; order: OrderRecord };

type UndoCompletionOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; order: OrderRecord }
  | { outcome: 'restored'; order: OrderRecord };

const processOrderAction = async (
  orderId: number,
  decision: 'accept' | 'decline',
  actor: OrderActionActor,
): Promise<OrderActionOutcome> => {
  let actorId = actor.id;

  if (decision === 'decline' && typeof actorId === 'number') {
    if (hasOrderBeenDismissedBy(orderId, actorId)) {
      return { outcome: 'already_dismissed' } as const;
    }
  }

  if (decision === 'accept') {
    if (typeof actorId !== 'number') {
      throw new Error('Missing moderator identifier for order claim');
    }

    const numericActorId = actorId;

    const access = await getExecutorOrderAccess(numericActorId);
    if (!access || !access.hasPhone) {
      return { outcome: 'phone_required' } as const;
    }

    if (access.isBlocked) {
      return { outcome: 'executor_blocked' } as const;
    }

    // Reassign to narrowed variant for subsequent usage inside the
    // transaction block.
    actorId = numericActorId;
  }

  const result = await withTx(
    async (client) => {
      const order = await lockOrderById(client, orderId);
      if (!order) {
        return { outcome: 'not_found' } as const;
      }

      if (decision === 'accept') {
        if (order.status !== 'open') {
          return { outcome: 'already_processed', order } as const;
        }

        const executorKind = actor.executorKind;

        if (order.kind === 'taxi') {
          if (executorKind !== 'driver') {
            return { outcome: 'forbidden_kind', order } as const;
          }
        }

        if (executorKind === 'driver') {
          const { rows: userRows } = await client.query<{ tg_id: number }>(
            `SELECT tg_id FROM users WHERE tg_id = $1 FOR UPDATE`,
            [actorId!],
          );

          if (userRows.length === 0) {
            throw new Error(`Failed to load user ${actorId} while claiming order ${orderId}`);
          }

          const { rows: activeOrders } = await client.query<{ id: number }>(
            `
              SELECT id
              FROM orders
              WHERE claimed_by = $1 AND status = 'claimed'
              LIMIT 1
            `,
            [actorId!],
          );

          if (activeOrders.length > 0) {
            return { outcome: 'limit_exceeded' } as const;
          }
        }

        const actorCity = actor.city;
        if (!actorCity) {
          throw new Error('Missing executor city for order claim');
        }

        if (order.city !== actorCity) {
          return { outcome: 'city_mismatch', order } as const;
        }

        const updated = await tryClaimOrder(client, orderId, actorId!, actorCity);
        if (!updated) {
          return { outcome: 'already_processed', order } as const;
        }

        return { outcome: 'claimed', order: updated } as const;
      }

      if (order.status !== 'open') {
        return { outcome: 'already_processed', order } as const;
      }

      return { outcome: 'dismissed', order } as const;
    },
    { isolationLevel: 'serializable' },
  );

  if (result.outcome === 'claimed') {
    clearOrderDismissals(orderId);
  } else if (result.outcome === 'already_processed' && result.order.status !== 'open') {
    clearOrderDismissals(orderId);
  } else if (result.outcome === 'dismissed' && typeof actorId === 'number') {
    markOrderDismissedBy(orderId, actorId);
  }

  return result;
};

const processOrderRelease = async (
  orderId: number,
  moderatorId: number,
): Promise<OrderReleaseOutcome> => {
  const result = await withTx(
    async (client) => {
      const order = await lockOrderById(client, orderId);
      if (!order) {
        return { outcome: 'not_found' } as const;
      }

      if (order.status !== 'claimed' || typeof order.claimedBy !== 'number') {
        return { outcome: 'not_claimed', order } as const;
      }

      if (order.claimedBy !== moderatorId) {
        return { outcome: 'forbidden', order } as const;
      }

      const updated = await tryReleaseOrder(client, orderId, moderatorId);
      if (!updated) {
        throw new Error(`Failed to release order ${orderId}`);
      }

      return { outcome: 'released', order: updated } as const;
    },
    { isolationLevel: 'serializable' },
  );

  return result;
};

const processOrderCompletion = async (
  orderId: number,
  executorId: number,
): Promise<OrderCompletionOutcome> => {
  const result = await withTx(
    async (client) => {
      const order = await lockOrderById(client, orderId);
      if (!order) {
        return { outcome: 'not_found' } as const;
      }

      if (order.status !== 'claimed' || typeof order.claimedBy !== 'number') {
        return { outcome: 'not_claimed', order } as const;
      }

      if (order.claimedBy !== executorId) {
        return { outcome: 'forbidden', order } as const;
      }

      const updated = await tryCompleteOrder(client, orderId, executorId);
      if (!updated) {
        throw new Error(`Failed to complete order ${orderId}`);
      }

      return { outcome: 'completed', order: updated } as const;
    },
    { isolationLevel: 'serializable' },
  );

  return result;
};

const handleOrderDecision = async (
  ctx: BotContext,
  orderId: number,
  decision: 'accept' | 'decline',
): Promise<void> => {
  const message = ctx.callbackQuery?.message;
  if (!message || !('message_id' in message) || !message.chat) {
    await answerCallbackQuerySafely(ctx, 'Не удалось обработать действие.');
    return;
  }

  const authorizedChatId = await resolveAuthorizedChatId(orderId, message.chat);
  if (authorizedChatId === null) {
    await answerCallbackQuerySafely(ctx, 'Действие доступно только в личном чате с ботом.', { show_alert: true });
    return;
  }

  const chatId = authorizedChatId;
  const messageId = message.message_id;
  const actorId = ctx.from?.id;
  const actorRole = ctx.auth?.user.role;
  let actorCity: AppCity | undefined;

  if (decision === 'decline' && typeof actorId !== 'number') {
    await answerCallbackQuerySafely(ctx, 'Не удалось определить пользователя.');
    return;
  }

  if (decision === 'accept' && typeof actorId !== 'number') {
    await answerCallbackQuerySafely(ctx, 'Не удалось определить пользователя.');
    return;
  }

  if (decision === 'accept') {
    actorCity = ctx.auth?.user.citySelected;
    if (!actorCity) {
      await answerCallbackQuerySafely(ctx, 'Сначала выберите город командой /city в личном чате с ботом.', {
        show_alert: true,
      });
      return;
    }
  }

  await sendProcessingFeedback(ctx, { skipAnswerCbQuery: true });

  let result: OrderActionOutcome;
  try {
    result = await processOrderAction(orderId, decision, {
      id: actorId,
      role: actorRole,
      executorKind: ctx.auth?.user.executorKind,
      city: actorCity,
    });
  } catch (error) {
    logger.error({ err: error, orderId }, 'Failed to apply order channel decision');
    await answerCallbackQuerySafely(ctx, 'Не удалось обработать действие. Попробуйте позже.');
    return;
  }

  if (result.outcome === 'not_found') {
    await answerCallbackQuerySafely(ctx, 'Заказ не найден или уже удалён.');
    return;
  }

  const state = ensureOrderState(
    orderId,
    chatId,
    messageId,
    'order' in result ? result.order : undefined,
  );

  switch (result.outcome) {
    case 'already_processed': {
      await ensureMessageReflectsState(ctx.telegram, state);
      await answerCallbackQuerySafely(ctx, buildAlreadyProcessedResponse(state));
      return;
    }
    case 'limit_exceeded': {
      await answerCallbackQuerySafely(ctx, 'У вас уже есть активный заказ. Сначала завершите его.', {
        show_alert: true,
      });
      return;
    }
    case 'city_mismatch': {
      await ensureMessageReflectsState(ctx.telegram, state);
      await answerCallbackQuerySafely(ctx, '⚠️ Заказ не из вашего города.', { show_alert: true });
      return;
    }
    case 'forbidden_kind': {
      await answerCallbackQuerySafely(ctx, '🚫 Этот заказ доступен только водителям.', { show_alert: true });
      return;
    }
    case 'phone_required': {
      await answerCallbackQuerySafely(ctx, copy.orderPhoneRequired, { show_alert: true });
      return;
    }
    case 'executor_blocked': {
      await answerCallbackQuerySafely(ctx, copy.orderAccessBlocked, { show_alert: true });
      return;
    }
    case 'claimed': {
      state.status = 'claimed';
      state.decision = {
        moderator: toUserInfo(ctx.from),
        decidedAt: Date.now(),
      };
      await updateOrderMessage(ctx.telegram, state);
      let answerMessage = copy.orderAcceptedToast;

      const executorTelegramId = ctx.from?.id;
      if (typeof executorTelegramId === 'number') {
        const directMessage = buildOrderDirectMessage(result.order);
        try {
          await ctx.telegram.sendMessage(executorTelegramId, directMessage.text, {
            reply_markup: directMessage.keyboard,
          });
        } catch (error) {
          logger.warn(
            { err: error, orderId, executorId: executorTelegramId },
            'Failed to send order summary to executor',
          );
          answerMessage = `${copy.orderAcceptedToast} Не удалось отправить детали в личные сообщения. Убедитесь, что бот не заблокирован.`;
        }
      } else {
        answerMessage = `${copy.orderAcceptedToast} Не удалось отправить детали в личные сообщения.`;
      }

      await answerCallbackQuerySafely(ctx, answerMessage);

      const clientId = result.order.clientId;
      if (typeof clientId === 'number') {
        const shortId = result.order.shortId ?? result.order.id.toString();
        await notifyClientAboutOrderUpdate(ctx.telegram, {
          orderId: result.order.id,
          clientId,
          introText: copy.orderClaimedClientNotice(shortId),
          menuPrompt: copy.orderClaimedClientMenuPrompt,
        });
      }

      await reportOrderClaimed(ctx.telegram, result.order, toUserIdentity(ctx.from));
      return;
    }
    case 'dismissed': {
      await clearInlineKeyboard(ctx.telegram, orderId, chatId, messageId);
      await answerCallbackQuerySafely(ctx, 'Заказ отмечен как недоступный.');
      return;
    }
    case 'already_dismissed': {
      await answerCallbackQuerySafely(ctx, 'Вы уже отметили этот заказ как недоступный.');
      return;
    }
    default:
      return;
  }
};

const handleOrderRelease = async (ctx: BotContext, orderId: number): Promise<void> => {
  const message = ctx.callbackQuery?.message;
  if (!message || !('message_id' in message) || !message.chat) {
    await answerCallbackQuerySafely(ctx, 'Не удалось обработать действие.');
    return;
  }

  const authorizedChatId = await resolveAuthorizedChatId(orderId, message.chat);
  if (authorizedChatId === null) {
    await answerCallbackQuerySafely(ctx, 'Действие доступно только в личном чате с ботом.', { show_alert: true });
    return;
  }

  const moderatorId = ctx.from?.id;
  if (typeof moderatorId !== 'number') {
    await answerCallbackQuerySafely(ctx, 'Не удалось определить пользователя.');
    return;
  }

  await sendProcessingFeedback(ctx);

  let result: OrderReleaseOutcome;
  try {
    result = await processOrderRelease(orderId, moderatorId);
  } catch (error) {
    logger.error({ err: error, orderId }, 'Failed to process order release');
    await answerCallbackQuerySafely(ctx, 'Не удалось отменить заказ. Попробуйте позже.');
    return;
  }

  switch (result.outcome) {
    case 'not_found':
      await answerCallbackQuerySafely(ctx, 'Заказ не найден или уже удалён.');
      return;
    case 'not_claimed':
      await answerCallbackQuerySafely(ctx, 'Заказ уже недоступен для отмены.');
      return;
    case 'forbidden':
      await answerCallbackQuerySafely(ctx, copy.noAccess);
      return;
    case 'released':
      await removeOrderState(ctx.telegram, orderId);

      let publishResult: PublishOrderResult | undefined;
      try {
        publishResult = await publishOrderToDriversChannel(ctx.telegram, orderId);
      } catch (error) {
        logger.error({ err: error, orderId }, 'Failed to republish released order');
      }

      const baseMessage = buildOrderDetailsMessage(result.order);
      const locationKeyboard = buildOrderLocationsKeyboard(
        result.order.city,
        result.order.pickup,
        result.order.dropoff,
      );
      const undoKeyboard = buildInlineKeyboard([
        [{ label: '↩️ Вернуть заказ', action: `${UNDO_RELEASE_ACTION_PREFIX}:${orderId}` }],
      ]);
      const replyMarkup = mergeInlineKeyboards(locationKeyboard, undoKeyboard) ?? undoKeyboard;

      let statusLine = copy.statusLine('🚫', 'Заказ отменён и возвращён в канал.');
      let answerText = copy.orderReleasedToast;
      if (!publishResult || publishResult.status === 'missing_channel') {
        statusLine = copy.statusLine(
          '🚫',
          'Заказ отменён, но канал исполнителей не настроен. Мы свяжемся с вами вручную.',
        );
        answerText = `${copy.orderReleasedToast} Мы свяжемся с вами вручную.`;
      }

      try {
        await ctx.editMessageText([baseMessage, '', statusLine].join('\n'), {
          reply_markup: replyMarkup,
        });
      } catch (error) {
        logger.debug(
          { err: error, orderId, chatId: message.chat.id, messageId: message.message_id },
          'Failed to update direct message after release',
        );
        try {
          await ctx.editMessageReplyMarkup(replyMarkup);
        } catch (markupError) {
          logger.debug(
            { err: markupError, orderId, chatId: message.chat.id, messageId: message.message_id },
            'Failed to update message keyboard after release',
          );
        }
      }

      rememberUndoState(releaseUndoStates, orderId, moderatorId);

      await answerCallbackQuerySafely(ctx, answerText);
      const clientId = result.order.clientId;
      if (typeof clientId === 'number') {
        const shortId = result.order.shortId ?? result.order.id.toString();
        const notificationLines = [
          `⚠️ Ваш заказ №${shortId} отменён исполнителем.`,
        ];

        if (!publishResult || publishResult.status !== 'missing_channel') {
          notificationLines.push('Мы снова ищем свободного исполнителя.');
        } else {
          notificationLines.push('Канал исполнителей недоступен. Мы свяжемся с вами вручную.');
        }

        try {
          await ctx.telegram.sendMessage(clientId, notificationLines.join('\n'));
          const menuPrompt =
            !publishResult || publishResult.status !== 'missing_channel'
              ? 'Хотите изменить заказ или оформить новый?'
              : 'Мы на связи. Что дальше?';
          await sendClientMenuToChat(ctx.telegram, clientId, menuPrompt);
        } catch (error) {
          logger.debug(
            { err: error, orderId, clientId },
            'Failed to notify client about order release',
          );
        }
      }

      const republished = publishResult !== undefined && publishResult.status !== 'missing_channel';
      await reportOrderReleased(
        ctx.telegram,
        result.order,
        toUserIdentity(ctx.from),
        republished,
      );
      return;
    default:
      await answerCallbackQuerySafely(ctx, 'Не удалось отменить заказ.');
      return;
  }
};

const handleUndoOrderRelease = async (ctx: BotContext, orderId: number): Promise<void> => {
  const message = ctx.callbackQuery?.message;
  if (!message || !('chat' in message) || !message.chat) {
    await answerCallbackQuerySafely(ctx, 'Действие доступно только в личном чате с ботом.', { show_alert: true });
    return;
  }

  const authorizedChatId = await resolveAuthorizedChatId(orderId, message.chat);
  if (authorizedChatId === null) {
    await answerCallbackQuerySafely(ctx, 'Действие доступно только в личном чате с ботом.', { show_alert: true });
    return;
  }

  const preview = peekUndoState(releaseUndoStates, orderId);
  if (!preview) {
    await answerCallbackQuerySafely(ctx, copy.undoExpired);
    return;
  }

  const executorId = ctx.from?.id;
  if (typeof executorId !== 'number' || executorId !== preview.executorId) {
    await answerCallbackQuerySafely(ctx, copy.noAccess);
    return;
  }

  if (!consumeUndoState(releaseUndoStates, orderId)) {
    await answerCallbackQuerySafely(ctx, copy.undoExpired);
    return;
  }

  await sendProcessingFeedback(ctx, { skipAnswerCbQuery: true });

  let result: UndoReleaseOutcome;
  try {
    result = await withTx(
      async (client) => {
        const order = await lockOrderById(client, orderId);
        if (!order) {
          return { outcome: 'not_found' } as const;
        }

        const updated = await tryReclaimOrder(client, orderId, executorId);
        if (!updated) {
          return { outcome: 'already_taken', order } as const;
        }

        return { outcome: 'reclaimed', order: updated } as const;
      },
      { isolationLevel: 'serializable' },
    );
  } catch (error) {
    logger.error({ err: error, orderId }, 'Failed to undo order release');
    await answerCallbackQuerySafely(ctx, copy.undoUnavailable);
    return;
  }

  switch (result.outcome) {
    case 'not_found': {
      await answerCallbackQuerySafely(ctx, 'Заказ не найден.');
      return;
    }
    case 'already_taken': {
      const locationKeyboard = buildOrderLocationsKeyboard(
        result.order.city,
        result.order.pickup,
        result.order.dropoff,
      );
      try {
        await ctx.editMessageReplyMarkup(locationKeyboard ?? undefined);
      } catch (error) {
        logger.debug(
          { err: error, orderId },
          'Failed to remove undo markup after failed release undo',
        );
      }
      await answerCallbackQuerySafely(ctx, copy.orderUndoReleaseFailed, { show_alert: true });
      return;
    }
    case 'reclaimed': {
      await removeOrderState(ctx.telegram, orderId);

      const directMessage = buildOrderDirectMessage(result.order);
      try {
        await ctx.editMessageText(directMessage.text, {
          reply_markup: directMessage.keyboard,
        });
      } catch (error) {
        logger.debug(
          { err: error, orderId },
          'Failed to restore direct message while undoing release',
        );
        try {
          await ctx.editMessageReplyMarkup(directMessage.keyboard);
        } catch (markupError) {
          logger.debug(
            { err: markupError, orderId },
            'Failed to restore keyboard while undoing release',
          );
        }
      }

      await answerCallbackQuerySafely(ctx, copy.orderUndoReleaseRestored);

      const clientId = result.order.clientId;
      if (typeof clientId === 'number') {
        const shortId = result.order.shortId ?? result.order.id.toString();
        await notifyClientAboutOrderUpdate(ctx.telegram, {
          orderId: result.order.id,
          clientId,
          introText: copy.orderUndoReleaseClientNotice(shortId),
          menuPrompt: copy.orderUndoReleaseClientMenuPrompt,
        });
      }

      await reportOrderClaimed(ctx.telegram, result.order, toUserIdentity(ctx.from));
      return;
    }
    default:
      await answerCallbackQuerySafely(ctx, copy.undoUnavailable);
  }
};

const handleUndoOrderCompletion = async (ctx: BotContext, orderId: number): Promise<void> => {
  const message = ctx.callbackQuery?.message;
  if (!message || !('chat' in message) || !message.chat) {
    await answerCallbackQuerySafely(ctx, 'Действие доступно только в личном чате с ботом.', { show_alert: true });
    return;
  }

  const authorizedChatId = await resolveAuthorizedChatId(orderId, message.chat);
  if (authorizedChatId === null) {
    await answerCallbackQuerySafely(ctx, 'Действие доступно только в личном чате с ботом.', { show_alert: true });
    return;
  }

  const preview = peekUndoState(completionUndoStates, orderId);
  if (!preview) {
    await answerCallbackQuerySafely(ctx, copy.undoExpired);
    return;
  }

  const executorId = ctx.from?.id;
  if (typeof executorId !== 'number' || executorId !== preview.executorId) {
    await answerCallbackQuerySafely(ctx, copy.noAccess);
    return;
  }

  if (!consumeUndoState(completionUndoStates, orderId)) {
    await answerCallbackQuerySafely(ctx, copy.undoExpired);
    return;
  }

  await sendProcessingFeedback(ctx, { skipAnswerCbQuery: true });

  let result: UndoCompletionOutcome;
  try {
    result = await withTx(
      async (client) => {
        const order = await lockOrderById(client, orderId);
        if (!order) {
          return { outcome: 'not_found' } as const;
        }

        if (order.status !== 'finished' || order.claimedBy !== executorId) {
          return { outcome: 'invalid', order } as const;
        }

        const updated = await tryRestoreCompletedOrder(client, orderId, executorId);
        if (!updated) {
          return { outcome: 'invalid', order } as const;
        }

        return { outcome: 'restored', order: updated } as const;
      },
      { isolationLevel: 'serializable' },
    );
  } catch (error) {
    logger.error({ err: error, orderId }, 'Failed to undo order completion');
    await answerCallbackQuerySafely(ctx, copy.undoUnavailable);
    return;
  }

  switch (result.outcome) {
    case 'not_found': {
      await answerCallbackQuerySafely(ctx, 'Заказ не найден.');
      return;
    }
    case 'invalid': {
      try {
        await ctx.editMessageReplyMarkup(
          buildOrderLocationsKeyboard(result.order.city, result.order.pickup, result.order.dropoff) ??
            undefined,
        );
      } catch (error) {
        logger.debug(
          { err: error, orderId },
          'Failed to remove undo markup after failed completion undo',
        );
      }
      await answerCallbackQuerySafely(ctx, copy.orderUndoCompleteFailed, { show_alert: true });
      return;
    }
    case 'restored': {
      const directMessage = buildOrderDirectMessage(result.order);
      try {
        await ctx.editMessageText(directMessage.text, {
          reply_markup: directMessage.keyboard,
        });
      } catch (error) {
        logger.debug(
          { err: error, orderId },
          'Failed to restore direct message while undoing completion',
        );
        try {
          await ctx.editMessageReplyMarkup(directMessage.keyboard);
        } catch (markupError) {
          logger.debug(
            { err: markupError, orderId },
            'Failed to restore keyboard while undoing completion',
          );
        }
      }

      await answerCallbackQuerySafely(ctx, copy.orderUndoCompleteRestored);

      const clientId = result.order.clientId;
      if (typeof clientId === 'number') {
        const shortId = result.order.shortId ?? result.order.id.toString();
        try {
          await ctx.telegram.sendMessage(clientId, copy.orderUndoCompletionClientNotice(shortId));
        } catch (error) {
          logger.debug(
            { err: error, orderId, clientId },
            'Failed to notify client about completion undo',
          );
        }
      }

      return;
    }
    default:
      await answerCallbackQuerySafely(ctx, copy.undoUnavailable);
  }
};

const handleOrderCompletion = async (ctx: BotContext, orderId: number): Promise<void> => {
  const message = ctx.callbackQuery?.message;
  if (!message || !('message_id' in message) || !message.chat) {
    await answerCallbackQuerySafely(ctx, 'Не удалось обработать действие.');
    return;
  }

  const authorizedChatId = await resolveAuthorizedChatId(orderId, message.chat);
  if (authorizedChatId === null) {
    await answerCallbackQuerySafely(ctx, 'Действие доступно только в личном чате с ботом.', { show_alert: true });
    return;
  }

  const executorId = ctx.from?.id;
  if (typeof executorId !== 'number') {
    await answerCallbackQuerySafely(ctx, 'Не удалось определить пользователя.');
    return;
  }

  await sendProcessingFeedback(ctx);

  let result: OrderCompletionOutcome;
  try {
    result = await processOrderCompletion(orderId, executorId);
  } catch (error) {
    logger.error({ err: error, orderId }, 'Failed to complete order');
    await answerCallbackQuerySafely(ctx, 'Не удалось завершить заказ. Попробуйте позже.');
    return;
  }

  switch (result.outcome) {
    case 'not_found':
      await answerCallbackQuerySafely(ctx, 'Заказ не найден или уже удалён.');
      return;
    case 'not_claimed':
      await answerCallbackQuerySafely(ctx, 'Заказ уже недоступен для завершения.');
      return;
    case 'forbidden':
      await answerCallbackQuerySafely(ctx, copy.noAccess);
      return;
    case 'completed': {
      const baseMessage = buildOrderDetailsMessage(result.order);
      const locationKeyboard = buildOrderLocationsKeyboard(
        result.order.city,
        result.order.pickup,
        result.order.dropoff,
      );
      const undoKeyboard = buildInlineKeyboard([
        [{ label: '↩️ Вернуть в работу', action: `${UNDO_COMPLETE_ACTION_PREFIX}:${orderId}` }],
      ]);
      const replyMarkup = mergeInlineKeyboards(locationKeyboard, undoKeyboard) ?? undoKeyboard;
      const statusLine = '✅ Заказ завершён.';

      try {
        await ctx.editMessageText([baseMessage, '', statusLine].join('\n'), {
          reply_markup: replyMarkup,
        });
      } catch (error) {
        logger.debug(
          { err: error, orderId, chatId: message.chat.id, messageId: message.message_id },
          'Failed to update direct message after completion',
        );
        try {
          await ctx.editMessageReplyMarkup(replyMarkup);
        } catch (markupError) {
          logger.debug(
            { err: markupError, orderId, chatId: message.chat.id, messageId: message.message_id },
            'Failed to update message keyboard after completion',
          );
        }
      }

      rememberUndoState(completionUndoStates, orderId, executorId);

      await answerCallbackQuerySafely(ctx, 'Заказ завершён. Спасибо!');
      const clientId = result.order.clientId;
      if (typeof clientId === 'number') {
        const shortId = result.order.shortId ?? result.order.id.toString();
        try {
          await ctx.telegram.sendMessage(
            clientId,
            `✅ Ваш заказ №${shortId} завершён. Спасибо, что пользуетесь сервисом!`,
          );
          await sendClientMenuToChat(ctx.telegram, clientId, 'Готово. Хотите оформить новый заказ?');
        } catch (error) {
          logger.debug(
            { err: error, orderId, clientId },
            'Failed to notify client about order completion',
          );
        }
      }
      await reportOrderCompleted(ctx.telegram, result.order, toUserIdentity(ctx.from));
      return;
    }
    default:
      await answerCallbackQuerySafely(ctx, 'Не удалось завершить заказ.');
      return;
  }
};

export const registerOrdersChannel = (bot: Telegraf<BotContext>): void => {
  bot.action(ACCEPT_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const idText = match?.[1];
    const orderId = idText ? Number.parseInt(idText, 10) : NaN;
    if (!Number.isInteger(orderId) || orderId <= 0) {
      await answerCallbackQuerySafely(ctx, 'Некорректный идентификатор заказа.');
      return;
    }

    const guard = await withIdempotency(ctx, 'order:accept', String(orderId), () =>
      handleOrderDecision(ctx, orderId, 'accept'),
    );
    if (guard.status === 'duplicate') {
      await answerCallbackQuerySafely(ctx, 'Запрос уже обработан.');
    }
  });

  bot.action(DECLINE_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const idText = match?.[1];
    const orderId = idText ? Number.parseInt(idText, 10) : NaN;
    if (!Number.isInteger(orderId) || orderId <= 0) {
      await answerCallbackQuerySafely(ctx, 'Некорректный идентификатор заказа.');
      return;
    }

    await handleOrderDecision(ctx, orderId, 'decline');
  });

  bot.action(RELEASE_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const idText = match?.[1];
    const orderId = idText ? Number.parseInt(idText, 10) : NaN;
    if (!Number.isInteger(orderId) || orderId <= 0) {
      await answerCallbackQuerySafely(ctx, 'Некорректный идентификатор заказа.');
      return;
    }

    const guard = await withIdempotency(ctx, 'order:release', String(orderId), () =>
      handleOrderRelease(ctx, orderId),
    );
    if (guard.status === 'duplicate') {
      await answerCallbackQuerySafely(ctx, 'Запрос уже обработан.');
    }
  });

  bot.action(COMPLETE_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const idText = match?.[1];
    const orderId = idText ? Number.parseInt(idText, 10) : NaN;
    if (!Number.isInteger(orderId) || orderId <= 0) {
      await answerCallbackQuerySafely(ctx, 'Некорректный идентификатор заказа.');
      return;
    }

    const guard = await withIdempotency(ctx, 'order:complete', String(orderId), () =>
      handleOrderCompletion(ctx, orderId),
    );
    if (guard.status === 'duplicate') {
      await answerCallbackQuerySafely(ctx, 'Запрос уже обработан.');
    }
  });

  bot.action(UNDO_RELEASE_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const idText = match?.[1];
    const orderId = idText ? Number.parseInt(idText, 10) : NaN;
    if (!Number.isInteger(orderId) || orderId <= 0) {
      await answerCallbackQuerySafely(ctx, 'Некорректный идентификатор заказа.');
      return;
    }

    const guard = await withIdempotency(ctx, 'order:undo-release', String(orderId), () =>
      handleUndoOrderRelease(ctx, orderId),
    );
    if (guard.status === 'duplicate') {
      await answerCallbackQuerySafely(ctx, 'Запрос уже обработан.');
    }
  });

  bot.action(UNDO_COMPLETE_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const idText = match?.[1];
    const orderId = idText ? Number.parseInt(idText, 10) : NaN;
    if (!Number.isInteger(orderId) || orderId <= 0) {
      await answerCallbackQuerySafely(ctx, 'Некорректный идентификатор заказа.');
      return;
    }

    const guard = await withIdempotency(ctx, 'order:undo-complete', String(orderId), () =>
      handleUndoOrderCompletion(ctx, orderId),
    );
    if (guard.status === 'duplicate') {
      await answerCallbackQuerySafely(ctx, 'Запрос уже обработан.');
    }
  });
};

export const __testing = {
  orderStates,
  releaseUndoStates,
  resolveAuthorizedChatId,
  processOrderAction,
  handleOrderDecision,
  handleOrderRelease,
  handleOrderCompletion,
  handleUndoOrderRelease,
  handleUndoOrderCompletion,
  reset: (): void => {
    orderStates.clear();
    orderDismissals.clear();
    releaseUndoStates.clear();
    completionUndoStates.clear();
  },
};
