-- Roll back the recent locations schema revamp.

DROP INDEX IF EXISTS idx_user_recent_locations_last_used_at;
DROP INDEX IF EXISTS idx_user_recent_locations_user_city_kind;

ALTER TABLE user_recent_locations
  DROP CONSTRAINT IF EXISTS user_recent_locations_pkey,
  ALTER COLUMN lat TYPE NUMERIC(9,6) USING lat::NUMERIC(9,6),
  ALTER COLUMN lon TYPE NUMERIC(9,6) USING lon::NUMERIC(9,6),
  DROP COLUMN IF EXISTS city,
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS location_id,
  DROP COLUMN IF EXISTS query,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS two_gis_url,
  DROP COLUMN IF EXISTS last_used_at;

ALTER TABLE user_recent_locations
  ADD PRIMARY KEY (user_id);
