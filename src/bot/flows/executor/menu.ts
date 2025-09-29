import { Markup, Telegraf } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import { config, logger } from '../../../config';
import {
  EXECUTOR_ROLES,
  EXECUTOR_VERIFICATION_PHOTO_COUNT,
  type AuthExecutorState,
  type AuthUser,
  type BotContext,
  type ExecutorFlowState,
  type ExecutorRole,
  type ExecutorSubscriptionState,
  type ExecutorVerificationRoleState,
} from '../../types';
import { ui } from '../../ui';
import { startExecutorSubscription } from './subscription';
import { getExecutorRoleCopy } from '../../copy';
import { findSubscriptionPeriodOption } from './subscriptionPlans';
import {
  VERIFICATION_ALBUM_HINT,
  getVerificationRoleGuidance,
  startExecutorVerification,
} from './verification';
import { CITY_LABEL } from '../../../domain/cities';
import { CITY_ACTION_PATTERN, askCity, ensureCitySelected } from '../common/citySelect';
import { showMenu } from '../client/menu';
import {
  PROFILE_BUTTON_LABEL,
  renderProfileCard,
  renderProfileCardFromAction,
} from '../common/profileCard';

export const EXECUTOR_VERIFICATION_ACTION = 'executor:verification:start';
export const EXECUTOR_SUBSCRIPTION_ACTION = 'executor:subscription:link';
export const EXECUTOR_ORDERS_ACTION = 'executor:orders:link';
export const EXECUTOR_SUPPORT_ACTION = 'support:contact';
export const EXECUTOR_MENU_ACTION = 'executor:menu:refresh';
const EXECUTOR_MENU_STEP_ID = 'executor:menu:card:v2';
export const EXECUTOR_MENU_CITY_ACTION = 'executorMenu';
const EXECUTOR_MENU_CITY_SELECT_ACTION = 'executor:menu:city';
const EXECUTOR_PROFILE_ACTION = 'executor:menu:profile';

const buildExecutorProfileOptions = () => ({
  backAction: EXECUTOR_MENU_ACTION,
  homeAction: EXECUTOR_MENU_ACTION,
  changeCityAction: EXECUTOR_MENU_CITY_SELECT_ACTION,
  subscriptionAction: EXECUTOR_SUBSCRIPTION_ACTION,
  supportAction: EXECUTOR_SUPPORT_ACTION,
});

export const EXECUTOR_MENU_TEXT_LABELS = {
  documents: '📸 Документы',
  subscription: '📨 Подписка/Ссылка',
  orders: '🧾 Заказы',
  support: '🆘 Поддержка',
  refresh: '🔄 Меню',
} as const;

export const EXECUTOR_MENU_TEXT_COMMANDS = Object.values(
  EXECUTOR_MENU_TEXT_LABELS,
) as readonly string[];

export const isExecutorMenuTextCommand = (value: string): boolean =>
  EXECUTOR_MENU_TEXT_COMMANDS.includes(value);

const ensurePositiveRequirement = (_value?: number): number => EXECUTOR_VERIFICATION_PHOTO_COUNT;

const cloneUploadedPhotos = (
  photos?: ExecutorVerificationRoleState['uploadedPhotos'],
): ExecutorVerificationRoleState['uploadedPhotos'] => {
  if (!Array.isArray(photos) || photos.length === 0) {
    return [];
  }

  return photos.map((photo) => ({ ...photo }));
};

const cloneProcessedMediaGroups = (
  groups?: ExecutorVerificationRoleState['processedMediaGroups'],
): ExecutorVerificationRoleState['processedMediaGroups'] => {
  if (!groups || typeof groups !== 'object') {
    return {};
  }

  const clone: ExecutorVerificationRoleState['processedMediaGroups'] = {};
  for (const [key, value] of Object.entries(groups)) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    const progressNotified = Boolean((value as { progressNotified?: unknown }).progressNotified);
    const sourceIds = (value as { photoUniqueIds?: unknown }).photoUniqueIds;
    const photoUniqueIds = Array.isArray(sourceIds)
      ? sourceIds.filter((id): id is string => typeof id === 'string')
      : [];

    clone[key] = {
      photoUniqueIds: [...photoUniqueIds],
      progressNotified,
    };
  }

  return clone;
};

