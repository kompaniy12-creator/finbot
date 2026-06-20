-- 0043_envelope_encryption.sql
-- Envelope encryption (KEK/DEK) for sensitive fields (P0.2).
--
-- KEK (master key) lives in Supabase Vault (secret 'finbot_kek_v1'), never in a
-- data table and never in git. Each tenant gets its own 256-bit DEK, stored
-- wrapped (encrypted by the KEK). Sensitive fields are encrypted with the
-- tenant's DEK (format "v2:<key_id>:<iv>:<ct>:<tag>"). Benefits: KEK rotation
-- re-wraps only DEKs; per-tenant DEK rotation re-encrypts only that tenant;
-- deleting a tenant's DEK crypto-shreds its data.
--
-- Idempotent.

create table if not exists tenant_deks (
  tenant_id uuid not null references tenants(id) on delete cascade,
  key_id text not null,
  wrapped_dek text not null, -- DEK encrypted by the KEK: "<iv>:<ct>:<tag>" (base64)
  algo text not null default 'aes-256-gcm',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, key_id)
);

create index if not exists tenant_deks_active_idx on tenant_deks (tenant_id) where active;

alter table tenant_deks enable row level security;
alter table tenant_deks force row level security;
drop policy if exists tenant_isolation on tenant_deks;
create policy tenant_isolation on tenant_deks for all to public
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Read a Vault secret by name. SECURITY DEFINER so the Edge runtime (service
-- role) can fetch the KEK via PostgREST RPC without exposing the vault schema.
-- Locked down: only service_role may execute it.
create or replace function get_kek(p_name text)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name
$$;

revoke all on function get_kek(text) from public, anon, authenticated;
grant execute on function get_kek(text) to service_role;
