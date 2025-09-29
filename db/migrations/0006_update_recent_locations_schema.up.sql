-- Revamp the recent locations storage to keep multiple entries per user and
-- align the schema with src/bot/services/recentLocations.ts expectations.

-- The old structure only kept the last location per user. The new schema tracks
-- multiple locations per city/kind pair, therefore we wipe the historical data
-- to avoid populating the new NOT NULL columns with bogus values.
DELETE FROM user_recent_locations;

ALTER TABLE user_recent_locations
  DROP CONSTRAINT IF EXISTS user_recent_locations_pkey,
  ALTER COLUMN lat TYPE DOUBLE PRECISION USING lat::DOUBLE PRECISION,
  ALTER COLUMN lon TYPE DOUBLE PRECISION USING lon::DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS kind TEXT,
  ADD COLUMN IF NOT EXISTS location_id TEXT,
  ADD COLUMN IF NOT EXISTS query TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS two_gis_url TEXT,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Enforce data integrity once the new columns exist.
ALTER TABLE user_recent_locations
  ALTER COLUMN city SET NOT NULL,
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN location_id SET NOT NULL,
  ALTER COLUMN query SET NOT NULL,
  ALTER COLUMN address SET NOT NULL;

ALTER TABLE user_recent_locations
  ADD PRIMARY KEY (user_id, city, kind, location_id);

CREATE INDEX IF NOT EXISTS idx_user_recent_locations_user_city_kind
  ON user_recent_locations (user_id, city, kind);

CREATE INDEX IF NOT EXISTS idx_user_recent_locations_last_used_at
  ON user_recent_locations (user_id, city, kind, last_used_at DESC);
