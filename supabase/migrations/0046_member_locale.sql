-- 0046_member_locale.sql
-- Denormalize the tenant's locale onto family_members so every reply path has
-- the user's language without an extra lookup. The onboarding wizard keeps both
-- in sync. Idempotent.

alter table family_members add column if not exists locale text not null default 'ru'
  check (locale in ('uk', 'ru', 'pl', 'en'));

-- Backfill from the tenant's chosen locale.
update family_members fm
set locale = t.locale
from tenants t
where fm.tenant_id = t.id and fm.locale is distinct from t.locale;