const cloneModerationState = (
  moderation?: ExecutorVerificationRoleState['moderation'],
): ExecutorVerificationRoleState['moderation'] => {
  if (!moderation) {
    return undefined;
  }

  return { ...moderation };
};

const createRoleVerificationState = (): ExecutorVerificationRoleState => ({
  status: 'idle',
  requiredPhotos: EXECUTOR_VERIFICATION_PHOTO_COUNT,
  uploadedPhotos: [],
  submittedAt: undefined,
  moderation: undefined,
  lastReminderAt: undefined,
  processedMediaGroups: {},
});

const createSubscriptionState = (): ExecutorSubscriptionState => ({
  status: 'idle',
  selectedPeriodId: undefined,
  pendingPaymentId: undefined,
  moderationChatId: undefined,
  moderationMessageId: undefined,
  lastInviteLink: undefined,
  lastIssuedAt: undefined,
});

const normaliseRoleVerificationState = (
  value?: Partial<ExecutorVerificationRoleState>,
): ExecutorVerificationRoleState => ({
  status: value?.status ?? 'idle',
  requiredPhotos: ensurePositiveRequirement(value?.requiredPhotos),
  uploadedPhotos: cloneUploadedPhotos(value?.uploadedPhotos),
  submittedAt: value?.submittedAt,
  moderation: cloneModerationState(value?.moderation),
  lastReminderAt: typeof value?.lastReminderAt === 'number' ? value.lastReminderAt : undefined,
  processedMediaGroups: cloneProcessedMediaGroups(value?.processedMediaGroups),
});

const createDefaultVerificationState = () => {
  const verification = {} as ExecutorFlowState['verification'];
  for (const role of EXECUTOR_ROLES) {
    verification[role] = createRoleVerificationState();
  }
  return verification;
};

const hasRoleEntries = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return EXECUTOR_ROLES.some((role) => role in candidate);
};

const normaliseVerificationState = (
  value: ExecutorFlowState['verification'] | ExecutorVerificationRoleState | undefined,
): ExecutorFlowState['verification'] => {
  const verification = createDefaultVerificationState();

  if (!value) {
    return verification;
  }

  if (hasRoleEntries(value)) {
    const map = value as Partial<Record<string, Partial<ExecutorVerificationRoleState>>>;
    for (const role of EXECUTOR_ROLES) {
      const roleState = map[role] ?? verification[role];
      verification[role] = normaliseRoleVerificationState(roleState);
    }
    return verification;
  }

  const fallback = normaliseRoleVerificationState(value as Partial<ExecutorVerificationRoleState>);
  for (const role of EXECUTOR_ROLES) {
    verification[role] = {
      ...fallback,
      uploadedPhotos: cloneUploadedPhotos(fallback.uploadedPhotos),
      processedMediaGroups: cloneProcessedMediaGroups(fallback.processedMediaGroups),
    };
  }

  return verification;
};

const normaliseReminderTimestamp = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
};

const normaliseSubscriptionState = (
  value: Partial<ExecutorSubscriptionState> | undefined,
): ExecutorSubscriptionState => ({
  status: value?.status ?? 'idle',
  selectedPeriodId: value?.selectedPeriodId,
  pendingPaymentId: value?.pendingPaymentId,
  moderationChatId: value?.moderationChatId,
  moderationMessageId: value?.moderationMessageId,
  lastInviteLink: value?.lastInviteLink,
  lastIssuedAt: value?.lastIssuedAt,
  lastReminderAt: normaliseReminderTimestamp(value?.lastReminderAt),
});

const isExecutorKind = (value: unknown): value is ExecutorRole =>
  typeof value === 'string' && EXECUTOR_ROLES.includes(value as ExecutorRole);

const getSessionExecutorRole = (ctx: BotContext): ExecutorRole | undefined => {
  const sessionRole = ctx.session.executor?.role;
  if (isExecutorKind(sessionRole)) {
    return sessionRole;
  }

  return undefined;
};

const getCachedExecutorRole = (ctx: BotContext): ExecutorRole | undefined => {
  const snapshotKind = ctx.session.authSnapshot?.executorKind;
  if (isExecutorKind(snapshotKind)) {
    return snapshotKind;
  }

  return getSessionExecutorRole(ctx);
};

