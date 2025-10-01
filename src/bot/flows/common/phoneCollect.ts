import { Markup, type MiddlewareFn } from 'telegraf';
import type { ReplyKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import { config, logger } from '../../../config';
import { pool } from '../../../db/client';
import { setUserBlockedStatus } from '../../../db/users';
import {
  reportPhoneVerified,
  reportUserRegistration,
  toUserIdentity,
} from '../../services/reports';
import { persistPhoneVerification } from '../../../db/phoneVerification';
import { enqueueUserPhoneUpdate } from '../../../infra/userPhoneQueue';
import { primeExecutorOrderAccessCache } from '../../services/executorAccess';
import type { BotContext } from '../../types';
import { ui } from '../../ui';

export const PHONE_HELP_BUTTON_LABEL = 'Помощь';
export const PHONE_STATUS_BUTTON_LABEL = 'Где я?';
export const PHONE_COLLECT_STEP_ID = 'common:phone:collect';

const PHONE_COLLECT_TITLE = 'Поделитесь номером телефона';
const PHONE_COLLECT_TEXT = [
  'Наш сервис использует ваш номер, чтобы подтверждать заказы и защищать аккаунт.',
  'Telegram передаёт контакт напрямую и шифрует его, а мы храним номер в зашифрованном виде и используем только для связи по заказам.',
  'Нажмите «Поделиться контактом», если нужна помощь — кнопка «Помощь» расскажет, что делать.',
].join('\n\n');

const PHONE_FOREIGN_CONTACT_TITLE = 'Номер не подошёл';
const PHONE_FOREIGN_CONTACT_TEXT = [
  'Не удалось принять контакт.',
  'Можно отправить только свой номер — Telegram прикрепит его автоматически.',
  'Нажмите «Поделиться контактом», чтобы попробовать ещё раз.',
].join('\n\n');

const PHONE_STEP_ACTIONS = ['📲 Поделиться контактом', PHONE_HELP_BUTTON_LABEL, PHONE_STATUS_BUTTON_LABEL];

const EXECUTOR_ACCESS_CACHE_TTL_SECONDS = config.bot.executorAccessCacheTtlSeconds; // Use configured TTL to survive extended outages.

const rememberEphemeralMessage = (ctx: BotContext, messageId?: number): void => {
  if (!messageId) {
    return;
  }

  ctx.session.ephemeralMessages.push(messageId);
};

export const buildPhoneCollectKeyboard = (): ReplyKeyboardMarkup => {
  const keyboard = Markup.keyboard([
    [Markup.button.contactRequest('📲 Поделиться контактом')],
    [Markup.button.text(PHONE_HELP_BUTTON_LABEL)],
    [Markup.button.text(PHONE_STATUS_BUTTON_LABEL)],
  ])
    .oneTime(true)
    .resize();

  return keyboard.reply_markup;
};

interface PhoneStepOverrides {
  title?: string;
  text?: string;
}

const buildPhoneStepPayload = (overrides?: PhoneStepOverrides) => ({
  step: {
    id: PHONE_COLLECT_STEP_ID,
    title: overrides?.title ?? PHONE_COLLECT_TITLE,
    text: overrides?.text ?? PHONE_COLLECT_TEXT,
    actions: PHONE_STEP_ACTIONS,
  },
});

const renderPhoneCollectStep = async (
  ctx: BotContext,
  overrides?: PhoneStepOverrides,
): Promise<void> => {
  const text = overrides?.text ?? PHONE_COLLECT_TEXT;
  const step = await ui.step(ctx, {
    id: PHONE_COLLECT_STEP_ID,
    text,
    keyboard: buildPhoneCollectKeyboard(),
    payload: buildPhoneStepPayload(overrides),
  });

  ctx.session.awaitingPhone = true;
  if (step?.sent) {
    rememberEphemeralMessage(ctx, step.messageId);
  }
};

const buildPhoneHelpText = (): string =>
  [
    'ℹ️ Подсказка по обмену номером:',
    '• Откройте этот чат на своём телефоне.',
    '• Нажмите «Поделиться контактом» — Telegram отправит ваш номер автоматически.',
    '',
    'Мы используем номер только для подтверждения заказов и связи с вами — его не увидят другие пользователи.',
    'Передача контакта проходит по защищённому каналу Telegram, а у нас номер хранится в зашифрованном виде.',
  ].join('\n');

const normalisePhone = (phone: string): string => {
  const trimmed = phone.trim();
  if (trimmed.startsWith('+')) {
    return trimmed;
  }

  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length === 0) {
    return trimmed;
  }

  return `+${digits}`;
};

const isBlockedByUserError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    error_code?: number;
    description?: string;
    response?: { error_code?: number; description?: string };
  };

  const errorCode = candidate.error_code ?? candidate.response?.error_code;
  if (errorCode !== 403) {
    return false;
  }

  const description = candidate.description ?? candidate.response?.description ?? '';
  return description.toLowerCase().includes('bot was blocked by the user');
};

export const askPhone = async (ctx: BotContext): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  try {
    await renderPhoneCollectStep(ctx);
  } catch (error) {
    if (!isBlockedByUserError(error)) {
      throw error;
    }

    const telegramId = ctx.from?.id ?? ctx.chat?.id;
    logger.info({ err: error, telegramId }, 'User blocked bot when requesting phone');

    if (ctx.auth?.user) {
      ctx.auth.user.isBlocked = true;
      if (ctx.auth.user.status !== 'banned' && ctx.auth.user.status !== 'suspended') {
        ctx.auth.user.status = 'suspended';
      }
    }

    if (telegramId) {
      try {
        await setUserBlockedStatus({ telegramId, isBlocked: true });
      } catch (dbError) {
        logger.error({ err: dbError, telegramId }, 'Failed to persist user blocked status');
      }
    }
  }
};

