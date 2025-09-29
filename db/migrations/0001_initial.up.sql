BEGIN;

/* ---------- EXTENSIONS ---------- */
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

/* ---------- ENUM TYPES ---------- */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('client', 'courier', 'driver', 'moderator');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_kind') THEN
    CREATE TYPE order_kind AS ENUM ('taxi', 'delivery');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status') THEN
    CREATE TYPE order_status AS ENUM ('open', 'claimed', 'cancelled', 'done');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
    CREATE TYPE subscription_status AS ENUM ('pending', 'active', 'rejected', 'expired');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'verification_status') THEN
    CREATE TYPE verification_status AS ENUM ('pending', 'active', 'rejected', 'expired');
  END IF;
END $$;

/* ---------- SEQUENCES ---------- */
CREATE SEQUENCE IF NOT EXISTS orders_short_id_seq START WITH 1;
CREATE SEQUENCE IF NOT EXISTS support_thread_short_id_seq START WITH 1;

/* ---------- CORE TABLES ---------- */
CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY        DEFAULT gen_random_uuid(),
  tg_id            BIGINT       UNIQUE     NOT NULL,               -- telegram user id
  role             user_role    NOT NULL   DEFAULT 'client',
  phone            TEXT         UNIQUE,
  phone_verified   BOOLEAN      NOT NULL   DEFAULT FALSE,
  first_name       TEXT,
  last_name        TEXT,
  username         TEXT,
  city             TEXT,
  consent          BOOLEAN      NOT NULL   DEFAULT FALSE,
  status           TEXT         NOT NULL   DEFAULT 'guest',
  is_verified      BOOLEAN      NOT NULL   DEFAULT FALSE,
  is_blocked       BOOLEAN      NOT NULL   DEFAULT FALSE,
  verified_at      TIMESTAMPTZ,
  trial_ends_at    TIMESTAMPTZ,
  last_menu_role   TEXT,
  keyboard_nonce   TEXT,
  city_selected    TEXT,
  created_at       TIMESTAMPTZ  NOT NULL   DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_tg_id_role ON users (tg_id, role);

