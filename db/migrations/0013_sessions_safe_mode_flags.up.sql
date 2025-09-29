BEGIN;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS safe_mode BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_degraded BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE sessions
SET safe_mode = CASE
    WHEN state ? 'safeMode' THEN COALESCE((state ->> 'safeMode')::BOOLEAN, false)
    ELSE false
  END
WHERE safe_mode IS DISTINCT FROM CASE
    WHEN state ? 'safeMode' THEN COALESCE((state ->> 'safeMode')::BOOLEAN, false)
    ELSE false
  END;

UPDATE sessions
SET is_degraded = CASE
    WHEN state ? 'isDegraded' THEN COALESCE((state ->> 'isDegraded')::BOOLEAN, false)
    WHEN state ? 'degraded' THEN COALESCE((state ->> 'degraded')::BOOLEAN, false)
    ELSE false
  END
WHERE is_degraded IS DISTINCT FROM CASE
    WHEN state ? 'isDegraded' THEN COALESCE((state ->> 'isDegraded')::BOOLEAN, false)
    WHEN state ? 'degraded' THEN COALESCE((state ->> 'degraded')::BOOLEAN, false)
    ELSE false
  END;

COMMIT;
