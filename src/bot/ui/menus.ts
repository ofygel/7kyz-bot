import { Markup } from 'telegraf';

import { CLIENT_MENU_TRIGGER } from '../../ui/clientMenu';
import type { BotContext } from '../types';
import { EXECUTOR_MENU_TEXT_LABELS } from '../flows/executor/menu';
import { isSafeModeSession } from '../flows/common/safeMode';
import { showSafeModeCard } from './safeModeCard';

export const CLIENT_WHITELIST: Set<string> = new Set([CLIENT_MENU_TRIGGER]);
export const EXECUTOR_WHITELIST: Set<string> = new Set(
  Object.values(EXECUTOR_MENU_TEXT_LABELS),
);

export const clientKeyboard = () =>
  Markup.keyboard([[CLIENT_MENU_TRIGGER]])
    .resize()
    .persistent();

export const executorKeyboard = () =>
  Markup.keyboard([
    [EXECUTOR_MENU_TEXT_LABELS.documents, EXECUTOR_MENU_TEXT_LABELS.subscription],
    [EXECUTOR_MENU_TEXT_LABELS.orders],
    [EXECUTOR_MENU_TEXT_LABELS.support],
    [EXECUTOR_MENU_TEXT_LABELS.refresh],
  ])
    .resize()
    .persistent();

export const onboardingKeyboard = () =>
  Markup.keyboard([Markup.button.contactRequest('Отправить мой номер телефона')])
    .oneTime()
    .resize();

export const removeKeyboard = () => Markup.removeKeyboard();

export interface RenderMenuOptions {
  prompt?: string;
}

export const renderMenuFor = async (
  ctx: BotContext,
  options: RenderMenuOptions = {},
): Promise<void> => {
  const prompt = options.prompt;
  if (isSafeModeSession(ctx)) {
    await showSafeModeCard(ctx, { prompt });
    return;
  }

  const user = ctx.auth?.user;
  const text = prompt ?? 'Выберите действие из меню ниже.';

  if (!user || user.status === 'awaiting_phone' || !user.phoneVerified) {
    await ctx.reply(text, onboardingKeyboard());
    return;
  }

  if (user.status === 'suspended' || user.status === 'banned') {
    await ctx.reply('Доступ к функциям бота ограничен. Обратитесь в поддержку.', removeKeyboard());
    return;
  }

  const role = user.role;
  if (role === 'executor' || role === 'moderator') {
    await ctx.reply(prompt ?? 'Меню исполнителя доступно ниже.', executorKeyboard());
    return;
  }

  await ctx.reply(prompt ?? 'Меню клиента доступно ниже.', clientKeyboard());
};
