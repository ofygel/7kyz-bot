import { Markup, Telegraf } from 'telegraf';
import type {
  Document,
  InlineKeyboardMarkup,
  Message,
  PhotoSize,
} from 'telegraf/typings/core/types/typegram';

import { config, logger } from '../../../config';
import type { BotContext, ExecutorRole } from '../../types';
import {
  EXECUTOR_MENU_ACTION,
  EXECUTOR_MENU_TEXT_LABELS,
  EXECUTOR_SUBSCRIPTION_ACTION,
  ensureExecutorState,
  isExecutorRoleVerified,
  showExecutorMenu,
} from './menu';
import { getExecutorRoleCopy } from '../../copy';
import { ui } from '../../ui';
import {
  SUBSCRIPTION_PERIOD_OPTIONS,
  findSubscriptionPeriodOption,
  formatSubscriptionAmount,
  type SubscriptionPeriodOption,
} from './subscriptionPlans';
import { createShortId } from '../../../utils/ids';
import { submitSubscriptionPaymentReview } from '../../moderation/paymentQueue';
import { failedPaymentsCounter } from '../../../metrics/business';
import { getChannelBinding } from '../../channels/bindings';
import {
  createTrialSubscription,
  TrialSubscriptionUnavailableError,
  type TrialSubscriptionErrorReason,
} from '../../../db/subscriptions';
import { resolveInviteLink, sendInviteLink } from './orders';
import {
  reportSubscriptionPaymentSubmitted,
  reportSubscriptionTrialActivated,
  type SubscriptionIdentity,
} from '../../services/reports';
import { getVerificationRoleGuidance } from './verification';

const SUBSCRIPTION_PERIOD_ACTION_PREFIX = 'executor:subscription:period';
const SUBSCRIPTION_VERIFICATION_REQUIRED_STEP_ID =
  'executor:subscription:verification-required';
const SUBSCRIPTION_CONFIRMATION_STEP_ID = 'executor:subscription:confirmation';
const SUBSCRIPTION_RECEIPT_ACCEPTED_STEP_ID = 'executor:subscription:receipt-accepted';
const SUBSCRIPTION_RECEIPT_FAILED_STEP_ID = 'executor:subscription:receipt-failed';
const SUBSCRIPTION_SELECT_PERIOD_REMINDER_STEP_ID = 'executor:subscription:select-period';
const SUBSCRIPTION_RECEIPT_REMINDER_STEP_ID = 'executor:subscription:receipt-reminder';
const SUBSCRIPTION_TRIAL_ACTION = 'executor:subscription:trial';
const SUBSCRIPTION_TRIAL_UNAVAILABLE_STEP_ID = 'executor:subscription:trial-unavailable';
const SUBSCRIPTION_TRIAL_ERROR_STEP_ID = 'executor:subscription:trial-error';

const EXECUTOR_JOBS_HOME_ACTION = 'executor:jobs:refresh';

const buildVerificationRequiredMessage = (role: ExecutorRole): string => {
  const guidance = getVerificationRoleGuidance(role);
  const prompt = guidance.nextStepsPrompt.replace(/^📸\s*/, '');
  const sanitizedPrompt = prompt.replace(/\.$/, '');
  return `Вы пока не прошли модерацию. ${sanitizedPrompt}, чтобы мы выдали доступ.`;
};

const formatKaspiDetails = (): string[] => [
  'Оплатите через Kaspi по реквизитам:',
  `Получатель: ${config.subscriptions.payment.kaspi.name}`,
  `Kaspi Gold: ${config.subscriptions.payment.kaspi.card}`,
  `Телефон: ${config.subscriptions.payment.kaspi.phone}`,
  'Комментарий: Подписка',
];

const buildPeriodKeyboard = (trialEnabled: boolean): InlineKeyboardMarkup => {
  const rows = SUBSCRIPTION_PERIOD_OPTIONS.map((option) => [
    Markup.button.callback(
      `${option.label} — ${formatSubscriptionAmount(option.amount, option.currency)}`,
      `${SUBSCRIPTION_PERIOD_ACTION_PREFIX}:${option.id}`,
    ),
  ]);

  if (trialEnabled) {
    rows.push([Markup.button.callback('Активировать пробный период', SUBSCRIPTION_TRIAL_ACTION)]);
  }

  return Markup.inlineKeyboard(rows).reply_markup;
};

