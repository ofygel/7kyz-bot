ALTER TABLE users
  ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'user_subscription_status'
  ) THEN
    ALTER TYPE user_subscription_status RENAME TO user_subscription_status_new;

    CREATE TYPE user_subscription_status AS ENUM ('none', 'trial', 'active', 'grace', 'expired');

    ALTER TABLE users
      ALTER COLUMN sub_status TYPE user_subscription_status
      USING sub_status::text::user_subscription_status;

    ALTER TABLE users
      ALTER COLUMN sub_status SET DEFAULT 'none';

    DROP TYPE user_subscription_status_new;
  END IF;
END
$$;
