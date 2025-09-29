BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

UPDATE users
SET is_verified = CASE verify_status WHEN 'active' THEN TRUE ELSE FALSE END;

UPDATE users
SET trial_ends_at = trial_expires_at
WHERE trial_expires_at IS NOT NULL;

UPDATE users
SET role = CASE
  WHEN role = 'executor' AND executor_kind = 'courier' THEN 'courier'
  WHEN role = 'executor' AND executor_kind = 'driver' THEN 'driver'
  ELSE role
END;

ALTER TABLE users
  DROP COLUMN IF EXISTS executor_kind,
  DROP COLUMN IF EXISTS verify_status,
  DROP COLUMN IF EXISTS trial_started_at,
  DROP COLUMN IF EXISTS trial_expires_at;

DROP TYPE IF EXISTS user_verify_status;
DROP TYPE IF EXISTS executor_kind;

COMMIT;
