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
    CREATE TYPE user_subscription_status AS ENUM ('none', 'active', 'grace', 'expired');
  END IF;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS executor_kind executor_kind,
  ADD COLUMN IF NOT EXISTS verify_status user_verify_status NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS sub_status user_subscription_status NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS sub_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS has_active_order BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users
  ALTER COLUMN verify_status SET DEFAULT 'none',
  ALTER COLUMN sub_status SET DEFAULT 'none',
  ALTER COLUMN has_active_order SET DEFAULT FALSE;

ALTER TABLE users
  ALTER COLUMN verify_status SET NOT NULL,
  ALTER COLUMN sub_status SET NOT NULL,
  ALTER COLUMN has_active_order SET NOT NULL;

UPDATE users
SET executor_kind = CASE role::text
  WHEN 'courier' THEN 'courier'::executor_kind
  WHEN 'driver' THEN 'driver'::executor_kind
  ELSE executor_kind
END
WHERE role::text IN ('courier', 'driver')
  AND (executor_kind IS NULL OR executor_kind::text <> role::text);

DO $$
DECLARE
  has_legacy_roles BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'user_role'
      AND e.enumlabel IN ('courier', 'driver')
  ) INTO has_legacy_roles;

  IF has_legacy_roles THEN
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
      )::user_role,
      ALTER COLUMN role SET DEFAULT 'client';

    DROP TYPE user_role_old;
  ELSE
    ALTER TABLE users
      ALTER COLUMN role SET DEFAULT 'client';

    UPDATE users
    SET role = 'executor'::user_role
    WHERE role::text IN ('courier', 'driver');
  END IF;
END $$;

ALTER TABLE users
  DROP COLUMN IF EXISTS trial_ends_at,
  DROP COLUMN IF EXISTS is_verified;

COMMIT;
