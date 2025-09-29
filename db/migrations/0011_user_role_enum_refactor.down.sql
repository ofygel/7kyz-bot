BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

UPDATE users
SET is_verified = CASE verify_status WHEN 'active' THEN TRUE ELSE FALSE END;

UPDATE users
SET trial_ends_at = trial_expires_at
WHERE trial_expires_at IS NOT NULL;

ALTER TYPE user_role RENAME TO user_role_new;

CREATE TYPE user_role AS ENUM ('client', 'courier', 'driver', 'moderator');

ALTER TABLE users
  ALTER COLUMN role DROP DEFAULT,
  ALTER COLUMN role TYPE user_role USING (
    CASE
      WHEN role::text = 'executor' AND executor_kind = 'courier' THEN 'courier'
      WHEN role::text = 'executor' AND executor_kind = 'driver' THEN 'driver'
      WHEN role::text = 'executor' THEN 'client'
      WHEN role::text = 'guest' THEN 'guest'
      WHEN role::text = 'client' THEN 'client'
      WHEN role::text = 'moderator' THEN 'moderator'
      ELSE 'guest'
    END
  )::user_role,
  ALTER COLUMN role SET DEFAULT 'client';

DROP TYPE user_role_new;

ALTER TABLE users
  DROP COLUMN IF EXISTS executor_kind,
  DROP COLUMN IF EXISTS verify_status,
  DROP COLUMN IF EXISTS trial_started_at,
  DROP COLUMN IF EXISTS trial_expires_at;

DROP TYPE IF EXISTS user_verify_status;
DROP TYPE IF EXISTS executor_kind;

COMMIT;