const buildSelectionText = (
  roleCopy: ReturnType<typeof getExecutorRoleCopy>,
  { trialEnabled }: { trialEnabled: boolean },
): string => {
  const lines = [
    `${roleCopy.emoji} Подписка для ${roleCopy.genitive}`,
    '',
    'Выберите период подписки и оплатите подходящий вариант.',
    ...SUBSCRIPTION_PERIOD_OPTIONS.map(
      (option) => `• ${option.label} — ${formatSubscriptionAmount(option.amount, option.currency)}`,
    ),
    '',
    ...formatKaspiDetails(),
    '',
    'После оплаты отправьте чек в этот чат, мы проверим его и пришлём ссылку на канал.',
  ];

  if (trialEnabled) {
    lines.push(
      '',
      'Также можете активировать пробный период, чтобы сразу получить временный доступ.',
    );
  }

  return lines.join('\n');
};

const buildTrialUnavailableMessage = (
  reason: TrialSubscriptionErrorReason,
): string => {
  switch (reason) {
    case 'already_used':
      return 'Вы уже использовали пробный период. Выберите подходящий платный вариант, чтобы продолжить доступ.';
    case 'active':
    default:
      return 'Пробный период недоступен, потому что подписка уже активна. Если ссылка не работает, запросите новую через меню заказов или обратитесь в поддержку.';
  }
};

const notifyTrialUnavailable = async (
  ctx: BotContext,
  reason: TrialSubscriptionErrorReason,
): Promise<void> => {
  await ui.step(ctx, {
    id: SUBSCRIPTION_TRIAL_UNAVAILABLE_STEP_ID,
    text: buildTrialUnavailableMessage(reason),
    cleanup: true,
    homeAction: EXECUTOR_MENU_ACTION,
  });
};

const notifyTrialFailure = async (ctx: BotContext): Promise<void> => {
  await ui.step(ctx, {
    id: SUBSCRIPTION_TRIAL_ERROR_STEP_ID,
    text: 'Не удалось активировать пробный период. Попробуйте позже или обратитесь в поддержку через меню.',
    cleanup: true,
    homeAction: EXECUTOR_MENU_ACTION,
  });
};

