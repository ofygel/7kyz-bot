import { Markup, Telegraf } from 'telegraf';

import { config } from '../../../config';
import type { BotContext } from '../../types';
import { getExecutorRoleCopy } from '../../copy';
import {
  EXECUTOR_MENU_ACTION,
  EXECUTOR_MENU_TEXT_LABELS,
  EXECUTOR_SUBSCRIPTION_ACTION,
  ensureExecutorState,
} from './menu';
import { contactModeratorBtn, ui } from '../../ui';
import {
  getSubscriptionPeriodOptions,
  formatSubscriptionAmount,
} from './subscriptionPlans';
import { presentRolePick } from '../../commands/start';

const SUBSCRIPTION_INFO_STEP_ID = 'executor:subscription:info';
const SUPPORT_MENTION = config.support.mention;
const SUPPORT_LINK = config.support.url;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });

const buildPaymentDetails = (): string[] => [
  'Оплатите удобным способом по реквизитам ниже или уточните детали у поддержки:',
  `Получатель: ${escapeHtml(config.subscriptions.payment.kaspi.name)}`,
  `Kaspi Gold: ${escapeHtml(config.subscriptions.payment.kaspi.card)}`,
  `Телефон: ${escapeHtml(config.subscriptions.payment.kaspi.phone)}`,
];

const buildPlanLine = (label: string, amount: number, currency: string): string =>
  `• ${escapeHtml(label)} — ${escapeHtml(formatSubscriptionAmount(amount, currency))}`;

const buildSubscriptionInfoText = (ctx: BotContext): string => {
  const state = ensureExecutorState(ctx);
  const role = state.role;
  if (!role) {
    return 'Выберите роль исполнителя, чтобы увидеть информацию о подписке.';
  }

  const roleCopy = getExecutorRoleCopy(role);
  const planLines = getSubscriptionPeriodOptions().map((option) =>
    buildPlanLine(option.label, option.amount, option.currency),
  );

  const supportLinkHtml = `<a href="${escapeHtml(SUPPORT_LINK)}">${escapeHtml(SUPPORT_MENTION)}</a>`;

  return [
    `${escapeHtml(roleCopy.emoji)} Подписка для ${escapeHtml(roleCopy.genitive)}`,
    '',
    '1. <b>Выберите тариф</b>',
    ...planLines,
    '',
    '2. <b>Оплатите выбранный тариф</b>',
    ...buildPaymentDetails(),
    '',
    '3. <b>Отправьте чек в поддержку</b>',
    `Передайте чек ${supportLinkHtml} — команда проверит оплату и откроет доступ к заказам.`,
  ].join('\n');
};

const buildSubscriptionKeyboard = () => {
  const planRows = getSubscriptionPeriodOptions().map((option) => [
    Markup.button.url(option.label, SUPPORT_LINK),
  ]);

  return Markup.inlineKeyboard([
    ...planRows,
    [contactModeratorBtn()],
    [Markup.button.url('Написать в поддержку', SUPPORT_LINK)],
    [Markup.button.callback('⬅️ Назад в меню', EXECUTOR_MENU_ACTION)],
  ]).reply_markup;
};

export interface StartExecutorSubscriptionOptions {
  skipVerificationCheck?: boolean;
}

export const startExecutorSubscription = async (
  ctx: BotContext,
  _options: StartExecutorSubscriptionOptions = {},
): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  const state = ensureExecutorState(ctx);
  if (!state.role) {
    await presentRolePick(ctx, { withHint: true });
    return;
  }

  state.subscription.status = 'await_payment_manual';
  state.subscription.paymentRequestedAt = Date.now();

  await ui.step(ctx, {
    id: SUBSCRIPTION_INFO_STEP_ID,
    text: buildSubscriptionInfoText(ctx),
    keyboard: buildSubscriptionKeyboard(),
    parseMode: 'HTML',
    cleanup: true,
    homeAction: EXECUTOR_MENU_ACTION,
  });
};

export const registerExecutorSubscription = (bot: Telegraf<BotContext>): void => {
  bot.action(EXECUTOR_SUBSCRIPTION_ACTION, async (ctx) => {
    await ctx.answerCbQuery();
    await startExecutorSubscription(ctx);
  });

  bot.hears(EXECUTOR_MENU_TEXT_LABELS.subscription, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return;
    }

    await startExecutorSubscription(ctx);
  });
};

export const __private__ = {
  buildSubscriptionInfoText,
  buildSubscriptionKeyboard,
};
