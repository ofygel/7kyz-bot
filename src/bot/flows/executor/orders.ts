import { Markup, Telegraf } from 'telegraf';

import type { BotContext } from '../../types';
import type { OrderWithExecutor } from '../../../types';
import { ui } from '../../ui';
import { config, logger } from '../../../config';
import {
  EXECUTOR_MENU_ACTION,
  EXECUTOR_MENU_TEXT_LABELS,
  EXECUTOR_ORDERS_ACTION,
  ensureExecutorState,
} from './menu';
import { getExecutorRoleCopy } from '../../copy';
import { presentRolePick } from '../../commands/start';
import {
  completeOrderByExecutor,
  getOrderWithExecutorById,
  listExecutorOrders,
} from '../../../db/orders';
import { CITY_LABEL } from '../../../domain/cities';
import { ORDER_KIND_ICONS, formatStatusLabel } from '../../orders/formatting';
import { buildInlineKeyboard } from '../../keyboards/common';
import { formatDistance, formatEtaMinutes, formatPriceAmount } from '../../services/pricing';

const ORDERS_INFO_STEP_ID = 'executor:orders:info';
const SUPPORT_MENTION = config.support.mention;
const SUPPORT_LINK = config.support.url;

export const EXECUTOR_SUBSCRIPTION_REQUIRED_MESSAGE =
  `Подписка на канал заказов оформляется через поддержку. Напишите ${SUPPORT_MENTION}, чтобы получить инструкции и ссылку.`;

const ACTIVE_ORDERS_STEP_ID = 'executor:orders:active';
const ORDER_DETAIL_STEP_ID = 'executor:orders:detail';
export const EXECUTOR_ACTIVE_ORDERS_ACTION = 'executor:orders:active';
const EXECUTOR_ORDER_VIEW_ACTION_PREFIX = 'executor:orders:view';
const EXECUTOR_ORDER_VIEW_ACTION_PATTERN = /^executor:orders:view:(\d+)$/;
const EXECUTOR_ORDER_FINISH_ACTION_PREFIX = 'executor:orders:finish';
const EXECUTOR_ORDER_FINISH_ACTION_PATTERN = /^executor:orders:finish:(\d+)$/;

type OrdersFailureScope = 'list' | 'detail' | 'complete';

const handleOrdersFailure = async (
  ctx: BotContext,
  scope: OrdersFailureScope,
  error: unknown,
): Promise<void> => {
  logger.error(
    {
      err: error,
      scope,
      chatId: ctx.chat?.id,
      telegramId: ctx.auth?.user.telegramId,
    },
    'Executor orders flow failed',
  );

  try {
    await ctx.answerCbQuery('Не удалось обработать запрос. Попробуйте ещё раз позже.', {
      show_alert: scope !== 'list',
    });
  } catch (answerError) {
    logger.warn({ err: answerError, scope }, 'Failed to send executor orders failure response');
  }
};

const parseOrderId = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const formatOrderSummary = (order: OrderWithExecutor): string => {
  const status = formatStatusLabel(order.status);
  const icon = ORDER_KIND_ICONS[order.kind] ?? '📦';
  return `${icon} №${order.shortId} • ${status.short}`;
};

const buildActiveOrdersListText = (orders: OrderWithExecutor[]): string => {
  if (orders.length === 0) {
    return [
      '📋 Активные заказы',
      '',
      'У вас сейчас нет активных заказов. Возьмите новый заказ в канале и возвращайтесь, чтобы завершить его.',
    ].join('\n');
  }

  const lines = ['📋 Активные заказы', ''];
  orders.forEach((order, index) => {
    lines.push(`${index + 1}. ${formatOrderSummary(order)}`);
  });
  lines.push('', 'Выберите заказ, чтобы посмотреть детали и завершить его.');
  return lines.join('\n');
};

