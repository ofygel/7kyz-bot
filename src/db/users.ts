import crypto from 'crypto';

import { pool } from './client';
import type { PoolClient } from './client';
import type { ExecutorRole, UserStatus, UserSubscriptionStatus } from '../bot/types';

export interface EnsureClientRoleParams {
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

type ActiveUserStatuses = Extract<UserStatus, 'active_client' | 'active_executor' | 'safe_mode'>;

export interface UpdateUserRoleParams {
  telegramId: number;
  role: 'guest' | 'client' | 'executor';
  executorKind?: ExecutorRole | null;
  status?: ActiveUserStatuses;
  menuRole?: 'client' | 'courier';
}

export interface SetUserBlockedStatusParams {
  telegramId: number;
  isBlocked: boolean;
}

export interface UpdateUserSubscriptionStatusParams {
  telegramId: number;
  client?: PoolClient;
  subscriptionStatus?: UserSubscriptionStatus;
  subscriptionExpiresAt?: Date | null;
  hasActiveOrder?: boolean | null;
  status?: UserStatus;
  updatedAt?: Date;
}

export const ensureClientRole = async ({
  telegramId,
  username,
  firstName,
  lastName,
  phone,
}: EnsureClientRoleParams): Promise<string> => {
  const keyboardNonce = generateKeyboardNonce();

  const result = await pool.query(
    `
      INSERT INTO users (
        tg_id,
        username,
        first_name,
        last_name,
        phone,
        phone_verified,
        role,
        status,
        last_menu_role,
        keyboard_nonce,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      ON CONFLICT (tg_id) DO UPDATE
      SET
        username = COALESCE(EXCLUDED.username, users.username),
        first_name = COALESCE(EXCLUDED.first_name, users.first_name),
        last_name = COALESCE(EXCLUDED.last_name, users.last_name),
        phone = COALESCE(EXCLUDED.phone, users.phone),
        phone_verified = CASE
          WHEN EXCLUDED.phone IS NOT NULL THEN true
          ELSE users.phone_verified
        END,
        role = CASE
          WHEN users.role = 'moderator' THEN users.role
          ELSE EXCLUDED.role
        END,
        status = CASE
          WHEN users.status IN ('suspended', 'banned', 'safe_mode') THEN users.status
          ELSE 'active_client'
        END,
        executor_kind = CASE
          WHEN users.role = 'moderator' THEN users.executor_kind
          ELSE NULL
        END,
        last_menu_role = 'client',
        keyboard_nonce = COALESCE(users.keyboard_nonce, EXCLUDED.keyboard_nonce),
        updated_at = now()
      RETURNING keyboard_nonce
    `,
    [
      telegramId,
      username ?? null,
      firstName ?? null,
      lastName ?? null,
      phone ?? null,
      phone ? true : false,
      'client',
      'active_client',
      'client',
      keyboardNonce,
    ],
  );

  const persistedKeyboardNonce = result.rows[0]?.keyboard_nonce;

  if (typeof persistedKeyboardNonce !== 'string') {
    throw new Error('Failed to resolve keyboard nonce for client role');
  }

  return persistedKeyboardNonce;
};

export interface UpdateUserPhoneParams {
  telegramId: number;
  phone: string;
}

const generateKeyboardNonce = (): string => crypto.randomBytes(12).toString('base64url');

export const updateUserPhone = async ({
  telegramId,
  phone,
}: UpdateUserPhoneParams): Promise<void> => {
  const keyboardNonce = generateKeyboardNonce();

  await pool.query(
    `
      UPDATE users
      SET
        phone = $2,
        phone_verified = true,
        status = CASE
          WHEN status IN ('suspended', 'banned', 'safe_mode') THEN status
          ELSE 'active_client'
        END,
        keyboard_nonce = COALESCE(keyboard_nonce, $3),
        updated_at = now()
      WHERE tg_id = $1
    `,
    [telegramId, phone, keyboardNonce],
  );
};

export const updateUserRole = async ({
  telegramId,
  role,
  executorKind,
  status,
  menuRole,
}: UpdateUserRoleParams): Promise<void> => {
  const effectiveStatus = status
    ?? (role === 'client'
      ? 'active_client'
      : role === 'executor'
        ? 'active_executor'
        : 'guest');
  const effectiveMenuRole = menuRole
    ?? (role === 'client' ? 'client' : role === 'executor' ? 'courier' : 'client');
  const resolvedExecutorKind = role === 'executor' ? executorKind ?? null : null;

  await pool.query(
    `
      UPDATE users
      SET
        role = CASE
          WHEN users.role = 'moderator' THEN users.role
          ELSE $2
        END,
        executor_kind = CASE
          WHEN users.role = 'moderator' THEN users.executor_kind
          WHEN $2 = 'executor' THEN $5::executor_kind
          ELSE NULL
        END,
        status = CASE
          WHEN status IN ('suspended', 'banned', 'safe_mode') THEN status
          ELSE $3
        END,
        last_menu_role = $4,
        updated_at = now()
      WHERE tg_id = $1
    `,
    [telegramId, role, effectiveStatus, effectiveMenuRole, resolvedExecutorKind],
  );
};

export const setUserBlockedStatus = async ({
  telegramId,
  isBlocked,
}: SetUserBlockedStatusParams): Promise<void> => {
  await pool.query(
    `
      UPDATE users
      SET
        is_blocked = $2,
        updated_at = now()
      WHERE tg_id = $1
    `,
    [telegramId, isBlocked],
  );
};

export const updateUserSubscriptionStatus = async ({
  telegramId,
  client,
  subscriptionStatus,
  subscriptionExpiresAt,
  hasActiveOrder,
  status,
  updatedAt,
}: UpdateUserSubscriptionStatusParams): Promise<void> => {
  const assignments: string[] = [];
  const values: unknown[] = [telegramId];
  let index = 2;

  if (subscriptionStatus !== undefined) {
    assignments.push(`sub_status = $${index}::user_subscription_status`);
    values.push(subscriptionStatus);
    index += 1;
  }

  if (subscriptionExpiresAt !== undefined) {
    assignments.push(`sub_expires_at = $${index}`);
    values.push(subscriptionExpiresAt);
    index += 1;
  }

  if (hasActiveOrder !== undefined) {
    assignments.push(`has_active_order = $${index}`);
    values.push(hasActiveOrder);
    index += 1;
  }

  if (status !== undefined) {
    assignments.push(
      `status = CASE WHEN status IN ('suspended', 'banned') THEN status ELSE $${index} END`,
    );
    values.push(status);
    index += 1;
  }

  if (assignments.length === 0) {
    return;
  }

  const effectiveUpdatedAt = updatedAt ?? new Date();
  assignments.push(`updated_at = $${index}`);
  values.push(effectiveUpdatedAt);

  const executor = client ?? pool;
  await executor.query(
    `
      UPDATE users
      SET ${assignments.join(',\n          ')}
      WHERE tg_id = $1
    `,
    values,
  );
};