export const savePhone: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (ctx.chat?.type !== 'private') {
    await next();
    return;
  }

  const fromId = ctx.from?.id;
  if (!fromId) {
    await next();
    return;
  }

  const contact = (ctx.message as { contact?: { phone_number?: string; user_id?: number } } | undefined)
    ?.contact;
  if (!contact || !contact.phone_number) {
    await next();
    return;
  }

  if (contact.user_id !== undefined && contact.user_id !== fromId) {
    logger.warn({ fromId, contactUserId: contact.user_id }, 'Ignoring contact shared by another user');

    try {
      await renderPhoneCollectStep(ctx, {
        title: PHONE_FOREIGN_CONTACT_TITLE,
        text: PHONE_FOREIGN_CONTACT_TEXT,
      });
    } catch (error) {
      if (isBlockedByUserError(error)) {
        logger.debug(
          { err: error, telegramId: fromId },
          'User blocked bot while delivering foreign contact warning',
        );
      } else {
        logger.error(
          { err: error, telegramId: fromId },
          'Failed to deliver foreign contact warning',
        );
      }
    }
    return;
  }

  const phone = normalisePhone(contact.phone_number);
  const wasVerified = Boolean(ctx.auth?.user?.phoneVerified || ctx.session.user?.phoneVerified);

  try {
    await persistPhoneVerification({ telegramId: fromId, phone });
  } catch (error) {
    logger.error({ err: error, telegramId: fromId }, 'Failed to save verified phone number');

    try {
      await enqueueUserPhoneUpdate({ telegramId: fromId, phone });
    } catch (queueError) {
      logger.error(
        { err: queueError, telegramId: fromId },
        'Failed to enqueue verified phone number for retry',
      );
    }
  }

  ctx.session.awaitingPhone = false;
  ctx.session.phoneNumber = phone;
  const existingUser = ctx.session.user ?? { id: fromId };
  ctx.session.user = { ...existingUser, phoneVerified: true };

  if (ctx.auth?.user) {
    ctx.auth.user.phone = phone;
    ctx.auth.user.phoneVerified = true;
    if (ctx.auth.user.status === 'awaiting_phone' || ctx.auth.user.status === 'guest') {
      ctx.auth.user.status = 'onboarding';
    }
  }

  const executorAccessRecord = {
    phone,
    isBlocked: Boolean(ctx.auth?.user?.isBlocked),
  } as const;

  try {
    await primeExecutorOrderAccessCache(fromId, executorAccessRecord, {
      ttlSeconds: EXECUTOR_ACCESS_CACHE_TTL_SECONDS,
    });
  } catch (cacheError) {
    logger.warn(
      { err: cacheError, telegramId: fromId },
      'Failed to prime executor access cache after phone capture',
    );
  }

  if (!wasVerified) {
    const identity = ctx.auth?.user
      ? {
          telegramId: ctx.auth.user.telegramId,
          username: ctx.auth.user.username,
          firstName: ctx.auth.user.firstName,
          lastName: ctx.auth.user.lastName,
          phone,
        }
      : { ...toUserIdentity(ctx.from), phone };

    try {
      await reportUserRegistration(ctx.telegram, identity, phone, ctx.auth?.user?.role ?? 'unknown');
    } catch (error) {
      logger.error({ err: error, telegramId: fromId }, 'Failed to report user registration');
    }

    const city = ctx.auth?.user?.citySelected ?? ctx.session.city;
    try {
      await reportPhoneVerified(ctx.telegram, { user: identity, city });
    } catch (error) {
      logger.error({ err: error, telegramId: fromId }, 'Failed to report phone verification');
    }
  }

  (ctx.state as { phoneJustVerified?: boolean }).phoneJustVerified = !wasVerified;

  await next();
};

export const respondToPhoneHelp: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (ctx.chat?.type !== 'private') {
    await next();
    return;
  }

  if (!ctx.session.awaitingPhone) {
    await next();
    return;
  }

  const message = await ctx.reply(buildPhoneHelpText(), {
    reply_markup: buildPhoneCollectKeyboard(),
  });
  ctx.session.awaitingPhone = true;
  rememberEphemeralMessage(ctx, message?.message_id);
};

export const respondToPhoneStatus: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (ctx.chat?.type !== 'private') {
    await next();
    return;
  }

  if (!ctx.session.awaitingPhone) {
    await next();
    return;
  }

  await renderPhoneCollectStep(ctx);
};

export const ensurePhone: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (ctx.chat?.type !== 'private') {
    await next();
    return;
  }

  const fromId = ctx.from?.id;
  if (!fromId) {
    await next();
    return;
  }

  if (ctx.session.user?.phoneVerified || ctx.auth?.user?.phoneVerified) {
    await next();
    return;
  }

  try {
    const { rows } = await pool.query<{ phone_verified: boolean }>(
      'SELECT phone_verified FROM users WHERE tg_id = $1',
      [fromId],
    );

    if (rows[0]?.phone_verified) {
      const existingUser = ctx.session.user ?? { id: fromId };
      ctx.session.user = { ...existingUser, phoneVerified: true };
      if (ctx.auth?.user) {
        ctx.auth.user.phoneVerified = true;
      }
      await next();
      return;
    }
  } catch (error) {
    logger.error({ err: error, telegramId: fromId }, 'Failed to check phone verification');
  }

  await askPhone(ctx);
};
