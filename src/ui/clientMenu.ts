import { Markup } from 'telegraf';
import type { Telegram } from 'telegraf';
import type { Message } from 'telegraf/typings/core/types/typegram';

import type { BotContext, UserRole } from '../bot/types';
import { PROFILE_BUTTON_LABEL } from '../bot/flows/common/profileCard';

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

const buildKeyboard = (): ReturnType<typeof Markup.keyboard> =>
  Markup.keyboard([
    [CLIENT_MENU.taxi, CLIENT_MENU.delivery],
    [CLIENT_MENU.orders, CLIENT_MENU.profile],
    [CLIENT_MENU.support, CLIENT_MENU.city],
    [CLIENT_MENU.switchRole],
    [CLIENT_MENU.refresh],
  ])
    .resize()
    .persistent();

const DEFAULT_MENU_PROMPT = 'Что дальше? Выберите действие:';

export const sendClientMenu = async (
  ctx: BotContext,
  text: string = DEFAULT_MENU_PROMPT,
): Promise<Message.TextMessage | undefined> => {
  if (!ctx.chat) {
    return undefined;
  }

  try {
    return await ctx.reply(text, buildKeyboard());
  } catch (error) {
    if (!ctx.chat?.id) {
      throw error;
    }

    try {
      return await ctx.telegram.sendMessage(ctx.chat.id, text, buildKeyboard());
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
  try {
    return await telegram.sendMessage(chatId, text, buildKeyboard());
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
