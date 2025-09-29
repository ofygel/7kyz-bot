import { Markup } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

export interface InlineButton {
  label: string;
  action: string;
}

export interface UrlButton {
  label: string;
  url: string;
}

export type KeyboardButton = InlineButton | UrlButton;

const isUrlButton = (button: KeyboardButton): button is UrlButton =>
  'url' in button;

const createButton = (button: KeyboardButton) =>
  isUrlButton(button)
    ? Markup.button.url(button.label, button.url)
    : Markup.button.callback(button.label, button.action);

export const buildInlineKeyboard = (
  rows: KeyboardButton[][],
): InlineKeyboardMarkup => ({
  inline_keyboard: rows.map((row) => row.map(createButton)),
});

export interface ConfirmCancelKeyboardOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  layout?: 'horizontal' | 'vertical';
}

export const buildConfirmCancelKeyboard = (
  confirmAction: string,
  cancelAction: string,
  options: ConfirmCancelKeyboardOptions = {},
): InlineKeyboardMarkup => {
  const confirmLabel = options.confirmLabel ?? '✅ Подтвердить';
  const cancelLabel = options.cancelLabel ?? '❌ Отменить';

  if (options.layout === 'horizontal') {
    return buildInlineKeyboard([
      [
        { label: confirmLabel, action: confirmAction },
        { label: cancelLabel, action: cancelAction },
      ],
    ]);
  }

  return buildInlineKeyboard([
    [{ label: confirmLabel, action: confirmAction }],
    [{ label: cancelLabel, action: cancelAction }],
  ]);
};

export const buildCloseKeyboard = (
  action: string,
  label = '❌ Закрыть',
): InlineKeyboardMarkup =>
  buildInlineKeyboard([[{ label, action }]]);

export const buildUrlKeyboard = (
  label: string,
  url: string,
): InlineKeyboardMarkup => buildInlineKeyboard([[{ label, url }]]);

export const mergeInlineKeyboards = (
  ...keyboards: (InlineKeyboardMarkup | undefined)[]
): InlineKeyboardMarkup | undefined => {
  const rows = keyboards
    .filter((keyboard): keyboard is InlineKeyboardMarkup => Boolean(keyboard))
    .flatMap((keyboard) => keyboard.inline_keyboard ?? []);

  if (rows.length === 0) {
    return undefined;
  }

  return { inline_keyboard: rows };
};
