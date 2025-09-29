import { Telegraf } from 'telegraf';
import type { MessageEntity } from 'telegraf/types';

import { saveChannelBinding, type ChannelType } from '../channels/bindings';
import { logger } from '../../config';
import type { BotContext } from '../types';
import { onlyPrivate } from '../middlewares/onlyPrivate';

type BindSource = 'private' | 'channel';

interface BindCommandConfig {
  command: string;
  type: ChannelType;
  successLabel: string;
}

const BIND_COMMANDS: BindCommandConfig[] = [
  {
    command: 'bind_verify_channel',
    type: 'verify',
    successLabel: 'Канал верификации',
  },
  {
    command: 'bind_drivers_channel',
    type: 'drivers',
    successLabel: 'Канал исполнителей',
  },
  {
    command: 'bind_stat_channel',
    type: 'stats',
    successLabel: 'Канал отчётов',
  },
];

const COMMAND_LOOKUP = new Map<string, BindCommandConfig>(
  BIND_COMMANDS.map((config) => [config.command.toLowerCase(), config]),
);

const isCommandEntity = (entity?: MessageEntity): entity is MessageEntity =>
  Boolean(entity && entity.type === 'bot_command' && entity.offset === 0);

const extractCommandArgs = (text: string, entity: MessageEntity): string[] => {
  const payload = text.slice(entity.offset + entity.length).trim();
  if (!payload) {
    return [];
  }

  return payload.split(/\s+/u).filter(Boolean);
};

const parseChatIdentifier = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!/^[-]?\d+$/u.test(trimmed)) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return parsed;
};

interface TargetChannel {
  id: number;
  title?: string;
  username?: string;
}

type ForwardingSource = {
  forward_from_chat?: { id: number; title?: string; username?: string; type?: string };
  reply_to_message?: ForwardingSource;
  sender_chat?: { id: number; title?: string; username?: string; type?: string };
};

const extractForwardedChannel = (
  message: BotContext['message'] | undefined,
): TargetChannel | undefined => {
  if (!message) {
    return undefined;
  }

  const source = message as ForwardingSource;
  const forwarded =
    source.forward_from_chat ??
    source.reply_to_message?.forward_from_chat ??
    source.sender_chat;

  if (!forwarded || forwarded.type !== 'channel') {
    return undefined;
  }

  return {
    id: forwarded.id,
    title: forwarded.title ?? undefined,
    username: forwarded.username ?? undefined,
  } satisfies TargetChannel;
};

interface MessageLike {
  text?: string;
  caption?: string;
  entities?: MessageEntity[];
  caption_entities?: MessageEntity[];
}

const toMessageLike = (value: unknown): MessageLike | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  return value as MessageLike;
};

const resolveTargetChannel = (
  ctx: BotContext,
  source: BindSource,
  explicitId?: string,
): TargetChannel | undefined => {
  if (source === 'channel' && ctx.channelPost) {
    const chat = ctx.channelPost.chat;
    if (chat.type !== 'channel') {
      return undefined;
    }

    return {
      id: chat.id,
      title: chat.title ?? undefined,
      username: chat.username ?? undefined,
    } satisfies TargetChannel;
  }

  const forwarded = extractForwardedChannel(ctx.message);
  if (forwarded) {
    return forwarded;
  }

  const parsed = parseChatIdentifier(explicitId);
  if (parsed !== undefined) {
    return { id: parsed };
  }

  return undefined;
};

const formatChannelReference = (target: TargetChannel): string => {
  if (target.username) {
    return `@${target.username}`;
  }

  if (target.title) {
    return `${target.title} (ID ${target.id})`;
  }

  return `ID ${target.id}`;
};

const sendUsageHint = async (ctx: BotContext, config: BindCommandConfig): Promise<void> => {
  await ctx.reply(
    [
      'Не удалось определить канал. ',
      'Отправьте команду внутри нужного канала или в личных сообщениях с ботом, ',
      'переслав сообщение из него или указав идентификатор: ',
      `/${config.command} -1001234567890.`,
    ].join(''),
  );
};

const processBinding = async (
  ctx: BotContext,
  text: string,
  commandEntity: MessageEntity,
  source: BindSource,
  config: BindCommandConfig,
): Promise<void> => {
  const [explicitId] = extractCommandArgs(text, commandEntity);

  const targetChannel = resolveTargetChannel(ctx, source, explicitId);
  if (!targetChannel) {
    await sendUsageHint(ctx, config);
    return;
  }

  try {
    await saveChannelBinding({ type: config.type, chatId: targetChannel.id });
  } catch (error) {
    logger.error(
      { err: error, command: config.command, channelId: targetChannel.id },
      'Failed to persist channel binding',
    );
    await ctx.reply('Не удалось сохранить привязку канала. Попробуйте позже.');
    return;
  }

  await ctx.reply(
    `Готово! ${config.successLabel} привязан к ${formatChannelReference(targetChannel)}.`,
  );
};

export const registerBindCommand = (bot: Telegraf<BotContext>): void => {
  for (const config of BIND_COMMANDS) {
    bot.command(config.command, onlyPrivate, async (ctx) => {
      const message = toMessageLike(ctx.message);
      if (!message) {
        return;
      }

      const text = message.text ?? message.caption;
      if (!text) {
        return;
      }

      const entity =
        message.entities?.find(isCommandEntity) ??
        message.caption_entities?.find(isCommandEntity);
      if (!entity) {
        return;
      }

      await processBinding(ctx, text, entity, 'private', config);
    });
  }

  bot.on('channel_post', async (ctx, next) => {
    const post = toMessageLike(ctx.channelPost);
    if (!post) {
      await next();
      return;
    }

    const text = post.text ?? post.caption;
    if (!text) {
      await next();
      return;
    }

    const entity =
      post.entities?.find(isCommandEntity) ??
      post.caption_entities?.find(isCommandEntity);
    if (!entity) {
      await next();
      return;
    }

    const command = text
      .slice(entity.offset, entity.offset + entity.length)
      .split('@')[0]
      .replace(/^\//u, '')
      .toLowerCase();

    const config = COMMAND_LOOKUP.get(command);
    if (!config) {
      await next();
      return;
    }

    await processBinding(ctx, text, entity, 'channel', config);
  });
};

