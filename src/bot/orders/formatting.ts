import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import { CITY_LABEL } from '../../domain/cities';
import type { OrderStatus, OrderWithExecutor } from '../../types';
import { buildInlineKeyboard } from '../keyboards/common';
import { formatDistance, formatEtaMinutes, formatPriceAmount } from '../services/pricing';

export const ORDER_KIND_ICONS: Record<OrderWithExecutor['kind'], string> = {
  taxi: '🚕',
  delivery: '🚚',
};

export const ORDER_KIND_LABELS: Record<OrderWithExecutor['kind'], string> = {
  taxi: 'Такси',
  delivery: 'Доставка',
};

const ORDER_STATUS_TEXT: Record<OrderStatus, { short: string; full: string }> = {
  new: { short: 'обрабатывается', full: 'Обрабатывается оператором' },
  open: { short: 'ожидает исполнителя', full: 'Ожидает исполнителя' },
  claimed: { short: 'в работе', full: 'Выполняется исполнителем' },
  in_progress: { short: 'в работе', full: 'Исполнитель подтвердил начало выполнения' },
  cancelled: { short: 'отменён', full: 'Заказ отменён' },
  finished: { short: 'завершён', full: 'Заказ выполнен' },
  expired: { short: 'истёк', full: 'Срок выполнения истёк' },
};

export const formatStatusLabel = (
  status: OrderStatus,
): { short: string; full: string } => ORDER_STATUS_TEXT[status] ?? { short: status, full: status };

const formatFullName = (first?: string, last?: string): string | undefined => {
  const full = [first?.trim(), last?.trim()].filter(Boolean).join(' ').trim();
  return full || undefined;
};

export const formatExecutorLabel = (order: OrderWithExecutor): string => {
  const executor = order.executor;
  if (!executor) {
    return typeof order.claimedBy === 'number' ? `ID ${order.claimedBy}` : 'неизвестно';
  }

  const fullName = formatFullName(executor.firstName, executor.lastName);
  if (fullName && executor.username) {
    return `${fullName} (@${executor.username})`;
  }

  if (fullName) {
    return fullName;
  }

  if (executor.username) {
    return `@${executor.username}`;
  }

  return `ID ${executor.telegramId}`;
};

const normalisePhoneNumber = (phone: string): string => phone.replace(/[\s()-]/g, '');

export const buildOrderContactKeyboard = (
  order: OrderWithExecutor,
): InlineKeyboardMarkup | undefined => {
  if (order.status !== 'claimed' && order.status !== 'in_progress') {
    return undefined;
  }

  const executor = order.executor;
  if (!executor) {
    return undefined;
  }

  const rows: { label: string; url: string }[][] = [];
  const phone = executor.phone?.trim();
  if (phone) {
    rows.push([{ label: '📞 Позвонить', url: `tel:${normalisePhoneNumber(phone)}` }]);
  }

  const chatUrl = executor.username
    ? `https://t.me/${executor.username}`
    : executor.telegramId
    ? `tg://user?id=${executor.telegramId}`
    : undefined;
  if (chatUrl) {
    rows.push([{ label: '💬 Написать в Telegram', url: chatUrl }]);
  }

  if (rows.length === 0) {
    return undefined;
  }

  return buildInlineKeyboard(rows);
};

export interface OrderDetailOptions {
  confirmCancellation?: boolean;
}

export const buildOrderDetailText = (
  order: OrderWithExecutor,
  options: OrderDetailOptions,
): string => {
  const status = formatStatusLabel(order.status);
  const headerIcon = ORDER_KIND_ICONS[order.kind] ?? '📦';
  const kindLabel = ORDER_KIND_LABELS[order.kind] ?? 'Заказ';
  const lines: string[] = [];

  lines.push(`${headerIcon} ${kindLabel} №${order.shortId}`);
  lines.push(`🏙️ Город: ${CITY_LABEL[order.city]}.`);
  lines.push(`Статус: ${status.full}.`);
  lines.push('');
  lines.push(`📍 Подача: ${order.pickup.address}`);
  lines.push(`🎯 Назначение: ${order.dropoff.address}`);
  lines.push(`📏 Расстояние: ${formatDistance(order.price.distanceKm)} км`);
  lines.push(`⏱️ В пути: ≈${formatEtaMinutes(order.price.etaMinutes)} мин`);
  lines.push(`💰 Стоимость: ${formatPriceAmount(order.price.amount, order.price.currency)}`);

  if (order.clientComment?.trim()) {
    lines.push('', `📝 Комментарий: ${order.clientComment.trim()}`);
  }

  if (order.status === 'claimed' || order.status === 'in_progress') {
    lines.push('');
    lines.push(`👤 Исполнитель: ${formatExecutorLabel(order)}`);
    if (order.executor?.phone?.trim()) {
      lines.push(`📞 Телефон: ${order.executor.phone.trim()}`);
    }
    if (order.executor?.username?.trim()) {
      lines.push(`🔗 Telegram: @${order.executor.username.trim()}`);
    }
  }

  if (options.confirmCancellation) {
    lines.push('');
    lines.push('⚠️ Подтвердите отмену заказа. После отмены он станет недоступен исполнителям.');
    if (order.status === 'claimed' || order.status === 'in_progress') {
      lines.push('Если исполнитель уже назначен, возможна комиссия.');
    }
  }

  lines.push('');
  lines.push('Используйте кнопки ниже, чтобы управлять заказом.');

  return lines.join('\n');
};
