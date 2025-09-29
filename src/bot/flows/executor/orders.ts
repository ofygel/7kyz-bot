import { Markup, Telegraf } from 'telegraf';

import type { BotContext } from '../../types';
import { ui } from '../../ui';
import {
  EXECUTOR_MENU_ACTION,
  EXECUTOR_MENU_TEXT_LABELS,
  EXECUTOR_ORDERS_ACTION,
  ensureExecutorState,
} from './menu';
import { getExecutorRoleCopy } from '../../copy';
import { presentRolePick } from '../../commands/start';

const ORDERS_INFO_STEP_ID = 'executor:orders:info';
const SUPPORT_USERNAME = 'support_seven';
const SUPPORT_LINK = `https://t.me/${SUPPORT_USERNAME}`;

export const EXECUTOR_SUBSCRIPTION_REQUIRED_MESSAGE =
  'Подписка на канал заказов оформляется через поддержку. Напишите @support_seven, чтобы получить инструкции и ссылку.';

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
    'Чтобы попасть в канал с заказами, напишите @support_seven. Команда оформит подписку, проверит оплату и пришлёт актуальную ссылку.',
    '',
    'После подключения следите за обновлениями канала и уточняйте любые вопросы у поддержки.',
  ].join('\n');
};

const buildOrdersKeyboard = () =>
  Markup.inlineKeyboard([
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

  bot.hears(EXECUTOR_MENU_TEXT_LABELS.orders, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return;
    }

    await showExecutorOrdersInfo(ctx);
  });
};
