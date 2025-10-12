--
-- PostgreSQL database dump
--

\restrict adnKAgKfRCgork3Ju7ayaB4uWJq6pAemqejTHWHjEASQqQULh3KnvANAQzfjqyp

-- Dumped from database version 16.10 (Ubuntu 16.10-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.10 (Ubuntu 16.10-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: executor_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.executor_kind AS ENUM (
    'courier',
    'driver'
);


--
-- Name: order_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_kind AS ENUM (
    'taxi',
    'delivery'
);


--
-- Name: order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_status AS ENUM (
    'new',
    'open',
    'claimed',
    'in_progress',
    'cancelled',
    'finished',
    'expired'
);


--
-- Name: subscription_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.subscription_status AS ENUM (
    'pending',
    'active',
    'rejected',
    'expired'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'guest',
    'client',
    'executor',
    'moderator'
);


--
-- Name: user_subscription_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_subscription_status AS ENUM (
    'none',
    'active',
    'grace',
    'expired'
);


--
-- Name: user_verify_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_verify_status AS ENUM (
    'none',
    'pending',
    'active',
    'rejected',
    'expired'
);


--
-- Name: verification_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.verification_status AS ENUM (
    'pending',
    'active',
    'rejected',
    'expired'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: callback_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.callback_map (
    token text NOT NULL,
    action text NOT NULL,
    chat_id bigint,
    message_id bigint,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channels (
    id integer NOT NULL,
    tg_id bigint,
    title text,
    username text,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    verify_channel_id bigint,
    drivers_channel_id bigint,
    stats_channel_id bigint,
    bound_chat_id bigint,
    type text,
    CONSTRAINT channels_type_check CHECK ((type = ANY (ARRAY['orders'::text, 'drivers'::text, 'moderators'::text])))
);


--
-- Name: COLUMN channels.bound_chat_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channels.bound_chat_id IS 'id чата, к которому привязан бот';


--
-- Name: channels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: channels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.channels_id_seq OWNED BY public.channels.id;


--
-- Name: executor_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.executor_blocks (
    id bigint NOT NULL,
    phone text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: executor_blocks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.executor_blocks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: executor_blocks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.executor_blocks_id_seq OWNED BY public.executor_blocks.id;


--
-- Name: executor_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.executor_plans (
    id bigint NOT NULL,
    chat_id bigint NOT NULL,
    thread_id integer,
    phone text NOT NULL,
    nickname text,
    plan_choice text NOT NULL,
    start_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    comment text,
    status text DEFAULT 'active'::text NOT NULL,
    muted boolean DEFAULT false NOT NULL,
    reminder_index integer DEFAULT 0 NOT NULL,
    reminder_last_sent timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    card_message_id integer,
    card_chat_id bigint,
    CONSTRAINT executor_plans_plan_choice_check CHECK ((plan_choice = ANY (ARRAY['trial'::text, '7'::text, '15'::text, '30'::text]))),
    CONSTRAINT executor_plans_status_check CHECK ((status = ANY (ARRAY['active'::text, 'blocked'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: executor_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.executor_plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: executor_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.executor_plans_id_seq OWNED BY public.executor_plans.id;


--
-- Name: fsm_journal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fsm_journal (
    id bigint NOT NULL,
    scope text NOT NULL,
    scope_id text NOT NULL,
    from_state text,
    to_state text,
    step_id text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fsm_journal_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fsm_journal_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fsm_journal_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fsm_journal_id_seq OWNED BY public.fsm_journal.id;


--
-- Name: migration_0009_user_status_backup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migration_0009_user_status_backup (
    tg_id bigint NOT NULL,
    previous_status text NOT NULL
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id bigint NOT NULL,
    short_id text NOT NULL,
    kind public.order_kind NOT NULL,
    status public.order_status DEFAULT 'new'::public.order_status NOT NULL,
    client_id bigint,
    client_phone text,
    recipient_phone text,
    customer_name text,
    customer_username text,
    client_comment text,
    pickup_query text NOT NULL,
    pickup_address text NOT NULL,
    pickup_lat double precision NOT NULL,
    pickup_lon double precision NOT NULL,
    pickup_2gis_url text,
    dropoff_query text NOT NULL,
    dropoff_address text NOT NULL,
    dropoff_lat double precision NOT NULL,
    dropoff_lon double precision NOT NULL,
    dropoff_2gis_url text,
    dropoff_apartment text,
    dropoff_entrance text,
    dropoff_floor text,
    is_private_house boolean,
    city text NOT NULL,
    price_amount numeric(12,2) NOT NULL,
    price_currency text NOT NULL,
    distance_km numeric(10,2) NOT NULL,
    claimed_by bigint,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    channel_message_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.orders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.orders_id_seq OWNED BY public.orders.id;


--
-- Name: orders_short_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.orders_short_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: orders_short_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.orders_short_id_seq OWNED BY public.orders.short_id;


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id bigint NOT NULL,
    subscription_id bigint,
    user_id bigint NOT NULL,
    amount numeric(12,2) NOT NULL,
    currency text NOT NULL,
    status text NOT NULL,
    payment_provider text NOT NULL,
    provider_payment_id text,
    provider_customer_id text,
    invoice_url text,
    receipt_url text,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    paid_at timestamp with time zone,
    days integer,
    file_id text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payments_id_seq OWNED BY public.payments.id;


--
-- Name: recent_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recent_actions (
    user_id bigint NOT NULL,
    key text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    scope text NOT NULL,
    scope_id bigint NOT NULL,
    state jsonb DEFAULT '{}'::jsonb NOT NULL,
    flow_state text,
    flow_payload jsonb,
    last_step_at timestamp with time zone,
    nudge_sent_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    safe_mode boolean DEFAULT false NOT NULL,
    is_degraded boolean DEFAULT false NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id bigint NOT NULL,
    short_id text,
    user_id bigint NOT NULL,
    chat_id bigint NOT NULL,
    plan text DEFAULT 'manual'::text NOT NULL,
    tier text,
    status public.subscription_status DEFAULT 'pending'::public.subscription_status NOT NULL,
    currency text,
    amount numeric(12,2),
    "interval" text DEFAULT 'day'::text NOT NULL,
    interval_count integer DEFAULT 1 NOT NULL,
    days integer,
    next_billing_at timestamp with time zone,
    grace_until timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    cancelled_at timestamp with time zone,
    ended_at timestamp with time zone,
    metadata jsonb,
    last_warning_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscriptions_id_seq OWNED BY public.subscriptions.id;


--
-- Name: support_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_threads (
    id text NOT NULL,
    short_id text NOT NULL,
    user_chat_id bigint NOT NULL,
    user_tg_id bigint,
    user_message_id bigint NOT NULL,
    moderator_chat_id bigint NOT NULL,
    moderator_message_id bigint NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_thread_short_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_thread_short_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_thread_short_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_thread_short_id_seq OWNED BY public.support_threads.short_id;


--
-- Name: ui_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ui_events (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    experiment text,
    variant text,
    event text NOT NULL,
    target text NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ui_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ui_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ui_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ui_events_id_seq OWNED BY public.ui_events.id;


--
-- Name: user_experiments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_experiments (
    user_id bigint NOT NULL,
    experiment text NOT NULL,
    variant text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_recent_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_recent_locations (
    user_id bigint NOT NULL,
    lat double precision,
    lon double precision,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    city text NOT NULL,
    kind text NOT NULL,
    location_id text NOT NULL,
    query text NOT NULL,
    address text NOT NULL,
    two_gis_url text,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tg_id bigint NOT NULL,
    role public.user_role DEFAULT 'client'::public.user_role NOT NULL,
    phone text,
    phone_verified boolean DEFAULT false NOT NULL,
    first_name text,
    last_name text,
    username text,
    city text,
    consent boolean DEFAULT false NOT NULL,
    status text DEFAULT 'guest'::text NOT NULL,
    is_blocked boolean DEFAULT false NOT NULL,
    verified_at timestamp with time zone,
    last_menu_role text,
    keyboard_nonce text,
    city_selected text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    executor_kind public.executor_kind,
    verify_status public.user_verify_status DEFAULT 'none'::public.user_verify_status NOT NULL,
    sub_status public.user_subscription_status DEFAULT 'none'::public.user_subscription_status NOT NULL,
    sub_expires_at timestamp with time zone,
    has_active_order boolean DEFAULT false NOT NULL
);


--
-- Name: v_client_orders; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_client_orders AS
 SELECT o.id,
    o.short_id,
    o.kind,
    o.status,
    o.client_id,
    o.client_phone,
    o.recipient_phone,
    o.customer_name,
    o.customer_username,
    o.client_comment,
    o.pickup_query,
    o.pickup_address,
    o.pickup_lat,
    o.pickup_lon,
    o.pickup_2gis_url,
    o.dropoff_query,
    o.dropoff_address,
    o.dropoff_lat,
    o.dropoff_lon,
    o.dropoff_2gis_url,
    o.dropoff_apartment,
    o.dropoff_entrance,
    o.dropoff_floor,
    o.is_private_house,
    o.city,
    o.price_amount,
    o.price_currency,
    o.distance_km,
    o.claimed_by,
    o.claimed_at,
    o.completed_at,
    o.channel_message_id,
    o.created_at,
    o.updated_at,
    u.username AS executor_username
   FROM (public.orders o
     LEFT JOIN public.users u ON ((u.tg_id = o.claimed_by)));


--
-- Name: v_executor_orders; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_executor_orders AS
 SELECT o.id,
    o.short_id,
    o.kind,
    o.status,
    o.client_id,
    o.client_phone,
    o.recipient_phone,
    o.customer_name,
    o.customer_username,
    o.client_comment,
    o.pickup_query,
    o.pickup_address,
    o.pickup_lat,
    o.pickup_lon,
    o.pickup_2gis_url,
    o.dropoff_query,
    o.dropoff_address,
    o.dropoff_lat,
    o.dropoff_lon,
    o.dropoff_2gis_url,
    o.dropoff_apartment,
    o.dropoff_entrance,
    o.dropoff_floor,
    o.is_private_house,
    o.city,
    o.price_amount,
    o.price_currency,
    o.distance_km,
    o.claimed_by,
    o.claimed_at,
    o.completed_at,
    o.channel_message_id,
    o.created_at,
    o.updated_at,
    u.username AS client_username
   FROM (public.orders o
     LEFT JOIN public.users u ON ((u.tg_id = o.client_id)));


--
-- Name: verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verifications (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    role text NOT NULL,
    status public.verification_status DEFAULT 'pending'::public.verification_status NOT NULL,
    photos_required integer DEFAULT 0 NOT NULL,
    photos_uploaded integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: verifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.verifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: verifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.verifications_id_seq OWNED BY public.verifications.id;


--
-- Name: channels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels ALTER COLUMN id SET DEFAULT nextval('public.channels_id_seq'::regclass);


--
-- Name: executor_blocks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.executor_blocks ALTER COLUMN id SET DEFAULT nextval('public.executor_blocks_id_seq'::regclass);


--
-- Name: executor_plans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.executor_plans ALTER COLUMN id SET DEFAULT nextval('public.executor_plans_id_seq'::regclass);


--
-- Name: fsm_journal id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsm_journal ALTER COLUMN id SET DEFAULT nextval('public.fsm_journal_id_seq'::regclass);


--
-- Name: orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders ALTER COLUMN id SET DEFAULT nextval('public.orders_id_seq'::regclass);


--
-- Name: orders short_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders ALTER COLUMN short_id SET DEFAULT ('ORD-'::text || lpad((nextval('public.orders_short_id_seq'::regclass))::text, 5, '0'::text));


--
-- Name: payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments ALTER COLUMN id SET DEFAULT nextval('public.payments_id_seq'::regclass);


--
-- Name: subscriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions ALTER COLUMN id SET DEFAULT nextval('public.subscriptions_id_seq'::regclass);


--
-- Name: support_threads short_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_threads ALTER COLUMN short_id SET DEFAULT ('SUP-'::text || lpad((nextval('public.support_thread_short_id_seq'::regclass))::text, 4, '0'::text));


--
-- Name: ui_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ui_events ALTER COLUMN id SET DEFAULT nextval('public.ui_events_id_seq'::regclass);


--
-- Name: verifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verifications ALTER COLUMN id SET DEFAULT nextval('public.verifications_id_seq'::regclass);


--
-- Name: callback_map callback_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.callback_map
    ADD CONSTRAINT callback_map_pkey PRIMARY KEY (token);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: channels channels_tg_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_tg_id_key UNIQUE (tg_id);


--
-- Name: executor_blocks executor_blocks_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.executor_blocks
    ADD CONSTRAINT executor_blocks_phone_key UNIQUE (phone);


--
-- Name: executor_blocks executor_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.executor_blocks
    ADD CONSTRAINT executor_blocks_pkey PRIMARY KEY (id);


--
-- Name: executor_plans executor_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.executor_plans
    ADD CONSTRAINT executor_plans_pkey PRIMARY KEY (id);


--
-- Name: fsm_journal fsm_journal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsm_journal
    ADD CONSTRAINT fsm_journal_pkey PRIMARY KEY (id);


--
-- Name: migration_0009_user_status_backup migration_0009_user_status_backup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migration_0009_user_status_backup
    ADD CONSTRAINT migration_0009_user_status_backup_pkey PRIMARY KEY (tg_id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: orders orders_short_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_short_id_key UNIQUE (short_id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: recent_actions recent_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recent_actions
    ADD CONSTRAINT recent_actions_pkey PRIMARY KEY (user_id, key);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (scope, scope_id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_short_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_short_id_key UNIQUE (short_id);


--
-- Name: support_threads support_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_threads
    ADD CONSTRAINT support_threads_pkey PRIMARY KEY (id);


--
-- Name: support_threads support_threads_short_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_threads
    ADD CONSTRAINT support_threads_short_id_key UNIQUE (short_id);


--
-- Name: ui_events ui_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ui_events
    ADD CONSTRAINT ui_events_pkey PRIMARY KEY (id);


--
-- Name: user_experiments user_experiments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_experiments
    ADD CONSTRAINT user_experiments_pkey PRIMARY KEY (user_id, experiment);


--
-- Name: user_recent_locations user_recent_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_recent_locations
    ADD CONSTRAINT user_recent_locations_pkey PRIMARY KEY (user_id, city, kind, location_id);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_tg_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_tg_id_key UNIQUE (tg_id);


--
-- Name: verifications verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verifications
    ADD CONSTRAINT verifications_pkey PRIMARY KEY (id);


--
-- Name: executor_plans_chat_thread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX executor_plans_chat_thread_idx ON public.executor_plans USING btree (chat_id, thread_id);


--
-- Name: executor_plans_ends_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX executor_plans_ends_idx ON public.executor_plans USING btree (ends_at);


--
-- Name: executor_plans_start_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX executor_plans_start_idx ON public.executor_plans USING btree (start_at);


--
-- Name: executor_plans_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX executor_plans_status_idx ON public.executor_plans USING btree (status);


--
-- Name: idx_callback_map_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_callback_map_action ON public.callback_map USING btree (action, expires_at);


--
-- Name: idx_channels_tg_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channels_tg_id ON public.channels USING btree (tg_id);


--
-- Name: idx_fsm_journal_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fsm_journal_scope ON public.fsm_journal USING btree (scope, scope_id);


--
-- Name: idx_orders_claimed_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_claimed_by ON public.orders USING btree (claimed_by);

--
-- Name: orders_active_by_executor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_active_by_executor_idx ON public.orders USING btree (claimed_by) WHERE ((status = ANY (ARRAY['claimed'::public.order_status, 'in_progress'::public.order_status])));


--
-- Name: idx_orders_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_client_id ON public.orders USING btree (client_id);


--
-- Name: idx_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_status ON public.orders USING btree (status);


--
-- Name: idx_recent_actions_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recent_actions_expires_at ON public.recent_actions USING btree (expires_at);


--
-- Name: idx_sessions_scope_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_scope_id ON public.sessions USING btree (scope_id);


--
-- Name: idx_subscriptions_user_chat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_user_chat ON public.subscriptions USING btree (user_id, chat_id);


--
-- Name: idx_support_threads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_threads_status ON public.support_threads USING btree (status);


--
-- Name: idx_ui_events_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ui_events_event ON public.ui_events USING btree (event);


--
-- Name: idx_ui_events_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ui_events_user ON public.ui_events USING btree (user_id);


--
-- Name: idx_user_experiments_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_experiments_user ON public.user_experiments USING btree (user_id);


--
-- Name: idx_user_recent_locations_last_used_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_recent_locations_last_used_at ON public.user_recent_locations USING btree (user_id, city, kind, last_used_at DESC);


--
-- Name: idx_user_recent_locations_user_city_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_recent_locations_user_city_kind ON public.user_recent_locations USING btree (user_id, city, kind);


--
-- Name: idx_users_tg_id_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_tg_id_role ON public.users USING btree (tg_id, role);


--
-- Name: idx_verifications_user_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verifications_user_role ON public.verifications USING btree (user_id, role);


--
-- Name: sessions_scope_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_scope_state_idx ON public.sessions USING btree (scope, scope_id);


--
-- Name: orders orders_claimed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES public.users(tg_id) ON DELETE SET NULL;


--
-- Name: orders orders_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.users(tg_id) ON DELETE SET NULL;


--
-- Name: payments payments_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- Name: payments payments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(tg_id) ON DELETE CASCADE;


--
-- Name: recent_actions recent_actions_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recent_actions
    ADD CONSTRAINT recent_actions_user_fk FOREIGN KEY (user_id) REFERENCES public.users(tg_id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(tg_id) ON DELETE CASCADE;


--
-- Name: ui_events ui_events_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ui_events
    ADD CONSTRAINT ui_events_user_fk FOREIGN KEY (user_id) REFERENCES public.users(tg_id) ON DELETE CASCADE;


--
-- Name: user_experiments user_experiments_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_experiments
    ADD CONSTRAINT user_experiments_user_fk FOREIGN KEY (user_id) REFERENCES public.users(tg_id) ON DELETE CASCADE;


--
-- Name: user_recent_locations user_recent_locations_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_recent_locations
    ADD CONSTRAINT user_recent_locations_user_fk FOREIGN KEY (user_id) REFERENCES public.users(tg_id) ON DELETE CASCADE;


--
-- Name: verifications verifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verifications
    ADD CONSTRAINT verifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(tg_id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict adnKAgKfRCgork3Ju7ayaB4uWJq6pAemqejTHWHjEASQqQULh3KnvANAQzfjqyp