--------------------------------------------------------------------
/* Clean up stale FK if an old migration created it incorrectly */
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints
    WHERE  constraint_name = 'sessions_scope_id_fkey'
    AND    table_name = 'sessions'
  ) THEN
    ALTER TABLE sessions DROP CONSTRAINT sessions_scope_id_fkey;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sessions (
  scope            TEXT        NOT NULL,
  scope_id         BIGINT      NOT NULL,
  state            JSONB       NOT NULL  DEFAULT '{}'::jsonb,
  flow_state       TEXT,
  flow_payload     JSONB,
  last_step_at     TIMESTAMPTZ,
  nudge_sent_at    TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_scope_id ON sessions (scope_id);
CREATE INDEX IF NOT EXISTS sessions_scope_state_idx ON sessions (scope, scope_id);

--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recent_actions (
  user_id          BIGINT      NOT NULL,
  key              TEXT        NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_recent_actions_expires_at ON recent_actions (expires_at);

--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                 BIGSERIAL PRIMARY KEY,
  short_id           TEXT        NOT NULL DEFAULT (
                      'ORD-' || LPAD(nextval('orders_short_id_seq')::TEXT, 5, '0')
                    ),
  kind               order_kind      NOT NULL,
  status             order_status    NOT NULL DEFAULT 'open',
  client_id          BIGINT          REFERENCES users(tg_id),
  client_phone       TEXT,
  recipient_phone    TEXT,
  customer_name      TEXT,
  customer_username  TEXT,
  client_comment     TEXT,
  pickup_query       TEXT        NOT NULL,
  pickup_address     TEXT        NOT NULL,
  pickup_lat         DOUBLE PRECISION NOT NULL,
  pickup_lon         DOUBLE PRECISION NOT NULL,
  pickup_2gis_url    TEXT,
  dropoff_query      TEXT        NOT NULL,
  dropoff_address    TEXT        NOT NULL,
  dropoff_lat        DOUBLE PRECISION NOT NULL,
  dropoff_lon        DOUBLE PRECISION NOT NULL,
  dropoff_2gis_url   TEXT,
  dropoff_apartment  TEXT,
  dropoff_entrance   TEXT,
  dropoff_floor      TEXT,
  is_private_house   BOOLEAN,
  city               TEXT        NOT NULL,
  price_amount       NUMERIC(12,2) NOT NULL,
  price_currency     TEXT        NOT NULL,
  distance_km        NUMERIC(10,2) NOT NULL,
  claimed_by         BIGINT          REFERENCES users(tg_id),
  claimed_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  channel_message_id BIGINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (short_id)
);

ALTER SEQUENCE orders_short_id_seq OWNED BY orders.short_id;

CREATE INDEX IF NOT EXISTS idx_orders_status       ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_client_id    ON orders (client_id);
CREATE INDEX IF NOT EXISTS idx_orders_claimed_by   ON orders (claimed_by);

--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id                 BIGSERIAL PRIMARY KEY,
  short_id           TEXT        UNIQUE,
  user_id            BIGINT      NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  chat_id            BIGINT      NOT NULL,
  plan               TEXT        NOT NULL DEFAULT 'manual',
  tier               TEXT,
  status             subscription_status NOT NULL DEFAULT 'pending',
  currency           TEXT,
  amount             NUMERIC(12,2),
  interval           TEXT        NOT NULL DEFAULT 'day',
  interval_count     INT         NOT NULL DEFAULT 1,
  days               INT,
  next_billing_at    TIMESTAMPTZ,
  grace_until        TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN  NOT NULL DEFAULT FALSE,
  cancelled_at       TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  metadata           JSONB,
  last_warning_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_chat ON subscriptions (user_id, chat_id);

--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                   BIGSERIAL PRIMARY KEY,
  subscription_id      BIGINT      REFERENCES subscriptions(id) ON DELETE SET NULL,
  user_id              BIGINT      NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  amount               NUMERIC(12,2) NOT NULL,
  currency             TEXT        NOT NULL,
  status               TEXT        NOT NULL,
  payment_provider     TEXT        NOT NULL,
  provider_payment_id  TEXT,
  provider_customer_id TEXT,
  invoice_url          TEXT,
  receipt_url          TEXT,
  period_start         TIMESTAMPTZ,
  period_end           TIMESTAMPTZ,
  paid_at              TIMESTAMPTZ,
  days                 INT,
  file_id              TEXT,
  metadata             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verifications (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT      NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  role             TEXT        NOT NULL,
  status           verification_status  NOT NULL DEFAULT 'pending',
  photos_required  INT         NOT NULL DEFAULT 0,
  photos_uploaded  INT         NOT NULL DEFAULT 0,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_verifications_user_role ON verifications (user_id, role);

--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS callback_map (
  token        TEXT        PRIMARY KEY,
  action       TEXT        NOT NULL,
  chat_id      BIGINT,
  message_id   BIGINT,
  payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_callback_map_action ON callback_map (action, expires_at);

--------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_threads (
  id                   TEXT        PRIMARY KEY,
  short_id             TEXT        NOT NULL DEFAULT (
                          'SUP-' || LPAD(nextval('support_thread_short_id_seq')::TEXT, 4, '0')
                        ),
  user_chat_id         BIGINT      NOT NULL,
  user_tg_id           BIGINT,
  user_message_id      BIGINT      NOT NULL,
  moderator_chat_id    BIGINT      NOT NULL,
  moderator_message_id BIGINT      NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'open',
  closed_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (short_id)
);

ALTER SEQUENCE support_thread_short_id_seq OWNED BY support_threads.short_id;

CREATE INDEX IF NOT EXISTS idx_support_threads_status ON support_threads (status);

--------------------------------------------------------------------
/* Джорнэл FSM-событий (для отладки / аналитики) */
CREATE TABLE IF NOT EXISTS fsm_journal (
  id          BIGSERIAL PRIMARY KEY,
  scope       TEXT        NOT NULL,
  scope_id    TEXT        NOT NULL,
  from_state  TEXT,
  to_state    TEXT,
  step_id     TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fsm_journal_scope ON fsm_journal (scope, scope_id);

--------------------------------------------------------------------
/* Вьюхи «Мои заказы» для клиента и курьера */
DROP VIEW IF EXISTS v_client_orders;
DROP VIEW IF EXISTS v_executor_orders;

CREATE VIEW v_client_orders AS
SELECT o.*, u.username AS executor_username
FROM   orders o
LEFT   JOIN users u ON u.tg_id = o.claimed_by;

CREATE VIEW v_executor_orders AS
SELECT o.*, u.username AS client_username
FROM   orders o
LEFT   JOIN users u ON u.tg_id = o.client_id;

/* ---------- INITIAL DATA ---------- */
INSERT INTO users (tg_id, role, phone_verified, phone, status, is_verified)
VALUES
  (0, 'moderator', true, '+70000000000', 'active_client', true)
ON CONFLICT (tg_id) DO NOTHING;

COMMIT;