export const userLooksLikeExecutor = (ctx: BotContext): boolean => {
  const authRole = ctx.auth.user.role;
  if (
    (authRole === 'executor' || authRole === 'moderator')
    && isExecutorKind(ctx.auth.user.executorKind)
  ) {
    return true;
  }

  if (ctx.session.isAuthenticated === false && authRole === 'guest') {
    const sessionRole = getSessionExecutorRole(ctx);
    return isExecutorKind(sessionRole);
  }

  return false;
};

const deriveAuthExecutorRole = (ctx: BotContext): ExecutorRole | undefined => {
  const authRole = ctx.auth.user.role;
  if (
    (authRole === 'executor' || authRole === 'moderator')
    && isExecutorKind(ctx.auth.user.executorKind)
  ) {
    return ctx.auth.user.executorKind;
  }

  if (ctx.session.isAuthenticated === false && authRole === 'guest') {
    const cachedRole = getCachedExecutorRole(ctx);
    if (isExecutorKind(cachedRole)) {
      return cachedRole;
    }
  }

  return undefined;
};

export const requireExecutorRole = (state: ExecutorFlowState): ExecutorRole => {
  const role = state.role;
  if (role && EXECUTOR_ROLES.includes(role)) {
    return role;
  }

  throw new Error('Executor role is not set in session state');
};

export const ensureExecutorState = (ctx: BotContext): ExecutorFlowState => {
  const derivedRole = deriveAuthExecutorRole(ctx);

  if (!ctx.session.executor) {
    ctx.session.executor = {
      role: derivedRole,
      verification: createDefaultVerificationState(),
      subscription: createSubscriptionState(),
      jobs: { stage: 'idle' },
      awaitingRoleSelection: derivedRole === undefined,
      roleSelectionStage: derivedRole === undefined ? 'role' : undefined,
    } satisfies ExecutorFlowState;
  } else {
    const state = ctx.session.executor;
    const hasActiveRoleSelectionStage = state.roleSelectionStage !== undefined;
    if (hasActiveRoleSelectionStage && state.awaitingRoleSelection !== true) {
      state.awaitingRoleSelection = true;
    }

    const awaitingSelection = state.awaitingRoleSelection === true;

    if (derivedRole !== undefined) {
      if (!awaitingSelection) {
        state.role = derivedRole;
        state.awaitingRoleSelection = false;
        state.roleSelectionStage = undefined;
      } else if (!state.role) {
        state.role = derivedRole;
      }
    } else if (ctx.session.isAuthenticated === false && ctx.auth.user.role === 'guest') {
      // Preserve the existing executor role when auth falls back to the guest context.
    } else {
      state.role = undefined;
      if (!awaitingSelection) {
        state.awaitingRoleSelection = true;
      }
      if (state.roleSelectionStage === undefined) {
        state.roleSelectionStage = 'role';
      }
    }
    state.verification = normaliseVerificationState(state.verification);
    state.subscription = normaliseSubscriptionState(state.subscription);

    const subscription = state.subscription;
    if (ctx.auth.executor.hasActiveSubscription) {
      const preserveSubscriptionFlow =
        subscription.status === 'selectingPeriod' ||
        subscription.status === 'awaitingReceipt' ||
        subscription.status === 'pendingModeration';

      if (!preserveSubscriptionFlow) {
        if (subscription.status !== 'idle') {
          subscription.status = 'idle';
        }

        subscription.selectedPeriodId = undefined;
        subscription.pendingPaymentId = undefined;
      }
    } else {
      subscription.lastInviteLink = undefined;
      subscription.lastIssuedAt = undefined;
    }

    if (!state.jobs || typeof state.jobs !== 'object') {
      state.jobs = { stage: 'idle' };
    } else {
      const allowedStages: ExecutorFlowState['jobs']['stage'][] = [
        'idle',
        'feed',
        'confirm',
        'inProgress',
        'complete',
      ];
      if (!allowedStages.includes(state.jobs.stage)) {
        state.jobs.stage = 'idle';
      }
      if (typeof state.jobs.activeOrderId !== 'number' || !Number.isFinite(state.jobs.activeOrderId)) {
        state.jobs.activeOrderId = undefined;
      }
      if (typeof state.jobs.pendingOrderId !== 'number' || !Number.isFinite(state.jobs.pendingOrderId)) {
        state.jobs.pendingOrderId = undefined;
      }
      if (
        typeof state.jobs.lastViewedAt !== 'number' ||
        !Number.isFinite(state.jobs.lastViewedAt)
      ) {
        state.jobs.lastViewedAt = undefined;
      }
    }
  }

  return ctx.session.executor;
};

