BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'executor_kind') THEN
    CREATE TYPE executor_kind AS ENUM ('courier', 'driver');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_verify_status') THEN
    CREATE TYPE user_verify_status AS ENUM ('none', 'pending', 'active', 'rejected', 'expired');
  END IF;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS executor_kind executor_kind,
  ADD COLUMN IF NOT EXISTS verify_status user_verify_status NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

UPDATE users
SET executor_kind = CASE role::text
  WHEN 'courier' THEN 'courier'::executor_kind
  WHEN 'driver' THEN 'driver'::executor_kind
  ELSE executor_kind
END
WHERE role::text IN ('courier', 'driver');

DO $$
DECLARE
  has_is_verified_column BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'is_verified'
  ) INTO has_is_verified_column;

  IF has_is_verified_column THEN
    WITH latest AS (
      SELECT DISTINCT ON (user_id) user_id, status
      FROM verifications
      ORDER BY user_id, updated_at DESC, id DESC
    )
    UPDATE users AS u
    SET verify_status = (
      CASE
        WHEN u.is_verified THEN 'active'
        WHEN latest.status IS NULL THEN 'none'
        WHEN latest.status = 'active' THEN 'active'
        WHEN latest.status = 'pending' THEN 'pending'
        WHEN latest.status = 'rejected' THEN 'rejected'
        WHEN latest.status = 'expired' THEN 'expired'
        ELSE 'none'
      END
    )::user_verify_status
    FROM latest
    WHERE u.tg_id = latest.user_id;

    UPDATE users
    SET verify_status = 'active'::user_verify_status
    WHERE verify_status = 'none' AND is_verified IS TRUE;
  ELSE
    WITH latest AS (
      SELECT DISTINCT ON (user_id) user_id, status
      FROM verifications
      ORDER BY user_id, updated_at DESC, id DESC
    )
    UPDATE users AS u
    SET verify_status = (
      CASE
        WHEN latest.status IS NULL THEN 'none'
        WHEN latest.status = 'active' THEN 'active'
        WHEN latest.status = 'pending' THEN 'pending'
        WHEN latest.status = 'rejected' THEN 'rejected'
        WHEN latest.status = 'expired' THEN 'expired'
        ELSE 'none'
      END
    )::user_verify_status
    FROM latest
    WHERE u.tg_id = latest.user_id;
  END IF;
END $$;

DO $$
DECLARE
  has_trial_ends_at BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'trial_ends_at'
  ) INTO has_trial_ends_at;

  IF has_trial_ends_at THEN
    UPDATE users
    SET trial_started_at = COALESCE(verified_at, trial_ends_at),
        trial_expires_at = trial_ends_at
    WHERE trial_ends_at IS NOT NULL;
  END IF;
END $$;

ALTER TYPE user_role RENAME TO user_role_old;

CREATE TYPE user_role AS ENUM ('guest', 'client', 'executor', 'moderator');

ALTER TABLE users
  ALTER COLUMN role DROP DEFAULT,
  ALTER COLUMN role TYPE user_role USING (
    CASE
      WHEN role::text IN ('courier', 'driver') THEN 'executor'
      WHEN role::text = 'guest' THEN 'guest'
      WHEN role::text = 'client' THEN 'client'
      WHEN role::text = 'moderator' THEN 'moderator'
      WHEN role::text = 'executor' THEN 'executor'
      ELSE 'guest'
    END
  )::user_role,
  ALTER COLUMN role SET DEFAULT 'client';

DROP TYPE user_role_old;

ALTER TABLE users
  DROP COLUMN IF EXISTS trial_ends_at,
  DROP COLUMN IF EXISTS is_verified;

COMMIT;
