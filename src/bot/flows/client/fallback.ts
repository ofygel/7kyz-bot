import type { Message, MessageEntity } from 'telegraf/typings/core/types/typegram';
import type { Telegraf } from 'telegraf';

import { isClientChat, sendClientMenu } from '../../../ui/clientMenu';
import type { BotContext } from '../../types';
import { isClientGlobalMenuIntent } from './globalIntents';

const isBotCommandMessage = (message: Message): boolean => {
  const textEntitySource = message as Partial<Message.TextMessage>;
  const captionEntitySource = message as Partial<{ caption?: string; caption_entities?: MessageEntity[] }>;

  const entities = textEntitySource.entities ?? captionEntitySource.caption_entities;
  if (entities?.some((entity) => entity.type === 'bot_command' && entity.offset === 0)) {
    return true;
  }

  const text = textEntitySource.text ?? captionEntitySource.caption;
  return typeof text === 'string' && text.startsWith('/');
};

const shouldHandleFallback = (ctx: BotContext): boolean => {
  if (!ctx.chat || ctx.chat.type !== 'private') {
    return false;
  }

  if (!isClientChat(ctx, ctx.auth?.user.role)) {
    return false;
  }

  if (!ctx.session?.client) {
    return false;
  }

  const message = ctx.message as Message | undefined;
  if (!message) {
    return false;
  }

  const text = 'text' in message && typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) {
    return false;
  }

  if (ctx.session.support?.status === 'awaiting_message') {
    return false;
  }

  const isGlobalIntent = isClientGlobalMenuIntent(text);

  if (!isGlobalIntent) {
    const taxiStage = ctx.session.client.taxi?.stage ?? 'idle';
    const deliveryStage = ctx.session.client.delivery?.stage ?? 'idle';

    if (taxiStage !== 'idle' || deliveryStage !== 'idle') {
      return false;
    }
  }

  if (!isGlobalIntent && isBotCommandMessage(message)) {
    return false;
  }

  return true;
};

export const registerClientFallback = (bot: Telegraf<BotContext>): void => {
  bot.on('message', async (ctx, next) => {
    if (!shouldHandleFallback(ctx)) {
      if (next) {
        await next();
      }
      return;
    }

    await sendClientMenu(ctx, 'Я пока не понял сообщение. Пожалуйста, выберите действие в меню ниже.');
  });
};

export const __testing__ = {
  isBotCommandMessage,
  shouldHandleFallback,
};
