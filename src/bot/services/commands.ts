import type { Telegraf } from 'telegraf';
import type { BotCommand } from 'telegraf/typings/core/types/typegram';

import { logger } from '../../config';
import type { BotContext } from '../types';

interface SetChatCommandsOptions {
  languageCode?: string;
  showMenuButton?: boolean;
}

export const setChatCommands = async (
  telegram: Telegraf<BotContext>['telegram'],
  chatId: number,
  commands: BotCommand[],
  options: SetChatCommandsOptions = {},
): Promise<void> => {
  const languageCode = options.languageCode ?? 'ru';
  const showMenuButton = options.showMenuButton ?? true;

  try {
    await telegram.setMyCommands(commands, {
      scope: { type: 'chat', chat_id: chatId },
      language_code: languageCode,
    });
  } catch (error) {
    logger.warn({ err: error, chatId }, 'Failed to set chat-specific commands');
  }

  if (!showMenuButton) {
    return;
  }

  try {
    await telegram.setChatMenuButton({
      chatId,
      menuButton: { type: 'commands' },
    });
  } catch (error) {
    logger.warn({ err: error, chatId }, 'Failed to set chat menu button');
  }
};
