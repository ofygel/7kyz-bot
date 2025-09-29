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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_subscription_status') THEN
    CREATE TYPE user_subscription_status AS ENUM ('none', 'trial', 'active', 'grace', 'expired');
  END IF;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS executor_kind executor_kind,
  ADD COLUMN IF NOT EXISTS verify_status user_verify_status,
  ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sub_status user_subscription_status,
  ADD COLUMN IF NOT EXISTS sub_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS has_active_order BOOLEAN;

UPDATE users
SET executor_kind = CASE role::text
  WHEN 'courier' THEN 'courier'::executor_kind
  WHEN 'driver' THEN 'driver'::executor_kind
  ELSE executor_kind
END
WHERE role::text IN ('courier', 'driver');

ALTER TABLE users
  ALTER COLUMN verify_status SET DEFAULT 'none',
  ALTER COLUMN sub_status SET DEFAULT 'none',
  ALTER COLUMN has_active_order SET DEFAULT FALSE;

UPDATE users
SET verify_status = 'none'
WHERE verify_status IS NULL;

UPDATE users
SET sub_status = 'none'
WHERE sub_status IS NULL;

UPDATE users
SET has_active_order = FALSE
WHERE has_active_order IS NULL;

ALTER TABLE users
  ALTER COLUMN verify_status SET NOT NULL,
  ALTER COLUMN sub_status SET NOT NULL,
  ALTER COLUMN has_active_order SET NOT NULL;

DO $$
DECLARE
  needs_upgrade BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'user_role'
      AND e.enumlabel IN ('courier', 'driver')
  ) INTO needs_upgrade;

  IF needs_upgrade THEN
    ALTER TYPE user_role RENAME TO user_role_old;

    CREATE TYPE user_role AS ENUM ('guest', 'client', 'executor', 'moderator');

    ALTER TABLE users
      ALTER COLUMN role DROP DEFAULT,
      ALTER COLUMN role TYPE user_role USING (
        CASE role::text
          WHEN 'courier' THEN 'executor'
          WHEN 'driver' THEN 'executor'
          WHEN 'guest' THEN 'guest'
          WHEN 'client' THEN 'client'
          WHEN 'moderator' THEN 'moderator'
          WHEN 'executor' THEN 'executor'
          ELSE 'guest'
        END
      )::user_role;

    DROP TYPE user_role_old;
  END IF;
END $$;

ALTER TABLE users
  ALTER COLUMN role SET DEFAULT 'client';

COMMIT;
