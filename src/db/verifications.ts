import { pool, withTx } from './client';
import type { PoolClient } from './client';
import type { ExecutorKind } from '../bot/types';

export type VerificationRole = ExecutorKind;

export interface VerificationApplicant {
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export interface VerificationSubmissionPayload {
  applicant: VerificationApplicant;
  role: VerificationRole;
  photosRequired: number;
  photosUploaded: number;
}

export interface VerificationDecisionPayload {
  applicant: VerificationApplicant;
  role: VerificationRole;
  expiresAt?: Date | string | number | null;
}

type VerificationStatus = 'pending' | 'active' | 'rejected' | 'expired';

const parseNumeric = (value: string | number | null | undefined): number | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'number') {
    return value;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const normalisePhotoCount = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
};

const normaliseExpiration = (
  value: Date | string | number | null | undefined,
): Date | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const upsertVerificationApplicant = async (
  client: PoolClient,
  applicant: VerificationApplicant,
  role: VerificationRole,
): Promise<number> => {
  await client.query(
    `
      INSERT INTO users (
        tg_id,
        username,
        first_name,
        last_name,
        phone,
        role,
        executor_kind,
        status,
        last_menu_role,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'executor', $6::executor_kind, $7, $8, now())
      ON CONFLICT (tg_id) DO UPDATE
      SET
        username = COALESCE(EXCLUDED.username, users.username),
        first_name = COALESCE(EXCLUDED.first_name, users.first_name),
        last_name = COALESCE(EXCLUDED.last_name, users.last_name),
        phone = COALESCE(EXCLUDED.phone, users.phone),
        role = CASE WHEN users.role = 'moderator' THEN users.role ELSE 'executor' END,
        executor_kind = CASE
          WHEN users.role = 'moderator' THEN users.executor_kind
          ELSE EXCLUDED.executor_kind
        END,
        status = CASE
          WHEN users.status IN ('suspended', 'banned') THEN users.status
          ELSE COALESCE(EXCLUDED.status, users.status)
        END,
        last_menu_role = COALESCE(EXCLUDED.last_menu_role, users.last_menu_role),
        updated_at = now()
    `,
    [
      applicant.telegramId,
      applicant.username ?? null,
      applicant.firstName ?? null,
      applicant.lastName ?? null,
      applicant.phone ?? null,
      role,
      'active_executor',
      'courier',
    ],
  );

  return applicant.telegramId;
};

const lockLatestVerificationId = async (
  client: PoolClient,
  telegramId: number,
  role: VerificationRole,
): Promise<number | null> => {
  const { rows } = await client.query<{ id: string | number }>(
    `
      SELECT id
      FROM verifications
      WHERE user_id = $1 AND role = $2
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `,
    [telegramId, role],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  const verificationId = parseNumeric(row.id);
  if (verificationId === undefined) {
    throw new Error(`Failed to parse verification id (${row.id})`);
  }

  return verificationId;
};

const upsertVerificationRecord = async (
  client: PoolClient,
  telegramId: number,
  payload: VerificationSubmissionPayload,
): Promise<void> => {
  const verificationId = await lockLatestVerificationId(
    client,
    telegramId,
    payload.role,
  );
  const photosRequired = normalisePhotoCount(payload.photosRequired);
  const photosUploaded = normalisePhotoCount(payload.photosUploaded);

  if (verificationId !== null) {
    await client.query(
      `
        UPDATE verifications
        SET
          status = 'pending',
          photos_required = $2,
          photos_uploaded = $3,
          expires_at = NULL,
          updated_at = now()
        WHERE id = $1
      `,
      [verificationId, photosRequired, photosUploaded],
    );
    return;
  }

  await client.query(
    `
      INSERT INTO verifications (
        user_id,
        role,
        status,
        photos_required,
        photos_uploaded,
        expires_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, 'pending', $3, $4, NULL, now(), now())
    `,
    [telegramId, payload.role, photosRequired, photosUploaded],
  );
};

const updateVerificationStatus = async (
  client: PoolClient,
  telegramId: number,
  role: VerificationRole,
  status: VerificationStatus,
  expiresAt: Date | null,
): Promise<void> => {
  const verificationId = await lockLatestVerificationId(client, telegramId, role);

  if (verificationId !== null) {
    await client.query(
      `
        UPDATE verifications
        SET
          status = $2,
          expires_at = $3,
          updated_at = now()
        WHERE id = $1
      `,
      [verificationId, status, expiresAt],
    );
  } else {
    await client.query(
      `
        INSERT INTO verifications (
          user_id,
          role,
          status,
          photos_required,
          photos_uploaded,
          expires_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, 0, 0, $4, now(), now())
      `,
      [telegramId, role, status, expiresAt],
    );
  }
};

const applyVerificationDecision = async (
  status: Exclude<VerificationStatus, 'pending'>,
  payload: VerificationDecisionPayload,
): Promise<void> => {
  await withTx(async (client) => {
    const telegramId = await upsertVerificationApplicant(
      client,
      payload.applicant,
      payload.role,
    );
    const expiresAt = status === 'active'
      ? normaliseExpiration(payload.expiresAt)
      : null;

    await updateVerificationStatus(client, telegramId, payload.role, status, expiresAt);

    await client.query(
      `
        UPDATE users
        SET verify_status = $2,
            verified_at = CASE WHEN $2 = 'active' THEN now() ELSE verified_at END,
            trial_started_at = CASE
              WHEN $2 = 'active' AND trial_started_at IS NULL THEN now()
              ELSE trial_started_at
            END,
            updated_at = now()
        WHERE tg_id = $1
      `,
      [telegramId, status],
    );
  });
};

export const persistVerificationSubmission = async (
  payload: VerificationSubmissionPayload,
): Promise<void> => {
  await withTx(async (client) => {
    const telegramId = await upsertVerificationApplicant(
      client,
      payload.applicant,
      payload.role,
    );
    await upsertVerificationRecord(client, telegramId, payload);
    await client.query(
      `
        UPDATE users
        SET verify_status = CASE
              WHEN verify_status = 'active' THEN verify_status
              ELSE 'pending'
            END,
            updated_at = now()
        WHERE tg_id = $1
      `,
      [telegramId],
    );
  });
};

export const markVerificationApproved = async (
  payload: VerificationDecisionPayload,
): Promise<void> => {
  await applyVerificationDecision('active', payload);
};

export const markVerificationRejected = async (
  payload: VerificationDecisionPayload,
): Promise<void> => {
  await applyVerificationDecision('rejected', payload);
};

interface VerificationExistsRow {
  is_verified: boolean;
}

export const isExecutorVerified = async (
  telegramId: number,
  role: VerificationRole,
): Promise<boolean> => {
  const { rows } = await pool.query<VerificationExistsRow>(
    `
      SELECT (u.verify_status = 'active')
        OR EXISTS (
          SELECT 1
          FROM verifications v
          WHERE v.user_id = u.tg_id
            AND v.role = $2
            AND v.status = 'active'
            AND (v.expires_at IS NULL OR v.expires_at > now())
        ) AS is_verified
      FROM users u
      WHERE u.tg_id = $1
      LIMIT 1
    `,
    [telegramId, role],
  );

  const [row] = rows;
  return row?.is_verified ?? false;
};
