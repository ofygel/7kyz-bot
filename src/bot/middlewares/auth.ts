import type { MiddlewareFn } from 'telegraf';

import { logger } from '../../config';
import { findActiveExecutorPlanByPhone, hasUsersCitySelectedColumn, pool } from '../../db';
import { isAppCity } from '../../domain/cities';
import { copy } from '../copy';
import { enterSafeMode } from '../services/cleanup';
import type { ExecutorPlanRecord } from '../../types';
import {
  EXECUTOR_ROLES,
  type AuthExecutorPlan,
  type AuthExecutorState,
  type AuthState,
  type AuthStateSnapshot,
  type BotContext,
  type ExecutorRole,
  type UserRole,
  type UserMenuRole,
  type UserStatus,
  type UserVerifyStatus,
  type UserSubscriptionStatus,
} from '../types';

type Nullable<T> = T | null | undefined;

class AuthStateQueryError extends Error {
  declare cause: unknown;

  constructor(message: string, options: { cause: unknown }) {
    super(message);
    this.name = 'AuthStateQueryError';
    this.cause = options.cause;
  }
}

interface AuthQueryRow {
  tg_id: string | number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  phone_verified: boolean | null;
  role: string | null;
  executor_kind?: string | null;
  status: string | null;
  verify_status: string | null;
  is_blocked: boolean | null;
  courier_verified: boolean | null;
  driver_verified: boolean | null;
  sub_status?: string | null;
  sub_expires_at?: string | Date | null;
  has_active_order?: boolean | null;
  city_selected?: string | null;
  verified_at?: string | Date | null;
  last_menu_role?: string | null;
  keyboard_nonce?: string | null;
}

