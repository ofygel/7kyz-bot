import { Markup, Telegraf, Telegram } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import { config, logger } from '../../config';
import {
  reportVerificationApproved,
  reportVerificationRejected,
  type UserIdentity,
} from '../services/reports';

import type { BotContext } from '../types';
import {
  markVerificationApproved,
  markVerificationRejected,
  type VerificationApplicant,
  type VerificationRole,
} from '../../db/verifications';
import {
  createModerationQueue,
  type ModerationRejectionContext,
  type ModerationQueue,
  type ModerationQueueItemBase,
  type PublishModerationResult,
} from './queue';
import {
  loadSessionState,
  saveSessionState,
  withTx,
  type SessionKey,
  type SessionScope,
} from '../../db';
import {
  getChannelBinding,
  BIND_VERIFY_CHANNEL,
  ORDERS_CHANNEL,
} from '../channels/bindings';
import { getExecutorRoleCopy } from '../copy';
import { EXECUTOR_ORDERS_ACTION } from '../flows/executor/menu';
import {
  createTrialSubscription,
  TrialSubscriptionUnavailableError,
} from '../../db/subscriptions';

const DEFAULT_TITLE = '🛡️ Заявка на верификацию исполнителя';
const DEFAULT_REASONS = [
  'Документы нечитабельны',
  'Данные не совпадают',
  'Не подходит',
];
const DEFAULT_VERIFICATION_TRIAL_DAYS = 2;

const formatTrialDays = (days: number): string => {
  const absolute = Math.abs(days);
  const lastTwo = absolute % 100;
  if (lastTwo >= 11 && lastTwo <= 14) {
    return `${days} дней`;
  }

  const lastDigit = absolute % 10;
  if (lastDigit === 1) {
    return `${days} день`;
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return `${days} дня`;
  }

  return `${days} дней`;
};

const formatDateTime = (value?: Date | number | string): string | undefined => {
  if (!value) {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: config.timezone,
  }).format(date);
};

const buildFullName = (first?: string, last?: string): string | undefined => {
  const full = [first?.trim(), last?.trim()].filter(Boolean).join(' ').trim();
  return full || undefined;
};