export const resetVerificationState = (state: ExecutorFlowState): void => {
  const role = state.role;
  if (!role || !EXECUTOR_ROLES.includes(role)) {
    return;
  }
  const current = state.verification[role];
  state.verification[role] = {
    ...createRoleVerificationState(),
    requiredPhotos: ensurePositiveRequirement(current?.requiredPhotos),
    moderation: undefined,
  };
};

const buildMenuKeyboard = (
  state: ExecutorFlowState,
  access: ExecutorAccessStatus,
): InlineKeyboardMarkup => {
  if (access.isVerified && access.hasActiveSubscription) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('Заказы', EXECUTOR_ORDERS_ACTION)],
      [Markup.button.callback(PROFILE_BUTTON_LABEL, EXECUTOR_PROFILE_ACTION)],
      [Markup.button.callback('Связаться с поддержкой', EXECUTOR_SUPPORT_ACTION)],
    ]).reply_markup;
  }

  if (!access.isVerified) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📨 Получить ссылку на канал', EXECUTOR_SUBSCRIPTION_ACTION)],
      [Markup.button.callback(PROFILE_BUTTON_LABEL, EXECUTOR_PROFILE_ACTION)],
      [Markup.button.callback('🔄 Обновить меню', EXECUTOR_MENU_ACTION)],
    ]).reply_markup;
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback('📨 Получить ссылку на канал', EXECUTOR_SUBSCRIPTION_ACTION)],
    [Markup.button.callback(PROFILE_BUTTON_LABEL, EXECUTOR_PROFILE_ACTION)],
    [Markup.button.callback('🔄 Обновить меню', EXECUTOR_MENU_ACTION)],
  ]).reply_markup;
};

const formatTimestamp = (timestamp: number): string => {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: config.timezone,
  }).format(new Date(timestamp));
};

export interface ExecutorAccessStatus {
  isVerified: boolean;
  hasActiveSubscription: boolean;
}

const hasRoleVerificationFlags = (verifiedRoles: AuthExecutorState['verifiedRoles']): boolean =>
  EXECUTOR_ROLES.some((role) => Boolean(verifiedRoles[role]));

export const isExecutorRoleVerified = (ctx: BotContext, role: ExecutorRole): boolean => {
  const verifiedRoles = ctx.auth.executor.verifiedRoles;

  if (Boolean(verifiedRoles[role])) {
    return true;
  }

  if (!hasRoleVerificationFlags(verifiedRoles)) {
    return ctx.auth.executor.isVerified;
  }

  return false;
};

const determineExecutorAccessStatus = (
  ctx: BotContext,
  state: ExecutorFlowState,
): ExecutorAccessStatus => {
  const role = requireExecutorRole(state);
  const isVerified = isExecutorRoleVerified(ctx, role);

  return {
    isVerified,
    hasActiveSubscription: ctx.auth.executor.hasActiveSubscription,
  } satisfies ExecutorAccessStatus;
};

export const getExecutorAccessStatus = (
  ctx: BotContext,
  state: ExecutorFlowState,
): ExecutorAccessStatus => determineExecutorAccessStatus(ctx, state);

const shouldRedirectToVerification = (
  state: ExecutorFlowState,
  access: ExecutorAccessStatus,
): boolean => {
  if (access.isVerified) {
    return false;
  }

  const role = requireExecutorRole(state);
  const verification = state.verification[role];
  return verification.status === 'idle';
};

const shouldRedirectToSubscription = (
  state: ExecutorFlowState,
  access: ExecutorAccessStatus,
): boolean => {
  if (!access.isVerified || access.hasActiveSubscription) {
    return false;
  }

  return state.subscription.status === 'idle';
};

export interface ShowExecutorMenuOptions {
  skipAccessCheck?: boolean;
}

