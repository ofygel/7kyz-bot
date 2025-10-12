import type { MiddlewareFn } from 'telegraf';

import { logger } from '../../config';
import { pool, type PoolClient } from '../../db';
import {
  deleteSessionState,
  loadSessionState,
  saveSessionState,
  type SessionKey,
} from '../../db/sessions';
import {
  deleteSessionCache,
  loadSessionCache,
  saveSessionCache,
  refreshSessionCacheTtl,
} from '../../infra/sessionCache';
import { isAppCity } from '../../domain/cities';
import {
  EXECUTOR_ROLES,
  EXECUTOR_VERIFICATION_PHOTO_COUNT,
  type AuthExecutorPlan,
  type AuthStateSnapshot,
  type BotContext,
  type ClientFlowState,
  type ClientOrderDraftState,
  type ExecutorFlowState,
  type ExecutorJobsState,
  type ExecutorRole,
  type ExecutorSubscriptionState,
  type ExecutorUploadedPhoto,
  type ExecutorVerificationRoleState,
  type ExecutorVerificationState,
  type OnboardingState,
  type SessionState,
  type SessionUser,
  type SupportSessionState,
  type UiSessionState,
  type ModerationPlansSessionState,
  type UserRole,
  type UserStatus,
  type UserVerifyStatus,
  type UserSubscriptionStatus,
} from '../types';
import { enterSafeMode } from '../services/cleanup';
import { reportDatabaseFallback } from '../services/reports';

const createVerificationState = (): ExecutorVerificationState => {
  const verification = {} as ExecutorVerificationState;
  for (const role of EXECUTOR_ROLES) {
    verification[role] = {
      status: 'idle',
      requiredPhotos: EXECUTOR_VERIFICATION_PHOTO_COUNT,
      uploadedPhotos: [],
      processedMediaGroups: {},
    };
  }
  return verification;
};

const createSubscriptionState = (): ExecutorSubscriptionState => ({
  status: 'idle',
  selectedPeriodId: undefined,
  pendingPaymentId: undefined,
  paymentRequestedAt: undefined,
  moderationChatId: undefined,
  moderationMessageId: undefined,
  lastInviteLink: undefined,
  lastIssuedAt: undefined,
  lastReminderAt: undefined,
});

const EXECUTOR_SUBSCRIPTION_STATUSES: readonly ExecutorSubscriptionState['status'][] = [
  'idle',
  'selectingPeriod',
  'await_payment_manual',
  'awaitingReceipt',
  'pendingModeration',
];

const EXECUTOR_JOB_STAGES: readonly ExecutorJobsState['stage'][] = [
  'idle',
  'feed',
  'confirm',
  'inProgress',
  'complete',
];

const createJobsState = (): ExecutorJobsState => ({ stage: 'idle' });

const normaliseTimestamp = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : time;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
};

const createExecutorState = (): ExecutorFlowState => ({
  role: undefined,
  verification: createVerificationState(),
  subscription: createSubscriptionState(),
  jobs: createJobsState(),
  awaitingRoleSelection: true,
  roleSelectionStage: 'role',
});

const createOnboardingState = () => ({ active: false }) satisfies OnboardingState;

const createClientOrderDraft = (): ClientOrderDraftState => ({
  stage: 'idle',
});

const createClientState = (): ClientFlowState => ({
  taxi: createClientOrderDraft(),
  delivery: createClientOrderDraft(),
});

const createUiState = (): UiSessionState => ({
  steps: {},
  homeActions: [],
  pendingCityAction: undefined,
  clientMenuVariant: undefined,
});

const createSupportState = (): SupportSessionState => ({
  status: 'idle',
});

const createModerationPlansState = (): ModerationPlansSessionState => ({
  threads: {},
  edits: {},
});

const USER_ROLES: readonly UserRole[] = ['guest', 'client', 'executor', 'moderator'];
const USER_STATUSES: readonly UserStatus[] = [
  'guest',
  'onboarding',
  'awaiting_phone',
  'active_client',
  'active_executor',
  'safe_mode',
  'suspended',
  'banned',
];

