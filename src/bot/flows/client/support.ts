import { Telegraf } from 'telegraf';
import type { Message, MessageEntity } from 'telegraf/typings/core/types/typegram';

import { logger } from '../../../config';
import { pool } from '../../../db';
import { isClientChat, sendClientMenu } from '../../../ui/clientMenu';
import { forwardSupportMessage } from '../../services/support';
import type { BotContext } from '../../types';

const ensureSupportState = (ctx: BotContext) => {
  if (!ctx.session.support) {
    ctx.session.support = { status: 'idle' };
  }

  return ctx.session.support;
};

const buildSupportPromptText = (): string =>
  [
    '🆘 Связаться с поддержкой.',
    '',
    'Опишите проблему или задайте вопрос — мы передадим сообщение модератору.',
    'Пожалуйста, отправьте текст или медиа одним сообщением.',
    '',
    'Если захотите вернуться в меню без сообщения, используйте команды снизу или /start.',
  ].join('\n');

const buildSupportAcknowledgementText = (shortId?: string): string => {
  const lines = [
    '✅ Обращение отправлено модератору.',
    'Ожидайте ответ — мы напишем вам в этот чат.',
  ];

  if (shortId) {
    lines.splice(1, 0, `Номер обращения: ${shortId}.`);
  }

  return lines.join('\n');
};

const buildSupportUnavailableText = (): string =>
  [
    '⚠️ Не удалось передать обращение в поддержку.',
    'Попробуйте ещё раз позднее или воспользуйтесь альтернативными каналами связи.',
  ].join('\n');

const buildSupportRetryText = (): string =>
  [
    'Не удалось обработать сообщение для поддержки.',
    'Убедитесь, что отправляете текст, фото или видео одним сообщением, и попробуйте снова.',
  ].join('\n');

const fetchSupportThreadShortId = async (
  threadId: string,
): Promise<string | undefined> => {
  try {
    const result = await pool.query<{ short_id: string }>(
      `
        SELECT short_id
        FROM support_threads
        WHERE id = $1
      `,
      [threadId],
    );

    return result.rows[0]?.short_id ?? undefined;
  } catch (error) {
    logger.error({ err: error, threadId }, 'Failed to fetch short id for client support thread');
    return undefined;
  }
};

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

export const promptClientSupport = async (ctx: BotContext): Promise<void> => {
  const support = ensureSupportState(ctx);

  if (!isClientChat(ctx, ctx.auth?.user.role)) {
    await ctx.reply('Поддержка доступна только в личном чате с ботом.');
    return;
  }

  if (support.status !== 'awaiting_message') {
    support.status = 'awaiting_message';
    support.lastThreadId = undefined;
    support.lastThreadShortId = undefined;
  }

  await ctx.reply(buildSupportPromptText());
};

const handleSupportMessage = async (ctx: BotContext): Promise<boolean> => {
  const support = ensureSupportState(ctx);

  if (!isClientChat(ctx, ctx.auth?.user.role)) {
    return false;
  }

  if (ctx.chat?.type !== 'private') {
    return false;
  }

  if (support.status !== 'awaiting_message') {
    return false;
  }

  const message = ctx.message as Message | undefined;
  if (!message) {
    return false;
  }

  if (isBotCommandMessage(message)) {
    support.status = 'idle';
    return false;
  }

  const result = await forwardSupportMessage(ctx);

  if (result.status === 'missing_channel') {
    support.status = 'idle';
    support.lastThreadId = undefined;
    support.lastThreadShortId = undefined;

    await sendClientMenu(ctx, buildSupportUnavailableText());
    return true;
  }

  if (result.status === 'forwarded') {
    support.status = 'idle';
    support.lastThreadId = result.threadId;
    support.lastThreadShortId = undefined;

    if (result.threadId) {
      support.lastThreadShortId = await fetchSupportThreadShortId(result.threadId);
    }

    await sendClientMenu(ctx, buildSupportAcknowledgementText(support.lastThreadShortId));
    return true;
  }

  await ctx.reply(buildSupportRetryText());
  return true;
};

export const registerClientSupport = (bot: Telegraf<BotContext>): void => {
  bot.on('message', async (ctx, next) => {
    const handled = await handleSupportMessage(ctx);
    if (!handled && next) {
      await next();
    }
  });
};

export const __testing__ = {
  ensureSupportState,
  buildSupportPromptText,
  buildSupportAcknowledgementText,
  buildSupportUnavailableText,
  buildSupportRetryText,
  isBotCommandMessage,
  fetchSupportThreadShortId,
  handleSupportMessage,
};