const buildVerificationSection = (
  state: ExecutorFlowState,
  access: ExecutorAccessStatus,
): string[] => {
  const role = requireExecutorRole(state);
  const copy = getExecutorRoleCopy(role);
  const guidance = getVerificationRoleGuidance(role);

  if (access.isVerified) {
    return [
      'Статус проверки: подтверждена.',
      `Документы ${copy.genitive} подтверждены. Мы активировали бесплатный доступ на 2 дня сразу после одобрения.`,
      'Оформите подписку, чтобы сохранить доступ после пробного периода — используйте кнопку «📨 Получить ссылку на канал».',
    ];
  }

  const verification = state.verification[role];
  const uploaded = verification.uploadedPhotos.length;
  const required = ensurePositiveRequirement(verification.requiredPhotos);

  const statusLabel = {
    idle: 'не начата',
    collecting: 'ожидаем фотографии',
    submitted: 'на проверке',
  }[verification.status];

  const instructions = (() => {
    switch (verification.status) {
      case 'idle':
        return `${guidance.idlePrompt} ${VERIFICATION_ALBUM_HINT} Если нужны примеры, нажмите «Что подходит?» в карточке проверки.`;
      case 'collecting':
        return `${guidance.collectingPrompt} ${VERIFICATION_ALBUM_HINT} Не уверены? Откройте «Что подходит?» или воспользуйтесь кнопками «Назад/Где я?» и «Помощь».`;
      case 'submitted':
        return 'Мы передали документы модераторам. После одобрения выдадим доступ автоматически.';
      default:
        return undefined;
    }
  })();

  const lines = [
    `Статус проверки: ${statusLabel}.`,
    `Фотографии: ${uploaded}/${required}.`,
  ];

  if (instructions) {
    lines.push(instructions);
  }

  return lines;
};

const buildSubscriptionSection = (
  state: ExecutorFlowState,
  access: ExecutorAccessStatus,
): string[] => {
  const { subscription } = state;
  const role = requireExecutorRole(state);
  const copy = getExecutorRoleCopy(role);
  const channelLabel = `канал ${copy.pluralGenitive}`;

  if (!access.isVerified) {
    return [
      `Ссылка на ${channelLabel} станет доступна после отправки документов. После подтверждения мы автоматически откроем бесплатный доступ на 2 дня и пришлём ссылку.`,
    ];
  }

  if (subscription.status === 'awaitingReceipt' && subscription.selectedPeriodId) {
    const period = findSubscriptionPeriodOption(subscription.selectedPeriodId);
    const label = period?.label ?? `${subscription.selectedPeriodId} дней`;
    return [
      `Выбран период подписки: ${label}.`,
      'Оплатите выбранный период и отправьте чек в этот чат для проверки.',
    ];
  }

  if (subscription.status === 'pendingModeration') {
    return ['Мы проверяем ваш чек об оплате. Ожидайте решения модератора.'];
  }

  if (access.hasActiveSubscription) {
    if (subscription.lastInviteLink) {
      const issued = subscription.lastIssuedAt
        ? ` (выдана ${formatTimestamp(subscription.lastIssuedAt)})`
        : '';
      return [
        `Ссылка на канал уже выдана${issued}. При необходимости запросите новую с помощью кнопки «Заказы» ниже.`,
      ];
    }

    return [
      `Подписка активна. Если нужна новая ссылка на ${channelLabel}, используйте кнопку «Заказы» ниже.`,
    ];
  }

  return [
    `Получите ссылку на ${channelLabel}: после подтверждения документов мы выдадим 2-дневный пробный доступ, затем выберите подписку через кнопку ниже, чтобы остаться в канале.`,
  ];
};

const buildNextStepsSection = (
  state: ExecutorFlowState,
  access: ExecutorAccessStatus,
): string[] => {
  const role = requireExecutorRole(state);
  const copy = getExecutorRoleCopy(role);
  const guidance = getVerificationRoleGuidance(role);

  if (!access.isVerified) {
    return [
      `${guidance.nextStepsPrompt} ${VERIFICATION_ALBUM_HINT} Сомневаетесь? Нажмите «Что подходит?» в карточке проверки.`,
      'Дождитесь решения модератора — уведомление придёт в этот чат.',
      'После одобрения автоматически активируется 2-дневный бесплатный доступ, затем оформите подписку через «📨 Получить ссылку на канал».',
    ];
  }

  if (!access.hasActiveSubscription) {
    if (state.subscription.status === 'awaitingReceipt') {
      return [
        'Оплатите выбранный период подписки по реквизитам Kaspi.',
        'Пришлите чек сюда, чтобы модератор подтвердил оплату и выдал ссылку.',
      ];
    }

    if (state.subscription.status === 'pendingModeration') {
      return [
        'Мы проверяем ваш чек. Как только модератор подтвердит оплату, вы получите ссылку.',
      ];
    }

    return [
      'Откройте «📨 Получить ссылку на канал» и выберите период подписки.',
      'Оплатите подписку и отправьте чек в этот чат — модератор выдаст ссылку.',
      `После подтверждения ссылка на канал ${copy.pluralGenitive} появится в меню «Заказы».`,
    ];
  }

  return [
    'Нажмите «Заказы», чтобы получить актуальную ссылку и смотреть задания.',
    'Если возникнут вопросы — используйте кнопку «🆘 Поддержка».',
  ];
};