const activateTrialSubscription = async (ctx: BotContext): Promise<void> => {
  const state = ensureExecutorState(ctx);
  const role = state.role;
  if (!role) {
    await ctx.answerCbQuery();
    return;
  }

  if (!config.features.trialEnabled) {
    await ctx.answerCbQuery('Пробный период недоступен.');
    return;
  }

  const isVerified = isExecutorRoleVerified(ctx, role);
  if (!isVerified) {
    state.subscription.status = 'idle';
    state.subscription.selectedPeriodId = undefined;
    state.subscription.pendingPaymentId = undefined;
    const verificationRequiredMessage = buildVerificationRequiredMessage(role);
    await ctx.answerCbQuery(verificationRequiredMessage);
    await ui.step(ctx, {
      id: SUBSCRIPTION_VERIFICATION_REQUIRED_STEP_ID,
      text: verificationRequiredMessage,
      cleanup: true,
      homeAction: EXECUTOR_MENU_ACTION,
    });
    return;
  }

  const binding = await getChannelBinding('drivers');
  if (!binding) {
    logger.error(
      { telegramId: ctx.auth.user.telegramId },
      'Drivers channel binding missing during trial activation',
    );
    await ctx.answerCbQuery('Канал временно недоступен.');
    await notifyTrialFailure(ctx);
    return;
  }

  await ctx.answerCbQuery('Активируем пробный период…');

  const subscriptionState = state.subscription;
  subscriptionState.status = 'idle';
  subscriptionState.selectedPeriodId = undefined;
  subscriptionState.pendingPaymentId = undefined;

  try {
    const trial = await createTrialSubscription({
      telegramId: ctx.auth.user.telegramId,
      username: ctx.auth.user.username ?? undefined,
      firstName: ctx.auth.user.firstName ?? undefined,
      lastName: ctx.auth.user.lastName ?? undefined,
      phone: ctx.auth.user.phone ?? ctx.session.phoneNumber ?? undefined,
      executorKind: role,
      chatId: binding.chatId,
      trialDays: config.subscriptions.trialDays,
      currency: config.subscriptions.prices.currency,
    });

    ctx.auth.executor.hasActiveSubscription = true;
    ctx.auth.user.subscriptionStatus = 'trial';
    ctx.auth.user.subscriptionExpiresAt = trial.expiresAt;
    subscriptionState.moderationChatId = undefined;
    subscriptionState.moderationMessageId = undefined;

    const subscriber: SubscriptionIdentity = {
      telegramId: ctx.auth.user.telegramId,
      username: ctx.auth.user.username ?? undefined,
      firstName: ctx.auth.user.firstName ?? undefined,
      lastName: ctx.auth.user.lastName ?? undefined,
      phone: ctx.auth.user.phone ?? ctx.session.phoneNumber ?? undefined,
      shortId: trial.subscriptionId ? String(trial.subscriptionId) : undefined,
      subscriptionStatus: 'trial',
      subscriptionExpiresAt: trial.expiresAt,
      trialExpiresAt: trial.expiresAt,
      hasActiveOrder: ctx.auth.user.hasActiveOrder,
    };

    await reportSubscriptionTrialActivated(ctx.telegram, subscriber, trial.expiresAt);

    const resolution = await resolveInviteLink(ctx, state);
    if (!resolution.link) {
      logger.error(
        { telegramId: ctx.auth.user.telegramId },
        'Failed to resolve invite link after trial activation',
      );
      await notifyTrialFailure(ctx);
      await showExecutorMenu(ctx, { skipAccessCheck: true });
      return;
    }

    subscriptionState.lastInviteLink = resolution.link;
    subscriptionState.lastIssuedAt = Date.now();

    logger.info(
      {
        telegramId: ctx.auth.user.telegramId,
        subscriptionId: trial.subscriptionId,
        expiresAt: trial.expiresAt.toISOString(),
      },
      'Trial subscription activated',
    );

    await sendInviteLink(ctx, state, resolution.link, resolution.expiresAt);
    await showExecutorMenu(ctx, { skipAccessCheck: true });
  } catch (error) {
    if (error instanceof TrialSubscriptionUnavailableError) {
      if (error.reason === 'active') {
        ctx.auth.executor.hasActiveSubscription = true;
        ctx.auth.user.subscriptionStatus = 'active';
      }

      await notifyTrialUnavailable(ctx, error.reason);
      await showExecutorMenu(ctx, { skipAccessCheck: true });
      return;
    }

    logger.error(
      { err: error, telegramId: ctx.auth.user.telegramId },
      'Failed to activate trial subscription',
    );
    await notifyTrialFailure(ctx);
    await showExecutorMenu(ctx, { skipAccessCheck: true });
  }
};

export interface StartExecutorSubscriptionOptions {
  skipVerificationCheck?: boolean;
  homeAction?: string;
}

export const startExecutorSubscription = async (
  ctx: BotContext,
  options: StartExecutorSubscriptionOptions = {},
): Promise<void> => {
  const state = ensureExecutorState(ctx);
  const role = state.role;
  if (!role) {
    return;
  }
  const copy = getExecutorRoleCopy(role);

  const isVerified = isExecutorRoleVerified(ctx, role);
  const homeAction =
    options.homeAction ?? (ctx.auth.user.hasActiveOrder ? EXECUTOR_JOBS_HOME_ACTION : EXECUTOR_MENU_ACTION);

  if (!options.skipVerificationCheck && !isVerified) {
    state.subscription.status = 'idle';
    state.subscription.selectedPeriodId = undefined;
    state.subscription.pendingPaymentId = undefined;
    const verificationRequiredMessage = buildVerificationRequiredMessage(role);
    await ui.step(ctx, {
      id: SUBSCRIPTION_VERIFICATION_REQUIRED_STEP_ID,
      text: verificationRequiredMessage,
      cleanup: true,
      homeAction,
    });
    return;
  }

  state.subscription.status = 'selectingPeriod';
  state.subscription.selectedPeriodId = undefined;
  state.subscription.pendingPaymentId = undefined;

  const trialEnabled = config.features.trialEnabled;
  const keyboard = buildPeriodKeyboard(trialEnabled);
  const text = buildSelectionText(copy, { trialEnabled });

  await ui.step(ctx, {
    id: 'executor:subscription:step',
    text,
    keyboard,
    homeAction,
  });
};