const VERIFY_STATUSES: readonly UserVerifyStatus[] = [
  'none',
  'pending',
  'active',
  'rejected',
  'expired',
];

const SUBSCRIPTION_STATUSES: readonly UserSubscriptionStatus[] = [
  'none',
  'active',
  'grace',
  'expired',
];

const normaliseSnapshotDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : new Date(value);
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  return undefined;
};

const createAuthSnapshot = (): AuthStateSnapshot => ({
  role: 'guest',
  executorKind: undefined,
  status: 'guest',
  phoneVerified: false,
  verifyStatus: 'none',
  subscriptionStatus: 'none',
  userIsVerified: false,
  executor: {
    verifiedRoles: { courier: false, driver: false },
    hasActiveSubscription: false,
    isVerified: false,
  },
  isModerator: false,
  subscriptionExpiresAt: undefined,
  executorPlan: undefined,
  city: undefined,
  hasActiveOrder: false,
  stale: false,
});

const rebuildAuthSnapshot = (value: unknown, sessionUser?: SessionUser): AuthStateSnapshot => {
  const snapshot = createAuthSnapshot();
  if (!value || typeof value !== 'object') {
    if (sessionUser?.phoneVerified !== undefined) {
      snapshot.phoneVerified = Boolean(sessionUser.phoneVerified);
    }
    return snapshot;
  }

  const candidate = value as Partial<AuthStateSnapshot> & {
    executor?: Partial<AuthStateSnapshot['executor']> & {
      verifiedRoles?: Partial<Record<ExecutorRole, unknown>>;
    };
  };

  const candidateRole = (candidate as { role?: unknown }).role;
  if (typeof candidateRole === 'string' && USER_ROLES.includes(candidateRole as UserRole)) {
    snapshot.role = candidateRole as UserRole;
    if (candidateRole === 'moderator') {
      snapshot.isModerator = true;
    }
  }

  if (
    typeof candidate.executorKind === 'string'
    && EXECUTOR_ROLES.includes(candidate.executorKind as ExecutorRole)
  ) {
    snapshot.executorKind = candidate.executorKind as ExecutorRole;
  }

  if (typeof candidate.status === 'string' && USER_STATUSES.includes(candidate.status as UserStatus)) {
    snapshot.status = candidate.status as UserStatus;
  }

  if (
    typeof candidate.verifyStatus === 'string'
    && VERIFY_STATUSES.includes(candidate.verifyStatus as UserVerifyStatus)
  ) {
    snapshot.verifyStatus = candidate.verifyStatus as UserVerifyStatus;
  }

  const candidateSubscriptionStatus = (candidate as { subscriptionStatus?: unknown })
    .subscriptionStatus;
  if (
    typeof candidateSubscriptionStatus === 'string'
    && SUBSCRIPTION_STATUSES.includes(candidateSubscriptionStatus as UserSubscriptionStatus)
  ) {
    snapshot.subscriptionStatus = candidateSubscriptionStatus as UserSubscriptionStatus;
  } else if (candidateSubscriptionStatus === 'trial') {
    snapshot.subscriptionStatus = 'active';
  }

  if (typeof candidate.isModerator === 'boolean') {
    snapshot.isModerator = candidate.isModerator;
  }

  if (snapshot.isModerator) {
    snapshot.role = 'moderator';
  } else if (snapshot.role === 'moderator') {
    snapshot.role = 'executor';
  }

  if (candidate.executor && typeof candidate.executor === 'object') {
    const executor = candidate.executor;
    const verifiedRoles = executor.verifiedRoles ?? {};
    snapshot.executor = {
      verifiedRoles: {
        courier: Boolean((verifiedRoles as Record<ExecutorRole, unknown>).courier),
        driver: Boolean((verifiedRoles as Record<ExecutorRole, unknown>).driver),
      },
      hasActiveSubscription: Boolean(executor.hasActiveSubscription),
      isVerified: Boolean(executor.isVerified),
    };
  }

  const hasPhoneVerifiedField = Object.prototype.hasOwnProperty.call(candidate, 'phoneVerified');
  if (hasPhoneVerifiedField) {
    snapshot.phoneVerified = Boolean(
      (candidate as { phoneVerified?: unknown }).phoneVerified,
    );
  } else if (sessionUser?.phoneVerified !== undefined) {
    snapshot.phoneVerified = Boolean(sessionUser.phoneVerified);
  }

  const hasUserVerifiedField = Object.prototype.hasOwnProperty.call(candidate, 'userIsVerified');
  if (hasUserVerifiedField && typeof candidate.userIsVerified === 'boolean') {
    snapshot.userIsVerified = candidate.userIsVerified;
  } else if (candidate.executor && typeof candidate.executor === 'object') {
    const executorIsVerified = Boolean(
      (candidate.executor as { isVerified?: unknown }).isVerified,
    );
    if (executorIsVerified) {
      snapshot.userIsVerified = true;
    }
  }

  if (candidate.city && isAppCity(candidate.city)) {
    snapshot.city = candidate.city;
  }

  if ('executorPlan' in candidate) {
    const value = (candidate as { executorPlan?: unknown }).executorPlan;
    if (value && typeof value === 'object') {
      const planCandidate = value as Partial<AuthExecutorPlan>;
      const id =
        typeof planCandidate.id === 'number' && Number.isFinite(planCandidate.id)
          ? Math.trunc(planCandidate.id)
          : undefined;
      const planChoice =
        typeof planCandidate.planChoice === 'string' ? planCandidate.planChoice : undefined;
      const status =
        typeof planCandidate.status === 'string' ? planCandidate.status : undefined;
      const startAt = normaliseSnapshotDate(planCandidate.startAt);
      const endsAt = normaliseSnapshotDate(planCandidate.endsAt);

      if (id !== undefined && planChoice && status && startAt && endsAt) {
        snapshot.executorPlan = {
          id,
          planChoice: planChoice as AuthExecutorPlan['planChoice'],
          status: status as AuthExecutorPlan['status'],
          startAt,
          endsAt,
        } satisfies AuthExecutorPlan;
      }
    }
  }

  if ('subscriptionExpiresAt' in candidate) {
    const value = (candidate as { subscriptionExpiresAt?: unknown }).subscriptionExpiresAt;
    const parsed = normaliseSnapshotDate(value);
    if (parsed) {
      snapshot.subscriptionExpiresAt = parsed;
    }
  }

  if (Object.prototype.hasOwnProperty.call(candidate, 'hasActiveOrder')) {
    snapshot.hasActiveOrder = Boolean(
      (candidate as { hasActiveOrder?: unknown }).hasActiveOrder,
    );
  }

  if (typeof candidate.stale === 'boolean') {
    snapshot.stale = candidate.stale;
  }

  if (!snapshot.userIsVerified && snapshot.verifyStatus === 'active') {
    snapshot.userIsVerified = true;
  }

  if (['active', 'grace'].includes(snapshot.subscriptionStatus)) {
    snapshot.executor.hasActiveSubscription = true;
  }

  return snapshot;
};
const isExecutorRole = (value: unknown): value is ExecutorFlowState['role'] =>
  typeof value === 'string' && EXECUTOR_ROLES.includes(value as (typeof EXECUTOR_ROLES)[number]);

