BEGIN;

CREATE TABLE IF NOT EXISTS migration_0009_user_status_backup (
  tg_id           BIGINT PRIMARY KEY,
  previous_status TEXT      NOT NULL
);

INSERT INTO migration_0009_user_status_backup (tg_id, previous_status)
SELECT u.tg_id, u.status
FROM users u
WHERE u.phone_verified IS TRUE
  AND u.status IN ('guest', 'awaiting_phone')
ON CONFLICT (tg_id) DO NOTHING;

UPDATE users
SET status = 'active_client'
WHERE phone_verified IS TRUE
  AND status IN ('guest', 'awaiting_phone');

COMMIT;
