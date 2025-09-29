BEGIN;

ALTER TABLE users
  DROP COLUMN IF EXISTS has_active_order,
  DROP COLUMN IF EXISTS sub_expires_at,
  DROP COLUMN IF EXISTS sub_status,
  DROP COLUMN IF EXISTS trial_expires_at,
  DROP COLUMN IF EXISTS trial_started_at,
  DROP COLUMN IF EXISTS verify_status,
  DROP COLUMN IF EXISTS executor_kind;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_subscription_status') THEN
    DROP TYPE user_subscription_status;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_verify_status') THEN
    DROP TYPE user_verify_status;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'executor_kind') THEN
    DROP TYPE executor_kind;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    ALTER TYPE user_role RENAME TO user_role_new;

    CREATE TYPE user_role AS ENUM ('client', 'courier', 'driver', 'moderator');

    ALTER TABLE users
      ALTER COLUMN role DROP DEFAULT,
      ALTER COLUMN role TYPE user_role USING (
        CASE role::text
          WHEN 'executor' THEN 'client'
          WHEN 'guest' THEN 'guest'
          WHEN 'client' THEN 'client'
          WHEN 'moderator' THEN 'moderator'
          ELSE 'guest'
        END
      )::user_role,
      ALTER COLUMN role SET DEFAULT 'client';

    DROP TYPE user_role_new;
  END IF;
END $$;

COMMIT;
