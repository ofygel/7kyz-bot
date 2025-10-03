import { Markup } from 'telegraf';
import type { Telegram } from 'telegraf';
import type { InlineKeyboardMarkup, Message } from 'telegraf/typings/core/types/typegram';

import type { BotContext, UserRole } from '../bot/types';
import { PROFILE_BUTTON_LABEL } from '../bot/flows/common/profileCard';
import { CLIENT_ORDERS_ACTION } from '../bot/flows/client/orderActions';
import { START_DELIVERY_ORDER_ACTION } from '../bot/flows/client/deliveryOrderFlow';
import { START_TAXI_ORDER_ACTION } from '../bot/flows/client/taxiOrderFlow';
import { buildInlineKeyboard } from '../bot/keyboards/common';
import { bindInlineKeyboardToUser } from '../bot/services/callbackTokens';

export const CLIENT_MENU = {
  taxi: '🚕 Заказать такси',
  delivery: '📦 Доставка',
  orders: '🧾 Мои заказы',
  profile: PROFILE_BUTTON_LABEL,
  support: '🆘 Поддержка',
  city: '🏙️ Сменить город',
  switchRole: '👥 Сменить роль',
  refresh: '🔄 Обновить меню',
} as const;

export const CLIENT_MENU_TRIGGER = '🎯 Меню';

export const CLIENT_MENU_ACTION = 'client:menu:show';
export const CLIENT_MENU_REFRESH_ACTION = 'client:menu:refresh';
export const CLIENT_MENU_SUPPORT_ACTION = 'client:menu:support';
export const CLIENT_MENU_CITY_SELECT_ACTION = 'client:menu:city';
export const CLIENT_MENU_SWITCH_ROLE_ACTION = 'client:menu:switch-role';
export const CLIENT_MENU_PROFILE_ACTION = 'client:menu:profile';

type ClientMenuButton = { label: string; action: string };

const CLIENT_MENU_ROWS: ClientMenuButton[][] = [
  [
    { label: CLIENT_MENU.taxi, action: START_TAXI_ORDER_ACTION },
    { label: CLIENT_MENU.delivery, action: START_DELIVERY_ORDER_ACTION },
  ],
  [
    { label: CLIENT_MENU.orders, action: CLIENT_ORDERS_ACTION },
    { label: CLIENT_MENU.profile, action: CLIENT_MENU_PROFILE_ACTION },
  ],
  [
    { label: CLIENT_MENU.support, action: CLIENT_MENU_SUPPORT_ACTION },
    { label: CLIENT_MENU.city, action: CLIENT_MENU_CITY_SELECT_ACTION },
  ],
  [{ label: CLIENT_MENU.switchRole, action: CLIENT_MENU_SWITCH_ROLE_ACTION }],
  [{ label: CLIENT_MENU.refresh, action: CLIENT_MENU_REFRESH_ACTION }],
];

const buildKeyboard = (): ReturnType<typeof Markup.keyboard> =>
  Markup.keyboard([[CLIENT_MENU_TRIGGER]])
    .resize()
    .persistent();

const buildInlineMenuKeyboard = (): InlineKeyboardMarkup => buildInlineKeyboard(CLIENT_MENU_ROWS);

export const buildClientMenuKeyboard = async (
  ctx: BotContext,
): Promise<InlineKeyboardMarkup | undefined> => bindInlineKeyboardToUser(ctx, buildInlineMenuKeyboard());

const buildCombinedMenuMarkup = (
  replyMarkup: ReturnType<typeof buildKeyboard>,
  inlineKeyboard: InlineKeyboardMarkup | undefined,
) => {
  if (!inlineKeyboard) {
    return replyMarkup;
  }

  const replyKeyboard = replyMarkup.reply_markup ?? {};
  return {
    reply_markup: {
      ...replyKeyboard,
      inline_keyboard: inlineKeyboard.inline_keyboard,
    },
  };
};

const DEFAULT_MENU_PROMPT = 'Что дальше? Выберите действие:';

export const sendClientMenu = async (
  ctx: BotContext,
  text: string = DEFAULT_MENU_PROMPT,
  inlineKeyboard?: InlineKeyboardMarkup,
): Promise<Message.TextMessage | undefined> => {
  if (!ctx.chat) {
    return undefined;
  }

  const replyKeyboard = buildKeyboard();
  const resolvedInlineKeyboard = inlineKeyboard ?? (await buildClientMenuKeyboard(ctx));
  const extra = buildCombinedMenuMarkup(replyKeyboard, resolvedInlineKeyboard);

  try {
    return await ctx.reply(text, extra);
  } catch (error) {
    if (!ctx.chat?.id) {
      throw error;
    }

    try {
      return await ctx.telegram.sendMessage(ctx.chat.id, text, extra);
    } catch {
      throw error;
    }
  }
};

export const sendClientMenuToChat = async (
  telegram: Telegram,
  chatId: number,
  text: string = DEFAULT_MENU_PROMPT,
): Promise<Message.TextMessage | undefined> => {
  const replyKeyboard = buildKeyboard();
  const inlineKeyboard = buildInlineMenuKeyboard();
  const extra = buildCombinedMenuMarkup(replyKeyboard, inlineKeyboard);

  try {
    return await telegram.sendMessage(chatId, text, extra);
  } catch {
    return undefined;
  }
};

export const hideClientMenu = async (
  ctx: BotContext,
  text = 'Ок, продолжаем…',
): Promise<Message.TextMessage | undefined> => {
  if (!ctx.chat) {
    return undefined;
  }

  try {
    return await ctx.reply(text, Markup.removeKeyboard());
  } catch {
    return undefined;
  }
};

export const isClientChat = (ctx: BotContext, role?: UserRole): boolean =>
  ctx.chat?.type === 'private' && (role === 'client' || role === 'guest' || role === undefined);

export const clientMenuText = (): string =>
  [
    '🎯 Меню клиента',
    '',
    'Выберите, что хотите оформить:',
    '• 🚕 Такси — подача машины и поездка по указанному адресу.',
    '• 📦 Доставка — курьер заберёт и доставит вашу посылку.',
    '• 🧾 Мои заказы — проверка статуса и управление оформленными заказами.',
    '• 👤 Профиль — данные аккаунта, телефон и выбранный город.',
    '• 🆘 Поддержка — напишите нам, если нужна помощь.',
    '• 🏙️ Сменить город — обновите географию заказов.',
    '• 👥 Сменить роль — переключитесь на режим исполнителя или клиента.',
  ].join('\n');
