-- 0033_match_expenses_tenant.sql
-- Multi-tenancy: make the kNN matcher tenant-safe.
--
-- The old match_expenses (0019) filtered candidates by
--   e.family_member_id in (select fm.id from family_members
--                          where fm.id = family_id or fm.role = 'admin')
-- which, across tenants, leaks EVERY tenant's admin's expenses. Replace the
-- family_id parameter with a tenant uuid and filter on e.tenant_id.
--
-- Idempotent: drop the old signature, then create the new one. Drop the old
-- explicitly because changing a parameter name/type is not a "create or
-- replace" (Postgres treats it as a different function and would otherwise
-- leave the leaky overload in place).

-- Drop every prior overload: the 5-arg family_id version (0019) and the
-- original 4-arg family_id version (0004, the role='admin' leak). Both run
-- before this migration on replay, so dropping them here leaves only the
-- tenant-scoped version below.
drop function if exists match_expenses(vector, uuid, float, int, text);
drop function if exists match_expenses(vector, uuid, float, int);

create or replace function match_expenses(
  query_embedding vector(384),
  tenant uuid,
  match_threshold float default 0.7,
  match_count int default 5,
  kind_filter text default 'expense'
)
returns table (id uuid, name text, category_id uuid, similarity float)
language sql stable
as $$
  select
    e.id, e.name, e.category_id,
    1 - (e.embedding <=> query_embedding) as similarity
  from expenses e
  join categories c on c.id = e.category_id
  where e.archived = false
    and e.embedding is not null
    and e.kind = kind_filter
    and c.kind = kind_filter
    and e.tenant_id = tenant
    and c.is_fallback = false
    and 1 - (e.embedding <=> query_embedding) > match_threshold
  order by e.embedding <=> query_embedding
  limit match_count;
$$;
