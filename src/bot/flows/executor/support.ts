import { Telegraf } from 'telegraf';
import type { Message, MessageEntity } from 'telegraf/typings/core/types/typegram';

import { logger } from '../../../config';
import { pool } from '../../../db';
import { forwardSupportMessage } from '../../services/support';
import { ui } from '../../ui';
import type { BotContext } from '../../types';
import {
  EXECUTOR_MENU_ACTION,
  EXECUTOR_MENU_TEXT_LABELS,
  EXECUTOR_SUPPORT_ACTION,
} from './menu';

const SUPPORT_CONTACT_STEP_ID = 'executor:support:contact';

interface SupportThreadSummary {
  id: string;
  shortId?: string;
}

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
    'Опишите проблему текстом или отправьте фото/видео в ответ на это сообщение.',
    'Мы передадим обращение модераторам и вернёмся с ответом в этот чат.',
  ].join('\n');

const buildSupportAcknowledgementText = (shortId?: string): string => {
  const lines = [
    '✅ Обращение отправлено в поддержку.',
    'Ожидайте ответ модератора — мы напишем вам в этот чат.',
  ];

  if (shortId) {
    lines.splice(1, 0, `Номер обращения: ${shortId}.`);
  }

  return lines.join('\n');
};

const buildSupportOpenThreadText = (shortId?: string): string => {
  const lines = [
    'ℹ️ У вас уже есть открытое обращение в поддержку.',
    'Ожидайте ответа модератора. Мы сообщим о решении в этом чате.',
  ];

  if (shortId) {
    lines.splice(1, 0, `Номер обращения: ${shortId}.`);
  }

  return lines.join('\n');
};

const buildSupportUnavailableText = (): string =>
  [
    '⚠️ Не удалось передать обращение в поддержку.',
    'Попробуйте ещё раз позднее или свяжитесь с нами альтернативным способом.',
  ].join('\n');

const buildSupportRetryText = (): string =>
  [
    'Не удалось обработать сообщение для поддержки.',
    'Отправьте текст или медиафайл одним сообщением и попробуйте ещё раз.',
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
    logger.error(
      { err: error, threadId },
      'Failed to fetch short id for support thread',
    );
    return undefined;
  }
};

const findOpenSupportThread = async (
  chatId: number,
): Promise<SupportThreadSummary | null> => {
  try {
    const result = await pool.query<{ id: string; short_id: string }>(
      `
        SELECT id, short_id
        FROM support_threads
        WHERE user_chat_id = $1
          AND status = 'open'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [chatId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return { id: row.id, shortId: row.short_id } satisfies SupportThreadSummary;
  } catch (error) {
    logger.error(
      { err: error, chatId },
      'Failed to find open support thread for chat',
    );
    return null;
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

const handleSupportPrompt = async (
  ctx: BotContext,
  source: 'callback' | 'text',
): Promise<void> => {
  const support = ensureSupportState(ctx);

  if (ctx.chat?.type !== 'private') {
    if (source === 'callback') {
      await ctx.answerCbQuery('Доступно только в личных сообщениях.');
    }
    return;
  }

  const respond = async (text?: string): Promise<void> => {
    if (source === 'callback') {
      await ctx.answerCbQuery(text);
    } else if (text) {
      await ctx.reply(text);
    }
  };

  if (support.status === 'awaiting_message') {
    await respond('Отправьте сообщение с описанием проблемы.');
    await ui.step(ctx, {
      id: SUPPORT_CONTACT_STEP_ID,
      text: buildSupportPromptText(),
      homeAction: EXECUTOR_MENU_ACTION,
    });
    return;
  }

  const chatId = ctx.chat.id;
  const existing = await findOpenSupportThread(chatId);

  if (existing) {
    support.status = 'idle';
    support.lastThreadId = existing.id;
    support.lastThreadShortId = existing.shortId;

    await respond('Обращение уже на рассмотрении.');
    await ui.step(ctx, {
      id: SUPPORT_CONTACT_STEP_ID,
      text: buildSupportOpenThreadText(existing.shortId),
      homeAction: EXECUTOR_MENU_ACTION,
    });
    return;
  }

  support.status = 'awaiting_message';
  support.lastThreadId = undefined;
  support.lastThreadShortId = undefined;

  await respond('Опишите проблему одним сообщением.');
  await ui.step(ctx, {
    id: SUPPORT_CONTACT_STEP_ID,
    text: buildSupportPromptText(),
    homeAction: EXECUTOR_MENU_ACTION,
  });
};

const handleSupportMessage = async (
  ctx: BotContext,
): Promise<boolean> => {
  const support = ensureSupportState(ctx);

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

    await ui.step(ctx, {
      id: SUPPORT_CONTACT_STEP_ID,
      text: buildSupportUnavailableText(),
      homeAction: EXECUTOR_MENU_ACTION,
    });
    return true;
  }

  if (result.status === 'forwarded') {
    support.status = 'idle';
    support.lastThreadId = result.threadId;
    support.lastThreadShortId = undefined;

    if (result.threadId) {
      support.lastThreadShortId = await fetchSupportThreadShortId(result.threadId);
    }

    await ui.step(ctx, {
      id: SUPPORT_CONTACT_STEP_ID,
      text: buildSupportAcknowledgementText(support.lastThreadShortId),
      homeAction: EXECUTOR_MENU_ACTION,
    });
    return true;
  }

  await ui.step(ctx, {
    id: SUPPORT_CONTACT_STEP_ID,
    text: buildSupportRetryText(),
    homeAction: EXECUTOR_MENU_ACTION,
  });

  return true;
};

export const registerExecutorSupport = (bot: Telegraf<BotContext>): void => {
  bot.action(EXECUTOR_SUPPORT_ACTION, async (ctx) => {
    await handleSupportPrompt(ctx, 'callback');
  });

  bot.command('support', async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return;
    }

    await handleSupportPrompt(ctx, 'text');
  });

  bot.on('message', async (ctx, next) => {
    const handled = await handleSupportMessage(ctx);
    if (!handled && next) {
      await next();
    }
  });

  bot.hears(EXECUTOR_MENU_TEXT_LABELS.support, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return;
    }

    await handleSupportPrompt(ctx, 'text');
  });
};

export const __testing__ = {
  SUPPORT_CONTACT_STEP_ID,
  buildSupportPromptText,
  buildSupportAcknowledgementText,
  buildSupportOpenThreadText,
  buildSupportUnavailableText,
  buildSupportRetryText,
  handleSupportPrompt,
  handleSupportMessage,
  findOpenSupportThread,
  fetchSupportThreadShortId,
  ensureSupportState,
  isBotCommandMessage,
};
