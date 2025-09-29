BEGIN;

UPDATE users u
SET status = b.previous_status
FROM migration_0009_user_status_backup b
WHERE u.tg_id = b.tg_id
  AND u.status = 'active_client';

DROP TABLE IF EXISTS migration_0009_user_status_backup;

COMMIT;
