import { Markup } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import { copy } from '../copy';

export function buildStatusMessage(
  emoji: string,
  line: string,
  refreshAction: string,
  backAction: string,
): { text: string; reply_markup: InlineKeyboardMarkup } {
  const text = copy.statusLine(emoji, line);
  const reply_markup = Markup.inlineKeyboard([
    [Markup.button.callback(copy.refresh, refreshAction)],
    [Markup.button.callback(copy.back, backAction)],
  ]).reply_markup as InlineKeyboardMarkup;

  return { text, reply_markup };
}
