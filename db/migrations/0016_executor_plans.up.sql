CREATE TABLE IF NOT EXISTS executor_plans (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  thread_id INTEGER,
  phone TEXT NOT NULL,
  nickname TEXT,
  plan_choice TEXT NOT NULL CHECK (plan_choice IN ('7','15','30')),
  start_at TIMESTAMPTZ NOT NULL,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','completed','cancelled')),
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_index INTEGER NOT NULL DEFAULT 0,
  reminder_last_sent TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS executor_blocks (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (phone)
);

CREATE INDEX IF NOT EXISTS executor_plans_chat_thread_idx
  ON executor_plans (chat_id, thread_id);

CREATE INDEX IF NOT EXISTS executor_plans_status_idx
  ON executor_plans (status);

CREATE INDEX IF NOT EXISTS executor_plans_start_idx
  ON executor_plans (start_at);