const rebuildExecutorState = (value: unknown): ExecutorFlowState => {
  const state = createExecutorState();
  if (!value || typeof value !== 'object') {
    return state;
  }

  const executor = value as Partial<ExecutorFlowState>;

  if (isExecutorRole(executor.role)) {
    state.role = executor.role;
  } else {
    state.role = undefined;
  }

  if (executor.subscription && typeof executor.subscription === 'object') {
    const subscription = executor.subscription as Partial<ExecutorSubscriptionState> & {
      [key: string]: unknown;
    };

    const statusCandidate = subscription.status;
    if (
      typeof statusCandidate === 'string' &&
      EXECUTOR_SUBSCRIPTION_STATUSES.includes(statusCandidate as ExecutorSubscriptionState['status'])
    ) {
      state.subscription.status = statusCandidate as ExecutorSubscriptionState['status'];
    }

    if ('selectedPeriodId' in subscription) {
      const selectedPeriod = subscription.selectedPeriodId;
      if (typeof selectedPeriod === 'string' && selectedPeriod.trim().length > 0) {
        state.subscription.selectedPeriodId = selectedPeriod;
      } else {
        state.subscription.selectedPeriodId = undefined;
      }
    }

    if ('pendingPaymentId' in subscription) {
      const pendingPaymentId = subscription.pendingPaymentId;
      if (typeof pendingPaymentId === 'string' && pendingPaymentId.trim().length > 0) {
        state.subscription.pendingPaymentId = pendingPaymentId;
      } else {
        state.subscription.pendingPaymentId = undefined;
      }
    }

    if ('paymentRequestedAt' in subscription) {
      const paymentRequestedAt = normaliseTimestamp(subscription.paymentRequestedAt);
      state.subscription.paymentRequestedAt = paymentRequestedAt;
    }

    if ('moderationChatId' in subscription) {
      const moderationChatId = subscription.moderationChatId;
      if (typeof moderationChatId === 'number' && Number.isFinite(moderationChatId)) {
        state.subscription.moderationChatId = moderationChatId;
      } else {
        state.subscription.moderationChatId = undefined;
      }
    }

    if ('moderationMessageId' in subscription) {
      const moderationMessageId = subscription.moderationMessageId;
      if (typeof moderationMessageId === 'number' && Number.isFinite(moderationMessageId)) {
        state.subscription.moderationMessageId = moderationMessageId;
      } else {
        state.subscription.moderationMessageId = undefined;
      }
    }

    if ('lastInviteLink' in subscription) {
      const lastInviteLink = subscription.lastInviteLink;
      if (typeof lastInviteLink === 'string' && lastInviteLink.trim().length > 0) {
        state.subscription.lastInviteLink = lastInviteLink;
      } else {
        state.subscription.lastInviteLink = undefined;
      }
    }

    if ('lastIssuedAt' in subscription) {
      const lastIssuedAt = normaliseTimestamp(subscription.lastIssuedAt);
      state.subscription.lastIssuedAt = lastIssuedAt;
    }

    if ('lastReminderAt' in subscription) {
      const lastReminderAt = normaliseTimestamp(subscription.lastReminderAt);
      state.subscription.lastReminderAt = lastReminderAt;
    }
  }

  if (executor.jobs && typeof executor.jobs === 'object') {
    const jobs = executor.jobs as Partial<ExecutorJobsState>;
    if (
      typeof jobs.stage === 'string' &&
      EXECUTOR_JOB_STAGES.includes(jobs.stage as ExecutorJobsState['stage'])
    ) {
      state.jobs.stage = jobs.stage as ExecutorJobsState['stage'];
    }
    if (typeof jobs.activeOrderId === 'number') {
      state.jobs.activeOrderId = jobs.activeOrderId;
    }
    if (typeof jobs.pendingOrderId === 'number') {
      state.jobs.pendingOrderId = jobs.pendingOrderId;
    }
    if (typeof jobs.lastViewedAt === 'number' && Number.isFinite(jobs.lastViewedAt)) {
      state.jobs.lastViewedAt = jobs.lastViewedAt;
    }
  }

  if (executor.verification && typeof executor.verification === 'object') {
    const verification = executor.verification as Partial<ExecutorVerificationState>;
    for (const role of EXECUTOR_ROLES) {
      const candidate = verification[role];
      if (!candidate || typeof candidate !== 'object') {
        continue;
      }

      Object.assign(state.verification[role], candidate);

      const uploadedPhotos = (candidate as { uploadedPhotos?: unknown }).uploadedPhotos;
      if (Array.isArray(uploadedPhotos)) {
        const photos: ExecutorUploadedPhoto[] = [];
        for (const item of uploadedPhotos) {
          if (!item || typeof item !== 'object') {
            continue;
          }

          const fileId = (item as { fileId?: unknown }).fileId;
          const messageId = (item as { messageId?: unknown }).messageId;
          if (typeof fileId !== 'string' || typeof messageId !== 'number') {
            continue;
          }

          const photo: ExecutorUploadedPhoto = {
            fileId,
            messageId,
          };

          const fileUniqueId = (item as { fileUniqueId?: unknown }).fileUniqueId;
          if (typeof fileUniqueId === 'string') {
            photo.fileUniqueId = fileUniqueId;
          }

          photos.push(photo);
        }

        state.verification[role].uploadedPhotos = photos;
      }

      const processedGroups = (candidate as {
        processedMediaGroups?: unknown;
      }).processedMediaGroups;
      const groups: ExecutorVerificationRoleState['processedMediaGroups'] = {};
      if (processedGroups && typeof processedGroups === 'object') {
        for (const [groupId, groupValue] of Object.entries(
          processedGroups as Record<string, unknown>,
        )) {
          if (!groupValue || typeof groupValue !== 'object') {
            continue;
          }

          const sourceIds = (groupValue as { photoUniqueIds?: unknown }).photoUniqueIds;
          const photoUniqueIds = Array.isArray(sourceIds)
            ? sourceIds.filter((value): value is string => typeof value === 'string')
            : [];
          const progressNotified = Boolean(
            (groupValue as { progressNotified?: unknown }).progressNotified,
          );

          groups[groupId] = {
            photoUniqueIds: [...photoUniqueIds],
            progressNotified,
          };
        }
      }

      state.verification[role].processedMediaGroups = groups;
    }
  }

  return state;
};

