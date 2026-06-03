-- Web sessions for desktop browser access (magic-link flow).
--
-- Flow:
--   1. User runs /web in the bot.
--   2. Bot inserts a row with magic_token + magic_expires_at (5 min).
--      session_token is NULL until the link is consumed.
--   3. User opens https://<webapp>/?magic=<token> in a browser. Frontend
--      POSTs to api-web-exchange which:
--        - finds the row by magic_token,
--        - checks magic_expires_at > now and magic_consumed_at IS NULL,
--        - sets session_token + session_expires_at + magic_consumed_at,
--        - returns the session token to the browser.
--   4. Browser stores the session token in localStorage and sends it as
--      Authorization: Bearer <token> on every subsequent api-* call.
--   5. On 401, the browser shows "ссылка истекла, попроси новую через /web".
--
-- Tokens are 64-hex (32 bytes). Magic is one-time (5 min). Session lives 24h
-- by default and last_used_at bumps on each call so we can later add idle
-- timeout cleanup.

create table if not exists web_sessions (
  id uuid primary key default uuid_generate_v4(),
  family_member_id uuid not null references family_members(id),
  -- The one-time link token in the magic URL. Cleared after exchange so the
  -- same row can't be exchanged twice.
  magic_token text unique,
  magic_expires_at timestamptz,
  magic_consumed_at timestamptz,
  -- The durable session token returned to the browser after exchange.
  session_token text unique,
  session_expires_at timestamptz,
  last_used_at timestamptz,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists web_sessions_magic_idx on web_sessions (magic_token)
  where magic_token is not null;
create index if not exists web_sessions_token_idx on web_sessions (session_token)
  where session_token is not null;
create index if not exists web_sessions_member_idx on web_sessions (family_member_id, created_at desc);

alter table web_sessions disable row level security;