const buildActiveOrdersListKeyboard = (orders: OrderWithExecutor[]) => {
  const rows: { label: string; action: string }[][] = orders.map((order) => [
    {
      label: `${ORDER_KIND_ICONS[order.kind] ?? '📦'} №${order.shortId}`,
      action: `${EXECUTOR_ORDER_VIEW_ACTION_PREFIX}:${order.id}`,
    },
  ]);

  rows.push([{ label: '⬅️ Назад в меню', action: EXECUTOR_MENU_ACTION }]);
  return buildInlineKeyboard(rows);
};

const buildEmptyOrdersKeyboard = () =>
  buildInlineKeyboard([
    [{ label: '⬅️ Назад в меню', action: EXECUTOR_MENU_ACTION }],
  ]);

const buildExecutorOrderDetailText = (order: OrderWithExecutor): string => {
  const status = formatStatusLabel(order.status);
  const icon = ORDER_KIND_ICONS[order.kind] ?? '📦';
  const lines: string[] = [
    `${icon} Заказ №${order.shortId}`,
    `Статус: ${status.full}.`,
    `Город: ${CITY_LABEL[order.city]}.`,
    '',
    `📍 Подача: ${order.pickup.address}`,
    `🎯 Назначение: ${order.dropoff.address}`,
    `📏 Расстояние: ${formatDistance(order.price.distanceKm)} км`,
    `⏱️ В пути: ≈${formatEtaMinutes(order.price.etaMinutes)} мин`,
    `💰 Стоимость: ${formatPriceAmount(order.price.amount, order.price.currency)}`,
  ];

  if (order.clientComment?.trim()) {
    lines.push('', `📝 Комментарий клиента: ${order.clientComment.trim()}`);
  }

  if (order.status === 'claimed') {
    lines.push('', 'Завершите заказ после выполнения, чтобы освободить очередь.');
  }

  if (order.status === 'finished') {
    lines.push('', '✅ Заказ отмечен завершённым. Можно взять следующий.');
  } else if (order.status === 'expired') {
    lines.push('', '⚠️ Срок выполнения истёк, заказ закрыт автоматически.');
  }

  return lines.join('\n');
};

const buildExecutorOrderDetailKeyboard = (
  order: OrderWithExecutor,
  executorId: number,
) => {
  const rows: { label: string; action: string }[][] = [];

  if (order.status === 'claimed' && order.claimedBy === executorId) {
    rows.push([
      {
        label: '🛑 Завершить заказ',
        action: `${EXECUTOR_ORDER_FINISH_ACTION_PREFIX}:${order.id}`,
      },
    ]);
  }

  rows.push([{ label: '📋 Активные заказы', action: EXECUTOR_ACTIVE_ORDERS_ACTION }]);
  rows.push([{ label: '⬅️ Назад в меню', action: EXECUTOR_MENU_ACTION }]);

  return buildInlineKeyboard(rows);
};

const buildOrdersInfoText = (ctx: BotContext): string => {
  const state = ensureExecutorState(ctx);
  const role = state.role;
  if (!role) {
    return 'Выберите роль исполнителя, чтобы получить доступ к подсказкам по заказам.';
  }

  const copy = getExecutorRoleCopy(role);
  return [
    `${copy.emoji} Доступ к заказам`,
    '',
    `Чтобы попасть в канал с заказами, напишите ${SUPPORT_MENTION}. Команда оформит подписку, проверит оплату и пришлёт актуальную ссылку.`,
    '',
    'После подключения следите за обновлениями канала и уточняйте любые вопросы у поддержки.',
  ].join('\n');
};

const renderActiveOrdersList = async (ctx: BotContext): Promise<void> => {
  try {
    const orders = await listExecutorOrders(ctx.auth.user.telegramId, ['open', 'claimed']);
    const text = buildActiveOrdersListText(orders);
    const keyboard = orders.length > 0 ? buildActiveOrdersListKeyboard(orders) : buildEmptyOrdersKeyboard();

    await ui.step(ctx, {
      id: ACTIVE_ORDERS_STEP_ID,
      text,
      keyboard,
      homeAction: EXECUTOR_MENU_ACTION,
      cleanup: true,
    });
  } catch (error) {
    await handleOrdersFailure(ctx, 'list', error);
  }
};