const rebuildClientState = (value: unknown): ClientFlowState => {
  const state = createClientState();
  if (!value || typeof value !== 'object') {
    return state;
  }

  const client = value as Partial<ClientFlowState>;
  for (const key of ['taxi', 'delivery'] as const) {
    const draft = client[key];
    if (draft && typeof draft === 'object') {
      Object.assign(state[key], draft);
    }
  }

  return state;
};

const normaliseSessionState = (state: SessionState): SessionState => {
  const working = state;

  if (!('city' in working)) {
    working.city = undefined;
  }

  if (typeof (working as { safeMode?: unknown }).safeMode !== 'boolean') {
    working.safeMode = false;
  }

  const safeModeFlags = working as { isDegraded?: unknown; degraded?: unknown };
  if (typeof safeModeFlags.isDegraded === 'boolean') {
    if ('degraded' in safeModeFlags) {
      delete safeModeFlags.degraded;
    }
  } else if (typeof safeModeFlags.degraded === 'boolean') {
    working.isDegraded = safeModeFlags.degraded;
    delete safeModeFlags.degraded;
  } else {
    working.isDegraded = false;
  }

  const safeModeReasonRaw = (working as { safeModeReason?: unknown }).safeModeReason;
  if (typeof safeModeReasonRaw === 'string') {
    const trimmed = safeModeReasonRaw.trim();
    working.safeModeReason = trimmed.length > 0 ? trimmed : undefined;
  } else if (safeModeReasonRaw !== undefined) {
    working.safeModeReason = undefined;
  }

  const safeModePromptRaw = (working as { safeModePrompt?: unknown }).safeModePrompt;
  if (typeof safeModePromptRaw === 'string') {
    const trimmed = safeModePromptRaw.trim();
    working.safeModePrompt = trimmed.length > 0 ? trimmed : undefined;
  } else if (safeModePromptRaw !== undefined) {
    working.safeModePrompt = undefined;
  }

  if (!working.ui) {
    working.ui = createUiState();
  }

  if (!working.support) {
    working.support = createSupportState();
  }

  if (!working.moderationPlans) {
    working.moderationPlans = createModerationPlansState();
  } else if (
    !(working.moderationPlans as { threads?: unknown }).threads ||
    typeof (working.moderationPlans as { threads?: unknown }).threads !== 'object'
  ) {
    working.moderationPlans.threads = {};
  }

  if (!working.onboarding) {
    working.onboarding = createOnboardingState();
  }

  working.executor = rebuildExecutorState((working as { executor?: unknown }).executor);
  working.client = rebuildClientState((working as { client?: unknown }).client);
  working.authSnapshot = rebuildAuthSnapshot(
    (working as { authSnapshot?: unknown }).authSnapshot,
    working.user,
  );

  return working;
};