const buildMenuText = (
  state: ExecutorFlowState,
  access: ExecutorAccessStatus,
  cityLabel: string,
  user: AuthUser,
): string => {
  const role = requireExecutorRole(state);
  const copy = getExecutorRoleCopy(role);

  const statusLines: string[] = [];
  if (user.trialExpiresAt && Number.isFinite(user.trialExpiresAt.getTime())) {
    const msLeft = user.trialExpiresAt.getTime() - Date.now();
    if (msLeft > 0) {
      const daysLeft = Math.max(1, Math.ceil(msLeft / 86_400_000));
      statusLines.push(
        `🧪 Пробный до ${user.trialExpiresAt.toLocaleDateString('ru-RU')} (осталось ${daysLeft} дн.)`,
      );
    }
  }

  const verification = state.verification[role];
  const uploadedPhotos = verification.uploadedPhotos.length;
  const requiredPhotos = ensurePositiveRequirement(verification.requiredPhotos);
  const verificationStatusLabel =
    verification.status === 'submitted'
      ? 'проверка'
      : verification.status === 'collecting'
        ? 'ожидаем'
        : 'не начаты';
  statusLines.push(`🛡️ Документы: ${verificationStatusLabel} ${uploadedPhotos}/${requiredPhotos}`);

  const formatExpiry = (date?: Date): string | null => {
    if (!date || Number.isNaN(date.getTime())) {
      return null;
    }

    const formatted = date.toLocaleDateString('ru-RU');
    const msLeft = date.getTime() - Date.now();
    if (msLeft <= 0) {
      return formatted;
    }

    const daysLeft = Math.max(1, Math.ceil(msLeft / 86_400_000));
    return `${formatted} (осталось ${daysLeft} дн.)`;
  };

  const subscriptionLine = (() => {
    if (state.subscription.status === 'awaitingReceipt') {
      return '📨 Подписка: ждём чек';
    }

    if (state.subscription.status === 'pendingModeration') {
      return '📨 Подписка: модерация платежа';
    }

    switch (user.subscriptionStatus) {
      case 'trial': {
        const expiry = formatExpiry(user.subscriptionExpiresAt);
        return expiry ? `📨 Подписка: пробный доступ до ${expiry}` : '📨 Подписка: пробный доступ активен';
      }
      case 'active':
      case 'grace': {
        const expiry = formatExpiry(user.subscriptionExpiresAt);
        return expiry ? `📨 Подписка: активна до ${expiry}` : '📨 Подписка: активна';
      }
      case 'expired':
        return '📨 Подписка: истекла';
      case 'none':
      default:
        return access.isVerified ? '📨 Подписка: нужна оплата' : '📨 Подписка: после проверки';
    }
  })();

  statusLines.push(subscriptionLine);

  const parts = [`${copy.emoji} Меню ${copy.genitive}`, `🏙️ Город: ${cityLabel}`];
  if (statusLines.length > 0) {
    parts.push(...statusLines);
  }

  parts.push(
    '',
    ...buildVerificationSection(state, access),
    '',
    ...buildSubscriptionSection(state, access),
  );

  const nextSteps = buildNextStepsSection(state, access);
  if (nextSteps.length > 0) {
    parts.push('', '👉 Что дальше:');
    nextSteps.forEach((step, index) => {
      parts.push(`${index + 1}. ${step}`);
    });
  }

  return parts.join('\n');
};

