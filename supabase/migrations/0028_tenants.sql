-- 0028_tenants.sql
-- Multi-tenancy phase 0: core tables only. Existing tables untouched here.
-- Additive and idempotent: every deploy re-runs all migrations, so all
-- statements use IF NOT EXISTS / ON CONFLICT.
--
-- A "tenant" is one workspace (one family). The legacy single family becomes
-- one tenant with a fixed sentinel id (see 0030). External users (via the
-- public SaaS bot) become additional tenants. Isolation is enforced in
-- application code (service role bypasses RLS), see _shared/tenant_db.ts.

create table if not exists tenants (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  mode text not null default 'saas' check (mode in ('family', 'saas')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  -- Per-tenant daily Claude/Groq spend cap in USD. NULL = use global default.
  anthropic_daily_budget_usd numeric(10, 2),
  created_at timestamptz not null default now()
);

-- Registry of Telegram bots feeding this project. Tokens themselves live in
-- Supabase secrets; this table stores only the SECRET NAMES, never the values.
create table if not exists bots (
  id uuid primary key default uuid_generate_v4(),
  telegram_bot_id bigint unique not null, -- numeric prefix of the bot token
  mode text not null check (mode in ('family', 'saas')),
  token_secret_name text not null, -- e.g. TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_TOKEN_SAAS
  webhook_secret_name text not null, -- e.g. TELEGRAM_WEBHOOK_SECRET / ..._SAAS
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Invite codes gate self-serve onboarding on the SaaS bot. A valid code,
-- redeemed via the redeem_invite RPC (0034), creates a new tenant + admin.
create table if not exists invite_codes (
  code text primary key,
  created_by_telegram_id bigint,
  tenant_id uuid references tenants(id), -- set when redeemed
  redeemed_by_telegram_id bigint,
  redeemed_at timestamptz,
  expires_at timestamptz,
  max_uses integer not null default 1,
  use_count integer not null default 0,
  created_at timestamptz not null default now()
);
