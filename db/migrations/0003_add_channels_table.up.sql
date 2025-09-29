BEGIN;

CREATE TABLE IF NOT EXISTS channels (
  id          SERIAL PRIMARY KEY,
  tg_id       BIGINT      UNIQUE,
  title       TEXT,
  username    TEXT,
  is_enabled  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channels_tg_id ON channels (tg_id);

COMMIT;