const createDefaultState = (): SessionState => ({
  ephemeralMessages: [],
  isAuthenticated: false,
  safeMode: false,
  isDegraded: false,
  safeModeReason: undefined,
  safeModePrompt: undefined,
  awaitingPhone: false,
  city: undefined,
  authSnapshot: createAuthSnapshot(),
  executor: createExecutorState(),
  client: createClientState(),
  ui: createUiState(),
  moderationPlans: createModerationPlansState(),
  support: createSupportState(),
  onboarding: createOnboardingState(),
});

const prepareFallbackSession = (
  state: SessionState | null | undefined,
): SessionState => {
  const session = normaliseSessionState(state ?? createDefaultState());
  session.isAuthenticated = false;
  session.safeMode = true;
  session.isDegraded = true;
  session.safeModeReason = undefined;
  session.safeModePrompt = undefined;
  session.authSnapshot.status = 'safe_mode';
  session.authSnapshot.stale = true;
  return session;
};

const SESSION_META = Symbol('session-meta');

interface SessionMeta {
  key: SessionKey;
  cleared: boolean;
}

type SessionMetaContainer = {
  [SESSION_META]?: SessionMeta;
};

const setSessionMeta = (ctx: BotContext, meta?: SessionMeta): void => {
  const container = ctx as BotContext & SessionMetaContainer;
  if (meta) {
    container[SESSION_META] = meta;
  } else {
    delete container[SESSION_META];
  }
};

