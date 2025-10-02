ALTER TABLE users
  DROP COLUMN IF EXISTS trial_started_at,
  DROP COLUMN IF EXISTS trial_expires_at;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'user_subscription_status'
  ) THEN
    ALTER TYPE user_subscription_status
      ADD VALUE IF NOT EXISTS 'trial';

    UPDATE users
    SET sub_status = 'active'
    WHERE sub_status = 'trial';

    ALTER TYPE user_subscription_status RENAME TO user_subscription_status_old;

    CREATE TYPE user_subscription_status AS ENUM ('none', 'active', 'grace', 'expired');

    ALTER TABLE users
      ALTER COLUMN sub_status DROP DEFAULT;

    ALTER TABLE users
      ALTER COLUMN sub_status TYPE user_subscription_status
      USING sub_status::text::user_subscription_status;

    ALTER TABLE users
      ALTER COLUMN sub_status SET DEFAULT 'none';

    DROP TYPE user_subscription_status_old;
  END IF;
END
$$;
