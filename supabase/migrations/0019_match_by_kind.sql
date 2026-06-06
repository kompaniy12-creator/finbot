-- kNN matcher must respect kind so an "expense" query never returns an
-- "income" embedding (and vice versa). Default kind_filter='expense' keeps
-- every existing caller working unchanged.
--
-- Drop first: 0033 later renames the second parameter (family_id -> tenant).
-- On every-deploy replay this migration runs before 0033 against a DB that
-- already has the tenant-named version, and "create or replace" cannot rename
-- a parameter (42P13). Dropping first avoids that conflict; 0033 then drops and
-- recreates the tenant version, so the final state is identical either way.
drop function if exists match_expenses(vector, uuid, float, int, text);

create or replace function match_expenses(
  query_embedding vector(384),
  family_id uuid,
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
    and e.family_member_id in (
      select fm.id from family_members fm
      where fm.id = family_id or fm.role = 'admin'
    )
    and c.is_fallback = false
    and 1 - (e.embedding <=> query_embedding) > match_threshold
  order by e.embedding <=> query_embedding
  limit match_count;
$$;