const getSessionMeta = (ctx: BotContext): SessionMeta | undefined => {
  const container = ctx as BotContext & SessionMetaContainer;
  return container[SESSION_META];
};

const parseScopeId = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    if (/^[+-]?\d+$/.test(trimmed)) {
      try {
        return BigInt(trimmed).toString();
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
};

export const resolveSessionKey = (ctx: BotContext): SessionKey | undefined => {
  const chatId = parseScopeId(ctx.chat?.id);
  if (chatId !== undefined) {
    return { scope: 'chat', scopeId: chatId } satisfies SessionKey;
  }

  const userId = parseScopeId(ctx.from?.id);
  if (userId !== undefined) {
    return { scope: 'user', scopeId: userId } satisfies SessionKey;
  }

  return undefined;
};

export const clearSession = async (ctx: BotContext): Promise<void> => {
  const key = resolveSessionKey(ctx);
  if (!key) {
    return;
  }

  const meta = getSessionMeta(ctx);
  if (meta && meta.key.scope === key.scope && meta.key.scopeId === key.scopeId) {
    meta.cleared = true;
    return;
  }

  await deleteSessionState(pool, key);
  await deleteSessionCache(key);
};

export const session = (): MiddlewareFn<BotContext> => async (ctx, next) => {
  const key = resolveSessionKey(ctx);
  if (!key) {
    await next();
    return;
  }

  let client: PoolClient | undefined;
  const meta: SessionMeta = { key, cleared: false };
  setSessionMeta(ctx, meta);

  let nextError: unknown;
  let fallbackMode = false;
  let nextInvoked = false;
  let cachedState: SessionState | null = null;
  let finalState: SessionState | undefined;
  let fallbackReportSent = false;

  const sendFallbackReport = async (reason: string): Promise<void> => {
    if (fallbackReportSent) {
      return;
    }

    fallbackReportSent = true;
    await reportDatabaseFallback(ctx.telegram, {
      chat: ctx.chat ?? undefined,
      user: ctx.from ?? undefined,
      reason,
    });
  };

  const invokeNext = async (): Promise<void> => {
    if (nextInvoked) {
      return;
    }

    nextInvoked = true;
    try {
      await next();
    } catch (error) {
      nextError = error;
    }
  };

  try {
    try {
      cachedState = await loadSessionCache(key);
    } catch (error) {
      logger.warn({ err: error, key }, 'Failed to load session cache, continuing');
    }

    try {
      client = await pool.connect();
    } catch (error) {
      const fallbackSession = prepareFallbackSession(cachedState);
      ctx.session = fallbackSession;
      await enterSafeMode(ctx, { reason: 'session-db-connect-failed' });
      await sendFallbackReport('session-db-connect-failed');
      logger.warn({ err: error, key }, 'Failed to connect to database for session state');

      fallbackMode = true;
      await invokeNext();
      finalState = ctx.session;
    }

    const dbClient = client;
    if (!fallbackMode && !dbClient) {
      const fallbackSession = prepareFallbackSession(cachedState);
      ctx.session = fallbackSession;
      await enterSafeMode(ctx, { reason: 'session-client-missing' });
      await sendFallbackReport('session-client-missing');
      logger.warn({ key }, 'Database client was not initialised for session state');

      fallbackMode = true;
      await invokeNext();
      finalState = ctx.session;
    }

    let state: SessionState | undefined;

    if (!fallbackMode && dbClient) {
      const activeClient = dbClient;
      try {
        const existing = await loadSessionState(activeClient, key);
        state = existing ?? cachedState ?? createDefaultState();
      } catch (error) {
        const fallbackSession = prepareFallbackSession(cachedState);
        ctx.session = fallbackSession;
        await enterSafeMode(ctx, { reason: 'session-load-failed' });
        await sendFallbackReport('session-load-failed');
        logger.warn({ err: error, key }, 'Failed to load session state, using default state');

        fallbackMode = true;
        await invokeNext();
        finalState = ctx.session;
      }
    }

    if (!fallbackMode && dbClient) {
      const activeClient = dbClient;
      if (!state) {
        state = cachedState ?? createDefaultState();
      }

      ctx.session = normaliseSessionState(state);
      ctx.session.isDegraded = false;
      ctx.session.safeMode = false;
      ctx.session.safeModeReason = undefined;
      ctx.session.safeModePrompt = undefined;

      await invokeNext();
      finalState = ctx.session;

      if (meta.cleared) {
        try {
          await deleteSessionState(activeClient, key);
        } catch (error) {
          logger.warn({ err: error, key }, 'Failed to delete session state, continuing without persistence');
        }
      } else {
        try {
          await saveSessionState(activeClient, key, ctx.session);
        } catch (error) {
          logger.warn({ err: error, key }, 'Failed to save session state, continuing without persistence');
        }
      }
    }

    if (fallbackMode) {
      if (ctx.session) {
        ctx.session = prepareFallbackSession(ctx.session);
        await enterSafeMode(ctx, { reason: 'session-fallback-mode' });
      }
      await sendFallbackReport('session-fallback-mode');
      await invokeNext();
      finalState = ctx.session;
    }
  } finally {
    setSessionMeta(ctx, undefined);
    client?.release();
  }

  if (nextError) {
    throw nextError;
  }

  if (meta.cleared) {
    try {
      await deleteSessionCache(key);
    } catch (error) {
      logger.warn({ err: error, key }, 'Failed to clear session cache after reset');
    }
    return;
  }

  if (!finalState) {
    return;
  }

  try {
    const stateToCache = fallbackMode ? prepareFallbackSession(finalState) : finalState;
    await saveSessionCache(key, stateToCache);
    await refreshSessionCacheTtl(key);
  } catch (error) {
    logger.warn({ err: error, key }, 'Failed to persist session cache');
  }
};

export type { SessionState };
