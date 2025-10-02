BEGIN;

DO $$
DECLARE
  needs_rollback BOOLEAN;
BEGIN
  SELECT NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'user_role'
      AND e.enumlabel IN ('courier', 'driver')
  ) INTO needs_rollback;

  IF needs_rollback THEN
    ALTER TYPE user_role RENAME TO user_role_new;

    CREATE TYPE user_role AS ENUM (
      'guest',
      'client',
      'courier',
      'driver',
      'moderator',
      'executor'
    );

    ALTER TABLE users
      ALTER COLUMN role DROP DEFAULT,
      ALTER COLUMN role TYPE user_role USING role::text::user_role;

    DROP TYPE user_role_new;
  END IF;
END $$;

UPDATE users
SET role = CASE
  WHEN role = 'executor'::user_role AND executor_kind::text = 'courier' THEN 'courier'::user_role
  WHEN role = 'executor'::user_role AND executor_kind::text = 'driver' THEN 'driver'::user_role
  ELSE role
END;

ALTER TABLE users
  ALTER COLUMN role SET DEFAULT 'client';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

ALTER TABLE users
  DROP COLUMN IF EXISTS has_active_order,
  DROP COLUMN IF EXISTS sub_expires_at,
  DROP COLUMN IF EXISTS sub_status,
  DROP COLUMN IF EXISTS verify_status,
  DROP COLUMN IF EXISTS executor_kind;

DROP TYPE IF EXISTS user_subscription_status;
DROP TYPE IF EXISTS user_verify_status;
DROP TYPE IF EXISTS executor_kind;

COMMIT;
