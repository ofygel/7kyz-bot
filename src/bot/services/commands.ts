import type { Telegraf } from 'telegraf';
import type { BotCommand, ChatFromGetChat } from 'telegraf/typings/core/types/typegram';

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

  const extractTelegramErrorCode = (error: unknown): number | undefined => {
    const telegramError = error as {
      error_code?: number;
      code?: number;
      response?: { error_code?: number };
    } | null;

    return telegramError?.code ?? telegramError?.error_code ?? telegramError?.response?.error_code;
  };

  const extractTelegramErrorDescription = (error: unknown): string | undefined => {
    const telegramError = error as {
      description?: string;
      message?: string;
      response?: { description?: string };
    } | null;

    return (
      telegramError?.description ??
      telegramError?.response?.description ??
      telegramError?.message ??
      (error instanceof Error ? error.message : undefined)
    );
  };

  const isNonActionableChatCommandError = (error: unknown): boolean => {
    const code = extractTelegramErrorCode(error);
    if (code !== 400) {
      return false;
    }

    const description = extractTelegramErrorDescription(error);
    if (!description) {
      return false;
    }

    const lowered = description.toLowerCase();

    return (
      lowered.includes("can't change commands in channel chats") ||
      lowered.includes('invalid chat_id')
    );
  };

  let chat: ChatFromGetChat | undefined;
  try {
    chat = await telegram.getChat(chatId);
  } catch (error) {
    if (isNonActionableChatCommandError(error)) {
      logger.info({ err: error, chatId }, 'Skipping chat commands setup due to unsupported chat');
      return;
    }

    logger.warn({ err: error, chatId }, 'Failed to fetch chat before setting commands');
  }

  if (chat?.type === 'channel') {
    logger.debug({ chatId }, 'Skipping chat commands registration for channel chat');
    return;
  }

  try {
    await telegram.setMyCommands(commands, {
      scope: { type: 'chat', chat_id: chatId },
      language_code: languageCode,
    });
  } catch (error) {
    if (isNonActionableChatCommandError(error)) {
      logger.info({ err: error, chatId }, 'Skipping chat commands setup due to unsupported chat');
      return;
    }

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
    logger.info({ chatId }, 'Chat menu button set to commands');
  } catch (error) {
    if (isNonActionableChatCommandError(error)) {
      logger.info({ err: error, chatId }, 'Skipping chat menu button setup due to unsupported chat');
      return;
    }

    logger.warn({ err: error, chatId }, 'Failed to set chat menu button');
  }
};
