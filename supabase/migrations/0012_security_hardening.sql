-- Security hardening: rate-limit counters + admin-action audit log.

-- Per-(telegram_id, kind, day) running counter. Cheap upsert on every
-- request; one row per user per kind per day. retention sweep eventually
-- removes old rows.
create table if not exists rate_limit (
  telegram_id bigint not null,
  kind text not null,
  day date not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (telegram_id, kind, day)
);
create index if not exists rate_limit_day_idx on rate_limit (day);

-- Atomic "increment and return new value" function used by the rate-limit
-- helper. Returns the count AFTER the increment.
create or replace function rate_limit_bump(
  p_telegram_id bigint,
  p_kind text,
  p_day date
) returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  insert into rate_limit (telegram_id, kind, day, count, updated_at)
  values (p_telegram_id, p_kind, p_day, 1, now())
  on conflict (telegram_id, kind, day)
  do update set count = rate_limit.count + 1, updated_at = now()
  returning rate_limit.count into v_count;
  return v_count;
end;
$$;

-- Admin-action audit log. expense_audit already tracks expenses; this one
-- captures category mutations, member grant/revoke/promote/demote, and any
-- other privileged operation outside the expenses table.
create table if not exists system_audit (
  id bigserial primary key,
  actor_telegram_id bigint not null,
  actor_family_member_id uuid references family_members(id),
  action text not null,
  target_id text,
  target_name text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists system_audit_actor_idx on system_audit (actor_telegram_id, created_at desc);
create index if not exists system_audit_action_idx on system_audit (action, created_at desc);

-- Disable RLS for these (service role only writes them; nothing anon).
alter table rate_limit disable row level security;
alter table system_audit disable row level security;
