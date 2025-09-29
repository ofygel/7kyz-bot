import type { BotContext } from '../types';
import { ui } from '../ui';
import { buildInlineKeyboard } from '../keyboards/common';

export const SAFE_MODE_CARD_STEP_ID = 'common:safe-mode:card';

const SAFE_MODE_PROFILE_ACTION = 'safe-mode:profile';
const SAFE_MODE_CITY_ACTION = 'safe-mode:city';
const SAFE_MODE_SUPPORT_ACTION = 'safe-mode:support';
const SAFE_MODE_MENU_ACTION = 'safe-mode:menu';

export const SAFE_MODE_CARD_ACTIONS = {
  profile: SAFE_MODE_PROFILE_ACTION,
  city: SAFE_MODE_CITY_ACTION,
  support: SAFE_MODE_SUPPORT_ACTION,
  menu: SAFE_MODE_MENU_ACTION,
} as const;

const buildSafeModeKeyboard = () =>
  buildInlineKeyboard([
    [
      { label: 'Профиль', action: SAFE_MODE_PROFILE_ACTION },
      { label: 'Сменить город', action: SAFE_MODE_CITY_ACTION },
    ],
    [{ label: 'Помощь', action: SAFE_MODE_SUPPORT_ACTION }],
  ]);

export const buildSafeModeCardText = (prompt?: string): string => {
  const lines = [
    '⚠️ Наш бот работает в безопасном режиме — часть функций недоступна.',
    prompt ?? 'Пока доступны только базовые действия: [Профиль], [Сменить город], [Помощь].',
    '',
    '• Профиль — посмотрите актуальные данные аккаунта.',
    '• Сменить город — уточните рабочий город.',
    '• Помощь — свяжитесь с поддержкой.',
  ];

  return lines.join('\n');
};

export interface ShowSafeModeCardOptions {
  prompt?: string;
}

export const showSafeModeCard = async (
  ctx: BotContext,
  options: ShowSafeModeCardOptions = {},
): Promise<void> => {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const promptFromOptions =
    typeof options.prompt === 'string' ? options.prompt.trim() : undefined;
  const sessionPrompt =
    typeof ctx.session?.safeModePrompt === 'string'
      ? ctx.session.safeModePrompt.trim()
      : undefined;
  const resolvedPrompt =
    promptFromOptions && promptFromOptions.length > 0
      ? promptFromOptions
      : sessionPrompt && sessionPrompt.length > 0
        ? sessionPrompt
        : undefined;

  if (resolvedPrompt && ctx.session) {
    ctx.session.safeModePrompt = resolvedPrompt;
  }

  await ui.step(ctx, {
    id: SAFE_MODE_CARD_STEP_ID,
    text: buildSafeModeCardText(resolvedPrompt),
    keyboard: buildSafeModeKeyboard(),
    cleanup: false,
  });
};

export const __testing__ = {
  buildSafeModeCardText,
  SAFE_MODE_CARD_ACTIONS,
};