const renderExecutorOrderDetail = async (
  ctx: BotContext,
  order: OrderWithExecutor,
): Promise<void> => {
  const executorId = ctx.auth.user.telegramId;
  if (order.claimedBy !== executorId) {
    await ctx.answerCbQuery('Заказ больше не относится к вашему профилю.', { show_alert: true });
    return;
  }

  const text = buildExecutorOrderDetailText(order);
  const keyboard = buildExecutorOrderDetailKeyboard(order, executorId);

  await ui.step(ctx, {
    id: ORDER_DETAIL_STEP_ID,
    text,
    keyboard,
    homeAction: EXECUTOR_MENU_ACTION,
    cleanup: false,
  });
};

const showExecutorOrderDetail = async (ctx: BotContext, orderId: number): Promise<void> => {
  try {
    const order = await getOrderWithExecutorById(orderId);
    if (!order) {
      await ctx.answerCbQuery('Заказ не найден.', { show_alert: true });
      return;
    }

    await renderExecutorOrderDetail(ctx, order);
  } catch (error) {
    await handleOrdersFailure(ctx, 'detail', error);
  }
};

const completeExecutorOrder = async (ctx: BotContext, orderId: number): Promise<void> => {
  try {
    const result = await completeOrderByExecutor(orderId, ctx.auth.user.telegramId);
    if (!result) {
      await ctx.answerCbQuery('Не удалось завершить заказ. Проверьте статус и попробуйте снова.', {
        show_alert: true,
      });
      return;
    }

    await ctx.answerCbQuery('Заказ отмечен завершённым.');
    const updated = await getOrderWithExecutorById(orderId);
    if (updated) {
      await renderExecutorOrderDetail(ctx, updated);
    }
  } catch (error) {
    await handleOrdersFailure(ctx, 'complete', error);
  }
};

const buildOrdersKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 Активные заказы', EXECUTOR_ACTIVE_ORDERS_ACTION)],
    [Markup.button.url('Написать в поддержку', SUPPORT_LINK)],
    [Markup.button.callback('⬅️ Назад в меню', EXECUTOR_MENU_ACTION)],
  ]).reply_markup;

export const showExecutorOrdersInfo = async (ctx: BotContext): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  const state = ensureExecutorState(ctx);
  if (!state.role) {
    await presentRolePick(ctx, { withHint: true });
    return;
  }

  await ui.step(ctx, {
    id: ORDERS_INFO_STEP_ID,
    text: buildOrdersInfoText(ctx),
    keyboard: buildOrdersKeyboard(),
    cleanup: true,
    homeAction: EXECUTOR_MENU_ACTION,
  });
};

export const registerExecutorOrders = (bot: Telegraf<BotContext>): void => {
  bot.action(EXECUTOR_ORDERS_ACTION, async (ctx) => {
    await ctx.answerCbQuery();
    await showExecutorOrdersInfo(ctx);
  });

  bot.action(EXECUTOR_ACTIVE_ORDERS_ACTION, async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.chat?.type !== 'private') {
      return;
    }

    await renderActiveOrdersList(ctx);
  });

  bot.action(EXECUTOR_ORDER_VIEW_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpExecArray | null;
    const orderId = parseOrderId(match?.[1]);
    if (!orderId) {
      await ctx.answerCbQuery('Заказ не найден.', { show_alert: true });
      return;
    }

    if (ctx.chat?.type !== 'private') {
      await ctx.answerCbQuery();
      return;
    }

    await ctx.answerCbQuery();
    await showExecutorOrderDetail(ctx, orderId);
  });

  bot.action(EXECUTOR_ORDER_FINISH_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpExecArray | null;
    const orderId = parseOrderId(match?.[1]);
    if (!orderId) {
      await ctx.answerCbQuery('Заказ не найден.', { show_alert: true });
      return;
    }

    if (ctx.chat?.type !== 'private') {
      await ctx.answerCbQuery();
      return;
    }

    await completeExecutorOrder(ctx, orderId);
  });

  bot.hears(EXECUTOR_MENU_TEXT_LABELS.orders, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return;
    }

    await showExecutorOrdersInfo(ctx);
  });
};