export const showExecutorMenu = async (
  ctx: BotContext,
  options: ShowExecutorMenuOptions = {},
): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  const uiState = ctx.session.ui;
  uiState.pendingCityAction = EXECUTOR_MENU_CITY_ACTION;

  const city = await ensureCitySelected(ctx, 'Выберите город, чтобы получить доступ к заказам.');
  if (!city) {
    return;
  }

  uiState.pendingCityAction = undefined;

  const state = ensureExecutorState(ctx);
  if (!state.role || !EXECUTOR_ROLES.includes(state.role)) {
    return;
  }
  const access = determineExecutorAccessStatus(ctx, state);

  if (!options.skipAccessCheck) {
    if (shouldRedirectToVerification(state, access)) {
      await startExecutorVerification(ctx);
      return;
    }

    if (shouldRedirectToSubscription(state, access)) {
      await startExecutorSubscription(ctx, { skipVerificationCheck: true });
      return;
    }
  }

  const text = buildMenuText(state, access, CITY_LABEL[city], ctx.auth.user);
  const keyboard = buildMenuKeyboard(state, access);

  await ui.step(ctx, {
    id: EXECUTOR_MENU_STEP_ID,
    text,
    keyboard,
    cleanup: false,
  });
};

export const registerExecutorMenu = (bot: Telegraf<BotContext>): void => {
  bot.action(CITY_ACTION_PATTERN, async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      if (typeof next === 'function') {
        await next();
      }
      return;
    }

    if (typeof next === 'function') {
      await next();
    }

    if (ctx.chat?.type !== 'private') {
      return;
    }

    const pendingCityAction = ctx.session.ui?.pendingCityAction;
    const shouldShowExecutorMenu =
      pendingCityAction === EXECUTOR_MENU_CITY_ACTION ||
      (!pendingCityAction && userLooksLikeExecutor(ctx));

    if (!shouldShowExecutorMenu) {
      return;
    }

    ensureExecutorState(ctx);
    await showExecutorMenu(ctx);
  });

  bot.action(EXECUTOR_MENU_ACTION, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCbQuery('Доступно только в личных сообщениях.');
      return;
    }

    if (!userLooksLikeExecutor(ctx)) {
      await ctx.answerCbQuery();
      await showMenu(ctx);
      return;
    }

    await ctx.answerCbQuery();
    ensureExecutorState(ctx);
    await showExecutorMenu(ctx);
  });

  bot.action(EXECUTOR_MENU_CITY_SELECT_ACTION, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCbQuery('Доступно только в личных сообщениях.');
      return;
    }

    ensureExecutorState(ctx);
    const uiState = ctx.session.ui;
    if (uiState) {
      uiState.pendingCityAction = EXECUTOR_MENU_CITY_ACTION;
    }

    try {
      await ctx.answerCbQuery();
    } catch (error) {
      logger.debug({ err: error }, 'Failed to answer executor city callback');
    }

    await askCity(ctx, 'Выберите город:');
  });

  bot.action(EXECUTOR_PROFILE_ACTION, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCbQuery('Карточка доступна только в личных сообщениях.');
      return;
    }

    if (!userLooksLikeExecutor(ctx)) {
      await ctx.answerCbQuery();
      await showMenu(ctx);
      return;
    }

    await renderProfileCardFromAction(
      ctx,
      {
        ...buildExecutorProfileOptions(),
        onAnswerError: (error) => {
          logger.debug({ err: error }, 'Failed to answer executor profile callback');
        },
      },
    );
  });

  bot.command('menu', async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return;
    }

    const looksLikeExecutor = userLooksLikeExecutor(ctx);
    const cachedExecutorRole =
      !looksLikeExecutor &&
      ctx.session.isAuthenticated === false &&
      ctx.auth.user.role === 'guest'
        ? getCachedExecutorRole(ctx)
        : undefined;

    if (!looksLikeExecutor && !cachedExecutorRole) {
      await showMenu(ctx);
      return;
    }

    ensureExecutorState(ctx);
    await showExecutorMenu(ctx);
  });

  bot.command('profile', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      if (typeof next === 'function') {
        await next();
      }
      return;
    }

    if (!userLooksLikeExecutor(ctx)) {
      if (typeof next === 'function') {
        await next();
      } else {
        await showMenu(ctx);
      }
      return;
    }

    await renderProfileCard(ctx, buildExecutorProfileOptions());
  });

  bot.hears(EXECUTOR_MENU_TEXT_LABELS.refresh, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return;
    }

    if (!userLooksLikeExecutor(ctx)) {
      await showMenu(ctx);
      return;
    }

    ensureExecutorState(ctx);
    await showExecutorMenu(ctx);
  });
};
