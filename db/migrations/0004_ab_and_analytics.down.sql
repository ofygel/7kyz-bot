-- Revert AB experiment and analytics schema additions

DROP INDEX IF EXISTS idx_ui_events_event;
DROP INDEX IF EXISTS idx_ui_events_user;
DROP INDEX IF EXISTS idx_user_experiments_user;

ALTER TABLE users
  DROP COLUMN IF EXISTS city_selected;

ALTER TABLE subscriptions
  DROP COLUMN IF EXISTS short_id;

ALTER TABLE channels
  DROP COLUMN IF EXISTS stats_channel_id,
  DROP COLUMN IF EXISTS drivers_channel_id,
  DROP COLUMN IF EXISTS verify_channel_id;

DROP TABLE IF EXISTS schema_migrations;
DROP TABLE IF EXISTS user_recent_locations;
DROP TABLE IF EXISTS ui_events;
DROP TABLE IF EXISTS user_experiments;
