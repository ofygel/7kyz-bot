-- Add missing AB experiment and analytics tables along with related columns and indexes

CREATE TABLE IF NOT EXISTS user_experiments (
  user_id      BIGINT      NOT NULL,
  experiment   TEXT        NOT NULL,
  variant      TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, experiment)
);

CREATE TABLE IF NOT EXISTS ui_events (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      BIGINT      NOT NULL,
  experiment   TEXT,
  variant      TEXT,
  event        TEXT        NOT NULL,
  target       TEXT        NOT NULL,
  context      JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_recent_locations (
  user_id      BIGINT      NOT NULL PRIMARY KEY,
  lat          NUMERIC(9,6),
  lon          NUMERIC(9,6),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  file_name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS verify_channel_id  BIGINT,
  ADD COLUMN IF NOT EXISTS drivers_channel_id BIGINT,
  ADD COLUMN IF NOT EXISTS stats_channel_id   BIGINT;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS short_id TEXT UNIQUE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS city_selected TEXT;

CREATE INDEX IF NOT EXISTS idx_user_experiments_user ON user_experiments(user_id);
CREATE INDEX IF NOT EXISTS idx_ui_events_user        ON ui_events(user_id);
CREATE INDEX IF NOT EXISTS idx_ui_events_event       ON ui_events(event);
