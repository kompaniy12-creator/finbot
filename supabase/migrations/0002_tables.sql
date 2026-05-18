-- 0002_tables.sql
-- FinBot v6 SPEC §4.2
-- Shared-org safety: only creates FinBot tables (whitelist). NEVER touches:
-- payouts, photos, promotions, referrals, transactions, users, withdrawals.
-- All CREATE TABLE statements use IF NOT EXISTS for idempotency.

create table if not exists family_members (
  id uuid primary key default uuid_generate_v4(),
  telegram_id bigint unique not null,
  username text,
  name text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists categories (
  id uuid primary key default uuid_generate_v4(),
  name text unique not null,
  description text,
  examples text,
  parent_id uuid references categories(id) on delete set null,
  usage_count integer not null default 0,
  is_fallback boolean not null default false,
  embedding vector(384),
  centroid_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists receipts (
  id uuid primary key default uuid_generate_v4(),
  merchant text,
  receipt_date date not null,
  currency text not null check (currency in ('PLN', 'EUR', 'ALL', 'USD')),
  total numeric(12, 2) not null,
  total_pln numeric(12, 2) not null,
  photo_path text,
  photo_purged_at timestamptz,
  raw_ocr jsonb,
  items jsonb,
  family_member_id uuid not null references family_members(id),
  telegram_message_id bigint,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists expenses (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  name_normalized text,
  expense_date date not null,
  amount numeric(12, 2) not null,
  currency text not null check (currency in ('PLN', 'EUR', 'ALL', 'USD')),
  amount_pln numeric(12, 2) not null,
  category_id uuid not null references categories(id),
  family_member_id uuid not null references family_members(id),
  source text not null check (source in ('voice', 'photo', 'text')),
  description text,
  receipt_id uuid references receipts(id) on delete set null,
  confidence numeric(3, 2) not null default 1.0,
  needs_review boolean not null default false,
  needs_confirmation boolean not null default false,
  archived boolean not null default false,
  corrected_by_user boolean not null default false,
  embedding vector(384),
  telegram_message_id bigint,
  line_index integer not null default 0,
  created_at timestamptz not null default now(),
  constraint expenses_idempotency unique nulls not distinct
    (telegram_message_id, family_member_id, line_index)
);

create table if not exists message_log (
  telegram_message_id bigint not null,
  family_member_id uuid not null references family_members(id),
  status text not null check (status in ('processing', 'done', 'error', 'awaiting_confirmation')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (telegram_message_id, family_member_id)
);

create table if not exists expense_audit (
  id uuid primary key default uuid_generate_v4(),
  expense_id uuid not null references expenses(id) on delete cascade,
  action text not null check (action in ('insert', 'update', 'archive', 'recategorize')),
  before_state jsonb,
  after_state jsonb,
  actor_telegram_id bigint,
  source text,
  created_at timestamptz not null default now()
);

create table if not exists exchange_rates (
  rate_date date not null,
  currency text not null,
  rate_pln numeric(12, 6) not null,
  source text not null,
  is_fallback boolean not null default false,
  fallback_from_date date,
  fetched_at timestamptz not null default now(),
  primary key (rate_date, currency)
);

create table if not exists recurring_expenses (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  amount numeric(12, 2) not null,
  currency text not null,
  category_id uuid not null references categories(id),
  family_member_id uuid not null references family_members(id),
  day_of_month integer not null check (day_of_month between 1 and 31),
  active boolean not null default true,
  last_charged_date date,
  created_at timestamptz not null default now()
);

create table if not exists anthropic_usage (
  id bigserial primary key,
  date date not null,
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd numeric(10, 6) not null,
  family_member_id uuid references family_members(id),
  created_at timestamptz not null default now()
);

create table if not exists media_group_buffer (
  media_group_id text not null,
  telegram_message_id bigint not null,
  family_member_id uuid not null references family_members(id),
  file_id text not null,
  received_at timestamptz not null default now(),
  primary key (media_group_id, telegram_message_id)
);

create table if not exists pending_retry (
  id bigserial primary key,
  telegram_message_id bigint not null,
  family_member_id uuid not null references family_members(id),
  payload jsonb not null,
  payload_type text not null check (payload_type in ('text', 'voice', 'photo')),
  attempt_count integer not null default 0,
  last_error text,
  next_retry_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists system_health (
  id integer primary key default 1,
  last_seen timestamptz not null default now(),
  bot_version text,
  backup_key_confirmed boolean not null default false,
  constraint single_row check (id = 1)
);
insert into system_health (id) values (1) on conflict do nothing;