const normaliseSummary = (value?: string | string[]): string[] => {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

export interface VerificationApplication extends ModerationQueueItemBase<VerificationApplication> {
  applicant: VerificationApplicant;
  role: VerificationRole;
  /**
   * Optional custom title for the moderation message.
   * When omitted, a default heading is used.
   */
  title?: string;
  /** Additional summary text shown after the applicant details. */
  summary?: string | string[];
  /** Any extra notes or comments appended to the end of the message. */
  notes?: string[];
  /** Number of photos attached to the application. */
  photoCount?: number;
  /** Timestamp when the application was submitted. */
  submittedAt?: Date | number | string;
  /** Notification sent to the applicant after approval. */
  approvalNotification?: {
    text: string;
    keyboard?: InlineKeyboardMarkup;
  };
  /** Session context used to reset the executor moderation state. */
  sessionContext?: {
    scope: SessionScope;
    scopeId: string;
    role: VerificationRole;
    applicationId: string;
  };
}

const buildVerificationMessage = (application: VerificationApplication): string => {
  const lines: string[] = [];
  lines.push(application.title?.trim() || DEFAULT_TITLE);
  lines.push('');
  lines.push(`ID заявки: ${application.id}`);
  lines.push(`Telegram ID: ${application.applicant.telegramId}`);

  if (application.applicant.username) {
    lines.push(`Username: @${application.applicant.username}`);
  }

  const fullName = buildFullName(application.applicant.firstName, application.applicant.lastName);
  if (fullName) {
    lines.push(`Имя: ${fullName}`);
  }

  if (application.applicant.phone) {
    lines.push(`Телефон: ${application.applicant.phone}`);
  }

  if (application.photoCount !== undefined) {
    lines.push(`Фотографии: ${application.photoCount}`);
  }

  const submittedAt = formatDateTime(application.submittedAt);
  if (submittedAt) {
    lines.push(`Отправлено: ${submittedAt}`);
  }

  const summaryLines = normaliseSummary(application.summary);
  if (summaryLines.length > 0) {
    lines.push('');
    lines.push(...summaryLines);
  }

  if (application.notes && application.notes.length > 0) {
    lines.push('');
    lines.push(...application.notes);
  }

  return lines.join('\n');
};

const normaliseReasonSuffix = (reason: string): string => {
  const trimmed = reason.trim();
  if (!trimmed) {
    return 'не указана.';
  }

  if (/[.!?]$/.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}.`;
};

const handleVerificationRejection = async (
  context: ModerationRejectionContext<VerificationApplication>,
): Promise<void> => {
  const { item, telegram, reason } = context;
  const applicantId = item.applicant.telegramId;
  if (!applicantId) {
    return;
  }

  const reasonLine = normaliseReasonSuffix(reason);
  const message = [
    '❌ Ваша заявка на верификацию отклонена.',
    `Причина: ${reasonLine}`,
    'Вы можете обновить данные и отправить новую заявку через меню бота.',
  ].join('\n');

  try {
    await telegram.sendMessage(applicantId, message);
  } catch (error) {
    logger.error(
      {
        err: error,
        applicationId: item.id,
        applicantId,
      },
      'Failed to notify applicant about verification rejection',
    );
  }
};

const buildSessionKeys = (
  context: VerificationApplication['sessionContext'],
): SessionKey[] => {
  if (!context) {
    return [];
  }

  const keys: SessionKey[] = [{ scope: context.scope, scopeId: context.scopeId }];
  if (context.scope === 'chat' || context.scope === 'user') {
    const alternate: SessionScope = context.scope === 'chat' ? 'user' : 'chat';
    keys.push({ scope: alternate, scopeId: context.scopeId });
  }

  return keys;
};

const resetVerificationSessionState = async (
  item: VerificationApplication,
  decidedAt: number,
): Promise<void> => {
  const context = item.sessionContext;
  if (!context) {
    return;
  }

  const keys = buildSessionKeys(context);
  if (keys.length === 0) {
    return;
  }

  const applicationId = context.applicationId ?? `${item.id}`;

  await withTx(async (client) => {
    for (const key of keys) {
      let state: any;
      try {
        state = await loadSessionState(client, key, { forUpdate: true });
      } catch (error) {
        logger.error(
          { err: error, queue: 'verify', scope: key.scope, scopeId: key.scopeId },
          'Failed to load session state while resetting verification moderation',
        );
        continue;
      }

      if (!state) {
        continue;
      }

      const verificationState = state.executor?.verification?.[context.role];
      if (!verificationState) {
        continue;
      }

      if (
        verificationState.moderation?.applicationId &&
        verificationState.moderation.applicationId !== applicationId
      ) {
        continue;
      }

      verificationState.status = 'idle';
      verificationState.moderation = undefined;
      verificationState.uploadedPhotos = [];
      verificationState.submittedAt = decidedAt;

      try {
        await saveSessionState(client, key, state);
      } catch (error) {
        logger.error(
          { err: error, queue: 'verify', scope: key.scope, scopeId: key.scopeId },
          'Failed to persist session state after verification decision',
        );
      }
    }
  });
};

const buildTrialApprovalKeyboard = (): InlineKeyboardMarkup =>
  Markup.inlineKeyboard([[Markup.button.callback('Заказы', EXECUTOR_ORDERS_ACTION)]]).reply_markup;

const buildFallbackApprovalNotification = (
  application: VerificationApplication,
): { text: string; keyboard: InlineKeyboardMarkup } => {
  const copy = getExecutorRoleCopy(application.role);
  const periodLabel = formatTrialDays(DEFAULT_VERIFICATION_TRIAL_DAYS);
  const text = [
    '✅ Документы подтверждены.',
    `Мы активировали для вас бесплатный доступ на ${periodLabel}.`,
    `Как только ссылка на канал ${copy.genitive} будет доступна, мы отправим её дополнительно.`,
    'Если потребуется помощь, напишите в поддержку.',
  ].join('\n');

  const keyboard = buildTrialApprovalKeyboard();

  return { text, keyboard };
};

interface VerificationTrialDependencies {
  getChannelBinding: typeof getChannelBinding;
  createTrialSubscription: typeof createTrialSubscription;
}

const defaultVerificationTrialDependencies: VerificationTrialDependencies = {
  getChannelBinding,
  createTrialSubscription,
};

const verificationTrialDependencies: VerificationTrialDependencies = {
  ...defaultVerificationTrialDependencies,
};

const activateVerificationTrial = async (
  application: VerificationApplication,
): Promise<{ text: string; keyboard?: InlineKeyboardMarkup } | null> => {
  const applicantId = application.applicant.telegramId;
  if (!applicantId) {
    return null;
  }

  const binding = await verificationTrialDependencies.getChannelBinding(ORDERS_CHANNEL);
  let inviteAvailable = true;

  if (!binding) {
    inviteAvailable = false;
    const fallbackChatId = config.subscriptions.payment.ordersChannelId;

    if (!fallbackChatId) {
      logger.warn(
        { applicationId: application.id, applicantId },
        'Drivers channel binding missing during verification trial activation',
      );
    } else {
      logger.warn(
        { applicationId: application.id, applicantId, fallbackChatId },
        'Drivers channel binding missing, using configured fallback chat id for verification trial',
      );
    }
  }

  try {
    const trial = await verificationTrialDependencies.createTrialSubscription({
      telegramId: applicantId,
      username: application.applicant.username ?? undefined,
      firstName: application.applicant.firstName ?? undefined,
      lastName: application.applicant.lastName ?? undefined,
      phone: application.applicant.phone ?? undefined,
      executorKind: application.role,
      chatId: binding?.chatId ?? config.subscriptions.payment.ordersChannelId,
      trialDays: DEFAULT_VERIFICATION_TRIAL_DAYS,
      currency: config.subscriptions.prices.currency,
    });

    logger.info(
      {
        applicationId: application.id,
        applicantId,
        subscriptionId: trial.subscriptionId,
        expiresAt: trial.expiresAt.toISOString(),
      },
      'Verification trial subscription activated during approval',
    );

    const copy = getExecutorRoleCopy(application.role);
    const periodLabel = formatTrialDays(DEFAULT_VERIFICATION_TRIAL_DAYS);
    const expiresLabel = formatDateTime(trial.expiresAt);
    const lines = [
      '✅ Документы подтверждены.',
      `Мы активировали для вас бесплатный доступ на ${periodLabel}.`,
    ];

    if (expiresLabel) {
      lines.push(`Доступ действует до ${expiresLabel}.`);
    }

    if (inviteAvailable && binding) {
      lines.push(`Нажмите кнопку ниже, чтобы получить ссылку на канал ${copy.genitive}.`);
    } else {
      lines.push(`Мы сообщим вам отдельно, когда ссылка на канал ${copy.genitive} будет готова.`);
    }
    lines.push('Если потребуется помощь, напишите в поддержку.');

    const keyboard = inviteAvailable && binding ? buildTrialApprovalKeyboard() : undefined;

    return { text: lines.join('\n'), keyboard };
  } catch (error) {
    if (error instanceof TrialSubscriptionUnavailableError) {
      logger.info(
        {
          applicationId: application.id,
          applicantId,
          reason: error.reason,
        },
        'Verification trial unavailable during approval',
      );
    } else {
      logger.error(
        { err: error, applicationId: application.id, applicantId },
        'Failed to activate verification trial during approval',
      );
    }

    return null;
  }
};

export const __testing = {
  activateVerificationTrial,
  setTrialDependencies: (
    overrides: Partial<VerificationTrialDependencies>,
  ): void => {
    verificationTrialDependencies.getChannelBinding =
      overrides.getChannelBinding ?? defaultVerificationTrialDependencies.getChannelBinding;

    verificationTrialDependencies.createTrialSubscription =
      overrides.createTrialSubscription ??
      defaultVerificationTrialDependencies.createTrialSubscription;
  },
};

export const notifyVerificationApproval = async (
  telegram: Telegram,
  application: VerificationApplication,
): Promise<void> => {
  const applicantId = application.applicant.telegramId;
  if (!applicantId) {
    return;
  }

  const fallback = buildFallbackApprovalNotification(application);
  const trialNotification = await activateVerificationTrial(application);

  let text: string;
  let keyboard: InlineKeyboardMarkup | undefined;

  if (trialNotification) {
    text = trialNotification.text;
    keyboard = trialNotification.keyboard;
  } else {
    const notification = application.approvalNotification;
    const customText = notification?.text?.trim();

    if (customText) {
      text = customText;
      keyboard = notification?.keyboard;
    } else {
      text = fallback.text;
      keyboard = fallback.keyboard;
    }
  }

  const replyMarkup = keyboard ?? fallback.keyboard;

  try {
    await telegram.sendMessage(applicantId, text, { reply_markup: replyMarkup });
  } catch (error) {
    logger.error(
      { err: error, applicationId: application.id, applicantId },
      'Failed to notify applicant about verification approval',
    );
  }
};

const attachVerificationCallbacks = (
  application: VerificationApplication,
): VerificationApplication => {
  const existingOnApprove = application.onApprove;
  const existingOnReject = application.onReject;

  application.onApprove = async (context) => {
    const { item, decidedAt, telegram } = context;

    try {
      await markVerificationApproved({
        applicant: item.applicant,
        role: item.role,
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          applicationId: item.id,
          applicantId: item.applicant.telegramId,
          role: item.role,
        },
        'Failed to mark verification as approved',
      );
    }

    try {
      await resetVerificationSessionState(item, decidedAt);
    } catch (error) {
      logger.error(
        {
          err: error,
          applicationId: item.id,
          applicantId: item.applicant.telegramId,
          role: item.role,
        },
        'Failed to reset verification session state after approval',
      );
    }

    await notifyVerificationApproval(telegram, item);

    const applicant: UserIdentity = {
      telegramId: item.applicant.telegramId,
      username: item.applicant.username,
      firstName: item.applicant.firstName,
      lastName: item.applicant.lastName,
      phone: item.applicant.phone,
    };

    await reportVerificationApproved(telegram, applicant, item.role, decidedAt);

    if (existingOnApprove) {
      try {
        await existingOnApprove(context);
      } catch (error) {
        logger.error(
          {
            err: error,
            applicationId: item.id,
            applicantId: item.applicant.telegramId,
          },
          'Verification approval callback failed',
        );
      }
    }
  };

  application.onReject = async (context) => {
    const { item, decidedAt } = context;

    try {
      await markVerificationRejected({
        applicant: item.applicant,
        role: item.role,
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          applicationId: item.id,
          applicantId: item.applicant.telegramId,
          role: item.role,
        },
        'Failed to mark verification as rejected',
      );
    }

    try {
      await resetVerificationSessionState(item, decidedAt);
    } catch (error) {
      logger.error(
        {
          err: error,
          applicationId: item.id,
          applicantId: item.applicant.telegramId,
          role: item.role,
        },
        'Failed to reset verification session state after rejection',
      );
    }

    await handleVerificationRejection(context);

    const applicant: UserIdentity = {
      telegramId: item.applicant.telegramId,
      username: item.applicant.username,
      firstName: item.applicant.firstName,
      lastName: item.applicant.lastName,
      phone: item.applicant.phone,
    };

    await reportVerificationRejected(
      context.telegram,
      applicant,
      item.role,
      decidedAt,
      context.reason,
    );

    if (existingOnReject) {
      try {
        await existingOnReject(context);
      } catch (error) {
        logger.error(
          {
            err: error,
            applicationId: item.id,
            applicantId: item.applicant.telegramId,
          },
          'Verification rejection callback failed',
        );
      }
    }
  };

  return application;
};

const reviveVerificationApplication = (payload: unknown): VerificationApplication | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const application = payload as VerificationApplication;
  return attachVerificationCallbacks(application);
};

const queue: ModerationQueue<VerificationApplication> = createModerationQueue<VerificationApplication>({
  type: 'verify',
  channelType: BIND_VERIFY_CHANNEL,
  defaultRejectionReasons: DEFAULT_REASONS,
  renderMessage: buildVerificationMessage,
  deserializeItem: reviveVerificationApplication,
});

export const publishVerificationApplication = async (
  telegram: Telegram,
  application: VerificationApplication,
): Promise<PublishModerationResult> => {
  const item = attachVerificationCallbacks({ ...application });
  return queue.publish(telegram, item);
};

export const registerVerificationModerationQueue = (
  bot: Telegraf<BotContext>,
): void => {
  queue.register(bot);
};

export const restoreVerificationModerationQueue = async (): Promise<void> => {
  await queue.restore();
};

export type { PublishModerationResult } from './queue';