const parseNumericId = (value: string | number): number => {
  if (typeof value === 'number') {
    return value;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Failed to parse numeric identifier: ${value}`);
  }

  return parsed;
};

const normaliseString = (value: Nullable<string>): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normaliseRole = (value: Nullable<string>): UserRole => {
  switch (value) {
    case 'client':
      return 'client';
    case 'executor':
      return 'executor';
    case 'moderator':
      return 'moderator';
    case 'guest':
    default:
      return 'guest';
  }
};

const normaliseExecutorKind = (value: Nullable<string>): ExecutorRole | undefined => {
  switch (value) {
    case 'courier':
    case 'driver':
      return value;
    default:
      return undefined;
  }
};

const normaliseVerifyStatus = (value: Nullable<string>): UserVerifyStatus => {
  switch (value) {
    case 'pending':
    case 'active':
    case 'rejected':
    case 'expired':
      return value;
    case 'none':
    default:
      return 'none';
  }
};

const normaliseSubscriptionStatus = (value: Nullable<string>): UserSubscriptionStatus => {
  switch (value) {
    case 'active':
    case 'grace':
    case 'expired':
      return value;
    case 'trial':
      return 'active';
    case 'none':
    default:
      return 'none';
  }
};

const normaliseStatus = (value: Nullable<string>): UserStatus => {
  switch (value) {
    case 'onboarding':
    case 'awaiting_phone':
    case 'active_client':
    case 'active_executor':
    case 'safe_mode':
    case 'trial_expired':
    case 'suspended':
    case 'banned':
      return value;
    case 'guest':
    default:
      return 'guest';
  }
};

const normaliseMenuRole = (value: Nullable<string>): UserMenuRole | undefined => {
  switch (value) {
    case 'client':
    case 'courier':
    case 'moderator':
      return value;
    default:
      return undefined;
  }
};

const parseTimestamp = (value: Nullable<string | Date>): Date | undefined => {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return new Date(value);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return undefined;
  }

  return parsed;
};

const buildVerifiedMap = (row: AuthQueryRow): Record<ExecutorRole, boolean> => ({
  courier: Boolean(row.courier_verified),
  driver: Boolean(row.driver_verified),
});

const isSubscriptionActive = (status: UserSubscriptionStatus): boolean =>
  status === 'active' || status === 'grace';

const mapExecutorPlan = (plan: ExecutorPlanRecord): AuthExecutorPlan => ({
  id: plan.id,
  planChoice: plan.planChoice,
  status: plan.status,
  startAt: plan.startAt,
  endsAt: plan.endsAt,
});

const buildExecutorState = (row: AuthQueryRow): AuthExecutorState => {
  const verifiedRoles = buildVerifiedMap(row);
  const verifyStatus = normaliseVerifyStatus(row.verify_status);
  const subscriptionStatus = normaliseSubscriptionStatus(row.sub_status);
  const isVerified = verifyStatus === 'active'
    || EXECUTOR_ROLES.some((role) => verifiedRoles[role]);

  return {
    verifiedRoles,
    hasActiveSubscription: isSubscriptionActive(subscriptionStatus),
    isVerified,
  } satisfies AuthExecutorState;
};

const deriveSnapshotStatus = (
  role: UserRole,
  options: { isModerator?: boolean } = {},
): UserStatus => {
  if (options.isModerator || role === 'moderator') {
    return 'active_executor';
  }

  switch (role) {
    case 'executor':
      return 'active_executor';
    case 'client':
      return 'active_client';
    case 'guest':
    default:
      return 'guest';
  }
};

const cloneExecutorState = (executor: AuthExecutorState): AuthExecutorState => ({
  verifiedRoles: { ...executor.verifiedRoles },
  hasActiveSubscription: executor.hasActiveSubscription,
  isVerified: executor.isVerified,
});

const cloneAuthExecutorPlan = (
  plan: AuthExecutorPlan | undefined,
): AuthExecutorPlan | undefined => {
  if (!plan) {
    return undefined;
  }

  return {
    id: plan.id,
    planChoice: plan.planChoice,
    status: plan.status,
    startAt: new Date(plan.startAt),
    endsAt: new Date(plan.endsAt),
  } satisfies AuthExecutorPlan;
};

interface SnapshotHydrationOptions {
  restoreRole?: boolean;
}

const buildAuthStateFromSnapshot = (
  ctx: BotContext,
  snapshot: AuthStateSnapshot,
  options: SnapshotHydrationOptions = {},
): AuthState => {
  const base = createGuestAuthState(ctx.from!);
  const sessionUser = ctx.session.user;

  if (sessionUser) {
    base.user.username = sessionUser.username ?? base.user.username;
    base.user.firstName = sessionUser.firstName ?? base.user.firstName;
    base.user.lastName = sessionUser.lastName ?? base.user.lastName;
    base.user.phoneVerified = sessionUser.phoneVerified ?? base.user.phoneVerified;
  }

  if (ctx.session.phoneNumber) {
    base.user.phone = ctx.session.phoneNumber;
  }

  const shouldRestoreRole = options.restoreRole ?? true;
  if (shouldRestoreRole) {
    base.user.role = snapshot.role;
    base.user.status = snapshot.status
      ?? deriveSnapshotStatus(snapshot.role, { isModerator: snapshot.isModerator });
    base.user.executorKind = snapshot.executorKind ?? base.user.executorKind;
  }
  base.user.phoneVerified = Boolean(snapshot.phoneVerified || base.user.phoneVerified);
  base.user.verifyStatus = snapshot.verifyStatus ?? base.user.verifyStatus;
  base.user.subscriptionStatus = snapshot.subscriptionStatus ?? base.user.subscriptionStatus;
  const userVerifiedFromSnapshot = snapshot.userIsVerified || snapshot.executor.isVerified;
  const snapshotVerified = snapshot.verifyStatus === 'active';
  base.user.isVerified = Boolean(snapshotVerified || userVerifiedFromSnapshot || base.user.isVerified);
  base.user.subscriptionExpiresAt =
    snapshot.subscriptionExpiresAt ?? base.user.subscriptionExpiresAt;
  base.user.activeExecutorPlan =
    cloneAuthExecutorPlan(snapshot.executorPlan) ?? base.user.activeExecutorPlan;
  base.user.hasActiveOrder = snapshot.hasActiveOrder ?? base.user.hasActiveOrder;
  base.user.citySelected = snapshot.city ?? base.user.citySelected;
  base.executor = cloneExecutorState(snapshot.executor);
  const snapshotIsModerator = snapshot.isModerator === true || snapshot.role === 'moderator';
  base.isModerator = shouldRestoreRole && snapshotIsModerator;
  if (base.isModerator) {
    base.user.role = 'moderator';
  }

  if (ctx.session.safeMode) {
    base.user.status = 'safe_mode';
  }

  return base;
};

const deriveUserStatus = (
  row: AuthQueryRow,
  status: UserStatus,
  isModerator = false,
): UserStatus => {
  if (
    status === 'trial_expired'
    || status === 'suspended'
    || status === 'banned'
    || status === 'safe_mode'
  ) {
    return status;
  }

  if (row.is_blocked) {
    return 'suspended';
  }

  const role = normaliseRole(row.role);
  const hasVerifiedPhone = Boolean(row.phone_verified);

  if (!hasVerifiedPhone) {
    return 'awaiting_phone';
  }

  if (status === 'active_executor') {
    return 'active_executor';
  }

  if (status === 'onboarding') {
    return 'onboarding';
  }

  const subscriptionStatus = normaliseSubscriptionStatus(row.sub_status);
  const hasExecutorAccess =
    role === 'executor' ? isSubscriptionActive(subscriptionStatus) : false;

  if (hasExecutorAccess) {
    return 'active_executor';
  }

  if (isModerator) {
    return 'active_executor';
  }

  return 'active_client';
};

const buildAuthQuery = (includeCitySelected: boolean): string => `
      WITH upsert AS (
        INSERT INTO users (tg_id, username, first_name, last_name, updated_at)
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT (tg_id) DO UPDATE
        SET
          username = COALESCE(EXCLUDED.username, users.username),
          first_name = COALESCE(EXCLUDED.first_name, users.first_name),
          last_name = COALESCE(EXCLUDED.last_name, users.last_name),
          is_blocked = false,
          updated_at = now()
        RETURNING
          tg_id,
          username,
          first_name,
          last_name,
          phone,
          phone_verified,
          role,
          executor_kind,
          status,
          verify_status,
          sub_status,
          sub_expires_at,
          has_active_order,
          is_blocked${includeCitySelected ? ',\n          city_selected' : ''},
          verified_at,
          last_menu_role,
          keyboard_nonce
      )
      SELECT
        u.tg_id,
        u.username,
        u.first_name,
        u.last_name,
        u.phone,
        u.phone_verified,
        u.role,
        u.executor_kind,
        u.status,
        u.verify_status,
        u.sub_status,
        u.sub_expires_at,
        u.has_active_order,
        u.is_blocked${includeCitySelected ? ',\n        u.city_selected' : ''},
        u.verified_at,
        u.last_menu_role,
        u.keyboard_nonce,
        COALESCE(cv.is_verified, false) AS courier_verified,
        COALESCE(dv.is_verified, false) AS driver_verified
      FROM upsert u
      LEFT JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1
          FROM verifications v
          WHERE v.user_id = u.tg_id
            AND v.role = 'courier'
            AND v.status = 'active'
            AND (v.expires_at IS NULL OR v.expires_at > now())
        ) AS is_verified
      ) cv ON true
      LEFT JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1
          FROM verifications v
          WHERE v.user_id = u.tg_id
            AND v.role = 'driver'
            AND v.status = 'active'
            AND (v.expires_at IS NULL OR v.expires_at > now())
        ) AS is_verified
      ) dv ON true
    `;

const mapAuthRow = async (row: AuthQueryRow): Promise<AuthState> => {
  const telegramId = parseNumericId(row.tg_id);
  const executor = buildExecutorState(row);
  let role = normaliseRole(row.role);
  const isModerator = role === 'moderator';
  let executorKind = normaliseExecutorKind(row.executor_kind);
  const verifyStatus = normaliseVerifyStatus(row.verify_status);
  const subscriptionStatus = normaliseSubscriptionStatus(row.sub_status);
  const status = deriveUserStatus(row, normaliseStatus(row.status), isModerator);
  const lastMenuRole = normaliseMenuRole(row.last_menu_role);
  const phone = normaliseString(row.phone);

  if (role === 'client') {
    const awaitingActivation =
      status === 'guest' ||
      status === 'awaiting_phone' ||
      status === 'onboarding' ||
      !row.phone_verified;
    const roleNeverConfirmed = !lastMenuRole;

    if (awaitingActivation || roleNeverConfirmed) {
      role = 'guest';
    }
  } else if (role === 'executor' && !executorKind) {
    role = 'guest';
  }

  if (!isModerator && role !== 'executor') {
    executorKind = undefined;
  }

  const verifiedAt = parseTimestamp(row.verified_at);
  const subscriptionExpiresAt = parseTimestamp(row.sub_expires_at);
  const isVerified = verifyStatus === 'active' || executor.isVerified;
  const hasActiveOrder = Boolean(row.has_active_order);
  let activeExecutorPlan: AuthExecutorPlan | undefined;

  if (phone) {
    try {
      const plan = await findActiveExecutorPlanByPhone(phone);
      if (plan) {
        activeExecutorPlan = mapExecutorPlan(plan);
      }
    } catch (error) {
      logger.error({ err: error, telegramId }, 'Failed to load active executor plan for user');
    }
  }

  if (activeExecutorPlan?.status === 'active') {
    executor.hasActiveSubscription = true;
  }

  return {
    user: {
      telegramId,
      username: normaliseString(row.username),
      firstName: normaliseString(row.first_name),
      lastName: normaliseString(row.last_name),
      phone,
      phoneVerified: Boolean(row.phone_verified),
      role,
      executorKind,
      status,
      verifyStatus,
      subscriptionStatus,
      isVerified,
      isBlocked: Boolean(row.is_blocked),
      citySelected: isAppCity(row.city_selected)
        ? row.city_selected
        : undefined,
      verifiedAt,
      subscriptionExpiresAt,
      activeExecutorPlan,
      hasActiveOrder,
      lastMenuRole,
      keyboardNonce: normaliseString(row.keyboard_nonce),
    },
    executor,
    isModerator,
  } satisfies AuthState;
};

const loadAuthState = async (
  from: NonNullable<BotContext['from']>,
): Promise<AuthState> => {
  let includeCitySelected: boolean;
  try {
    includeCitySelected = await hasUsersCitySelectedColumn();
  } catch (error) {
    throw new AuthStateQueryError('Failed to resolve auth query metadata', { cause: error });
  }

  const authQuery = buildAuthQuery(includeCitySelected);

  let rows: AuthQueryRow[];
  try {
    ({ rows } = await pool.query<AuthQueryRow>(authQuery, [
      from.id,
      from.username ?? null,
      from.first_name ?? null,
      from.last_name ?? null,
    ]));
  } catch (error) {
    throw new AuthStateQueryError('Failed to query authentication state', { cause: error });
  }

  const [row] = rows;
  if (!row) {
    throw new Error('Failed to load authentication context');
  }

  return mapAuthRow(row);
};

const createGuestAuthState = (from: NonNullable<BotContext['from']>): AuthState => ({
  user: {
    telegramId: from.id,
    username: from.username ?? undefined,
    firstName: from.first_name ?? undefined,
    lastName: from.last_name ?? undefined,
    phone: undefined,
    phoneVerified: false,
    role: 'guest',
    executorKind: undefined,
    status: 'guest',
    verifyStatus: 'none',
    subscriptionStatus: 'none',
    isVerified: false,
    isBlocked: false,
    subscriptionExpiresAt: undefined,
    activeExecutorPlan: undefined,
    hasActiveOrder: false,
    lastMenuRole: undefined,
    keyboardNonce: undefined,
  },
  executor: {
    verifiedRoles: { courier: false, driver: false },
    hasActiveSubscription: false,
    isVerified: false,
  },
  isModerator: false,
});

const applyAuthState = (
  ctx: BotContext,
  authState: AuthState,
  options?: {
    isAuthenticated?: boolean;
    isStale?: boolean;
    safeMode?: boolean;
    isDegraded?: boolean;
  },
): void => {
  ctx.auth = authState;
  ctx.session.isAuthenticated = options?.isAuthenticated ?? true;
  ctx.session.safeMode = options?.safeMode ?? false;
  ctx.session.isDegraded = options?.isDegraded ?? false;
  if (!ctx.session.safeMode) {
    ctx.session.safeModeReason = undefined;
    ctx.session.safeModePrompt = undefined;
  }
  ctx.session.user = {
    id: authState.user.telegramId,
    username: authState.user.username,
    firstName: authState.user.firstName,
    lastName: authState.user.lastName,
    phoneVerified: authState.user.phoneVerified,
  };
  if (authState.user.phone && !ctx.session.phoneNumber) {
    ctx.session.phoneNumber = authState.user.phone;
  }
  if (authState.user.citySelected && !ctx.session.city) {
    ctx.session.city = authState.user.citySelected;
  }

  ctx.session.authSnapshot = {
    role: authState.user.role,
    executorKind: authState.user.executorKind,
    status: authState.user.status,
    phoneVerified: authState.user.phoneVerified,
    verifyStatus: authState.user.verifyStatus,
    subscriptionStatus: authState.user.subscriptionStatus,
    userIsVerified: authState.user.isVerified,
    executor: cloneExecutorState(authState.executor),
    isModerator: authState.isModerator,
    subscriptionExpiresAt: authState.user.subscriptionExpiresAt,
    executorPlan: authState.user.activeExecutorPlan,
    city: authState.user.citySelected,
    hasActiveOrder: authState.user.hasActiveOrder,
    stale: options?.isStale ?? false,
  } satisfies AuthStateSnapshot;
};

type ChatWithType = Nullable<{ type?: string }>;

const isChannelChat = (chat: ChatWithType): boolean => chat?.type === 'channel';

const hasChannelSender = (sender: ChatWithType): boolean => sender?.type === 'channel';

const isChannelUpdate = (ctx: BotContext): boolean => {
  const update = ctx.update as {
    channel_post?: { chat?: { type?: string } };
    edited_channel_post?: { chat?: { type?: string } };
    message?: { chat?: { type?: string }; sender_chat?: { type?: string } };
    edited_message?: { chat?: { type?: string }; sender_chat?: { type?: string } };
  };

  if ('channel_post' in update) {
    return true;
  }

  if ('edited_channel_post' in update) {
    return true;
  }

  if (update.message?.sender_chat?.type === 'channel') {
    return true;
  }

  if (update.edited_message?.sender_chat?.type === 'channel') {
    return true;
  }

  if (isChannelChat(ctx.chat)) {
    return true;
  }

  if (ctx.channelPost && isChannelChat(ctx.channelPost.chat)) {
    return true;
  }

  if (hasChannelSender(ctx.senderChat)) {
    return true;
  }

  if (
    isChannelChat(update.channel_post?.chat) ||
    isChannelChat(update.edited_channel_post?.chat)
  ) {
    return true;
  }

  if (
    hasChannelSender(update.message?.sender_chat) ||
    hasChannelSender(update.edited_message?.sender_chat)
  ) {
    return true;
  }

  if (isChannelChat(update.message?.chat) || isChannelChat(update.edited_message?.chat)) {
    return true;
  }

  return false;
};

export const auth = (): MiddlewareFn<BotContext> => async (ctx, next) => {
  if (!ctx.from) {
    if (isChannelUpdate(ctx)) {
      await next();
      return;
    }

    logger.warn({ update: ctx.update }, 'Received update without sender information');
    return;
  }

  try {
    const authState = await loadAuthState(ctx.from);
    applyAuthState(ctx, authState, { isStale: false, isDegraded: false });
  } catch (error) {
    if (error instanceof AuthStateQueryError) {
      const cachedSnapshot = ctx.session.authSnapshot;

      if (cachedSnapshot) {
        const snapshotIsModerator = cachedSnapshot.isModerator === true;
        const snapshot: AuthStateSnapshot = {
          role: cachedSnapshot.role,
          executorKind: cachedSnapshot.executorKind,
          status: cachedSnapshot.status
            ?? deriveSnapshotStatus(cachedSnapshot.role, { isModerator: snapshotIsModerator }),
          phoneVerified: cachedSnapshot.phoneVerified,
          verifyStatus: cachedSnapshot.verifyStatus,
          subscriptionStatus: cachedSnapshot.subscriptionStatus ?? 'none',
          userIsVerified: cachedSnapshot.userIsVerified,
          executor: cloneExecutorState(cachedSnapshot.executor),
          isModerator: snapshotIsModerator,
          subscriptionExpiresAt: cachedSnapshot.subscriptionExpiresAt,
          executorPlan: cloneAuthExecutorPlan(cachedSnapshot.executorPlan),
          city: cachedSnapshot.city,
          hasActiveOrder: cachedSnapshot.hasActiveOrder ?? false,
          stale: true,
        } satisfies AuthStateSnapshot;

        const authState = buildAuthStateFromSnapshot(ctx, snapshot);
        authState.user.status = 'safe_mode';
        applyAuthState(ctx, authState, {
          isAuthenticated: false,
          isStale: true,
          safeMode: true,
          isDegraded: true,
        });
      } else {
        const guestState = createGuestAuthState(ctx.from!);
        guestState.user.status = 'safe_mode';
        applyAuthState(ctx, guestState, {
          isAuthenticated: false,
          isStale: true,
          safeMode: true,
          isDegraded: true,
        });
      }

      await enterSafeMode(ctx, { reason: 'auth-state-query-failed' });
      logger.warn(
        { err: error.cause ?? error, update: ctx.update },
        'Failed to load auth state, using cached snapshot',
      );
      await next();
      return;
    }

    await enterSafeMode(ctx, { reason: 'auth-state-unexpected-error' });
    logger.error({ err: error, update: ctx.update }, 'Failed to authenticate update');
    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery(copy.serviceUnavailable, { show_alert: false });
      } catch (answerError) {
        logger.debug({ err: answerError }, 'Failed to answer callback query after auth failure');
      }
    }

    if (ctx.chat?.type === 'private') {
      try {
        await ctx.reply(copy.serviceUnavailable);
      } catch (replyError) {
        logger.debug({ err: replyError }, 'Failed to notify user about auth failure');
      }
    }
    return;
  }

  await next();
};

export const loadAuthStateByTelegramId = async (telegramId: number): Promise<AuthState> => {
  const from = { id: telegramId } as NonNullable<BotContext['from']>;
  return loadAuthState(from);
};

export const __testing__ = {
  loadAuthState,
  mapAuthRow,
  buildExecutorState,
  normaliseRole,
};