const buildPeriodConfirmationMessage = (
  period: SubscriptionPeriodOption,
  roleCopy: ReturnType<typeof getExecutorRoleCopy>,
): string => {
  const lines = [
    `Вы выбрали подписку на ${period.label} для ${roleCopy.genitive}.`,
    `Сумма к оплате: ${formatSubscriptionAmount(period.amount, period.currency)}.`,
    '',
    ...formatKaspiDetails(),
    '',
    'Отправьте чек об оплате в этот чат. После подтверждения модераторами мы пришлём ссылку на канал.',
  ];

  return lines.join('\n');
};

const handlePeriodSelection = async (
  ctx: BotContext,
  periodId: string,
): Promise<void> => {
  const period = findSubscriptionPeriodOption(periodId);
  if (!period) {
    await ctx.answerCbQuery('Неизвестный период подписки.');
    return;
  }

  const state = ensureExecutorState(ctx);
  const role = state.role;
  if (!role) {
    await ctx.answerCbQuery();
    return;
  }
  const isVerified = isExecutorRoleVerified(ctx, role);

  if (!isVerified) {
    state.subscription.status = 'idle';
    state.subscription.selectedPeriodId = undefined;
    state.subscription.pendingPaymentId = undefined;
    const verificationRequiredMessage = buildVerificationRequiredMessage(role);
    await ctx.answerCbQuery(verificationRequiredMessage);
    await ui.step(ctx, {
      id: SUBSCRIPTION_VERIFICATION_REQUIRED_STEP_ID,
      text: verificationRequiredMessage,
      cleanup: true,
      homeAction: EXECUTOR_MENU_ACTION,
    });
    return;
  }

  state.subscription.status = 'awaitingReceipt';
  state.subscription.selectedPeriodId = period.id;
  state.subscription.pendingPaymentId = undefined;

  await ctx.answerCbQuery(`Период: ${period.label}`);

  const copy = getExecutorRoleCopy(role);
  await ui.step(ctx, {
    id: SUBSCRIPTION_CONFIRMATION_STEP_ID,
    text: buildPeriodConfirmationMessage(period, copy),
    cleanup: true,
    homeAction: EXECUTOR_MENU_ACTION,
  });

  await showExecutorMenu(ctx, { skipAccessCheck: true });
};

interface ReceiptPayload {
  type: 'photo' | 'document';
  fileId: string;
}

const extractReceipt = (message: Message): ReceiptPayload | null => {
  if ('photo' in message && Array.isArray(message.photo) && message.photo.length > 0) {
    const photoSizes = message.photo as PhotoSize[];
    const bestPhoto = photoSizes[photoSizes.length - 1];
    return { type: 'photo', fileId: bestPhoto.file_id } satisfies ReceiptPayload;
  }

  if ('document' in message && message.document) {
    const document = message.document as Document;
    return { type: 'document', fileId: document.file_id } satisfies ReceiptPayload;
  }

  return null;
};

const notifyReceiptAccepted = async (ctx: BotContext): Promise<void> => {
  await ui.step(ctx, {
    id: SUBSCRIPTION_RECEIPT_ACCEPTED_STEP_ID,
    text: 'Спасибо! Мы передали чек модераторам. Ожидайте решения, и мы пришлём ссылку после одобрения.',
    cleanup: true,
    homeAction: EXECUTOR_MENU_ACTION,
  });
};

const notifyReceiptFailed = async (ctx: BotContext): Promise<void> => {
  await ui.step(ctx, {
    id: SUBSCRIPTION_RECEIPT_FAILED_STEP_ID,
    text: 'Не удалось отправить чек на проверку. Попробуйте позже.',
    cleanup: true,
    homeAction: EXECUTOR_MENU_ACTION,
  });
};

const buildPaymentId = (): string => `manual-${Date.now()}-${createShortId({ length: 6 })}`;

