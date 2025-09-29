import { Markup } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import { formatPriceAmount } from './pricing';

export interface PaymentDetails {
  amount: number;
  currency: string;
  recipient?: string;
  description?: string | string[];
  reference?: string;
  url?: string;
  urlLabel?: string;
}

const normaliseDescription = (value?: string | string[]): string[] => {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

export const buildPaymentMessage = (details: PaymentDetails): string => {
  const lines = ['💳 Оплата заказа'];
  lines.push(`Сумма к оплате: ${formatPriceAmount(details.amount, details.currency)}.`);

  if (details.recipient) {
    lines.push(`Получатель: ${details.recipient}.`);
  }

  const description = normaliseDescription(details.description);
  if (description.length > 0) {
    lines.push('');
    lines.push(...description);
  }

  if (details.reference) {
    lines.push('');
    lines.push(`Назначение платежа: ${details.reference}`);
  }

  lines.push('', 'После оплаты отправьте, пожалуйста, чек в этот чат.');

  return lines.join('\n');
};

export const buildPaymentKeyboard = (
  details: PaymentDetails,
): InlineKeyboardMarkup | undefined => {
  if (!details.url) {
    return undefined;
  }

  const label = details.urlLabel ?? 'Перейти к оплате';
  return Markup.inlineKeyboard([[Markup.button.url(label, details.url)]]).reply_markup;
};
