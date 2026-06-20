-- 0044_security_audit.sql
-- Append-only audit log of security-sensitive operations (P1.2): key set/delete,
-- crypto-shred, webhook auth failures, access grants/revokes, exports, key
-- rotations. Stores only ids / kinds / counts - NEVER secrets or open financial
-- values (the app also scrubs `details` before insert).
--
-- Append-only is enforced at the DB: UPDATE/DELETE are revoked from every app
-- role (incl. service_role), so a compromised app cannot rewrite history. Only a
-- migration (table owner) could change it. Idempotent.

create table if not exists security_audit (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  actor_telegram_id bigint,
  tenant_id uuid,
  action text not null,
  result text not null default 'ok',
  correlation_id text,
  details jsonb
);

create index if not exists security_audit_ts_idx on security_audit (ts desc);
create index if not exists security_audit_tenant_idx on security_audit (tenant_id, ts desc);
create index if not exists security_audit_action_idx on security_audit (action, ts desc);

alter table security_audit enable row level security;
alter table security_audit force row level security;

-- Append-only: allow INSERT (+ SELECT for admin reads), forbid mutation.
revoke update, delete on security_audit from public, anon, authenticated, service_role;