const handleReceiptUpload = async (ctx: BotContext): Promise<boolean> => {
  if (ctx.chat?.type !== 'private') {
    return false;
  }

  const message = ctx.message;
  if (!message) {
    return false;
  }

  const state = ensureExecutorState(ctx);
  const role = state.role;
  if (!role) {
    return false;
  }
  const subscription = state.subscription;

  if (subscription.status !== 'awaitingReceipt') {
    return false;
  }

  const period = findSubscriptionPeriodOption(subscription.selectedPeriodId);
  if (!period) {
    await ui.step(ctx, {
      id: SUBSCRIPTION_SELECT_PERIOD_REMINDER_STEP_ID,
      text: 'Выберите период подписки с помощью кнопок в меню.',
      cleanup: true,
      homeAction: EXECUTOR_MENU_ACTION,
    });
    return true;
  }

  const receipt = extractReceipt(message);
  if (!receipt) {
    await ui.step(ctx, {
      id: SUBSCRIPTION_RECEIPT_REMINDER_STEP_ID,
      text: 'Отправьте, пожалуйста, фотографию или файл с чеком.',
      cleanup: true,
      homeAction: EXECUTOR_MENU_ACTION,
    });
    return true;
  }

  const paymentId = buildPaymentId();
  subscription.pendingPaymentId = paymentId;
  const submittedAt = new Date();

  try {
    const result = await submitSubscriptionPaymentReview(ctx.telegram, {
      paymentId,
      period,
      submittedAt,
      executor: {
        role,
        telegramId: ctx.auth.user.telegramId,
        chatId: ctx.chat.id,
        username: ctx.auth.user.username ?? undefined,
        firstName: ctx.auth.user.firstName ?? undefined,
        lastName: ctx.auth.user.lastName ?? undefined,
        phone: ctx.auth.user.phone ?? ctx.session.phoneNumber ?? undefined,
      },
      receipt: {
        chatId: ctx.chat.id,
        messageId: message.message_id,
        fileId: receipt.fileId,
        type: receipt.type,
      },
    });

    if (result.status === 'missing_channel') {
      subscription.status = 'awaitingReceipt';
      subscription.pendingPaymentId = undefined;
      await notifyReceiptFailed(ctx);
      return true;
    }

    if (result.status === 'published') {
      const payer: SubscriptionIdentity = {
        telegramId: ctx.auth.user.telegramId,
        username: ctx.auth.user.username ?? undefined,
        firstName: ctx.auth.user.firstName ?? undefined,
        lastName: ctx.auth.user.lastName ?? undefined,
        phone: ctx.auth.user.phone ?? ctx.session.phoneNumber ?? undefined,
      };

      await reportSubscriptionPaymentSubmitted(
        ctx.telegram,
        payer,
        period.label,
        { value: period.amount, currency: period.currency },
        submittedAt,
      );
    }

    subscription.status = 'pendingModeration';
    subscription.moderationChatId = result.chatId;
    subscription.moderationMessageId = result.messageId;

    await notifyReceiptAccepted(ctx);
    await showExecutorMenu(ctx, { skipAccessCheck: true });
    return true;
  } catch (error) {
    failedPaymentsCounter.inc();
    logger.error(
      { err: error, paymentId, telegramId: ctx.auth.user.telegramId },
      'Failed to submit subscription payment for moderation',
    );
    subscription.status = 'awaitingReceipt';
    subscription.pendingPaymentId = undefined;
    await notifyReceiptFailed(ctx);
    return true;
  }
};

export const registerExecutorSubscription = (bot: Telegraf<BotContext>): void => {
  bot.action(EXECUTOR_SUBSCRIPTION_ACTION, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCbQuery('Доступно только в личных сообщениях.');
      return;
    }

    await ctx.answerCbQuery();
    await startExecutorSubscription(ctx);
  });

  bot.hears(EXECUTOR_MENU_TEXT_LABELS.subscription, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return;
    }

    ensureExecutorState(ctx);
    await startExecutorSubscription(ctx);
  });

  const periodPattern = new RegExp(`^${SUBSCRIPTION_PERIOD_ACTION_PREFIX}:(\\d+)$`);
  bot.action(periodPattern, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCbQuery('Доступно только в личных сообщениях.');
      return;
    }

    const match = ctx.match as RegExpMatchArray | undefined;
    const periodId = match?.[1];
    if (!periodId) {
      await ctx.answerCbQuery('Некорректный выбор.');
      return;
    }

    await handlePeriodSelection(ctx, periodId);
  });

  bot.action(SUBSCRIPTION_TRIAL_ACTION, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCbQuery('Доступно только в личных сообщениях.');
      return;
    }

    await activateTrialSubscription(ctx);
  });

  bot.on('photo', async (ctx, next) => {
    const handled = await handleReceiptUpload(ctx);
    if (!handled) {
      await next();
    }
  });

  bot.on('document', async (ctx, next) => {
    const handled = await handleReceiptUpload(ctx);
    if (!handled) {
      await next();
    }
  });
};
