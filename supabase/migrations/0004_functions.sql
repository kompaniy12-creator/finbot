-- 0004_functions.sql
-- FinBot v6 SPEC §4.4
-- kNN matcher + audit trigger.

create or replace function match_expenses(
  query_embedding vector(384),
  family_id uuid,
  match_threshold float default 0.7,
  match_count int default 5
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
    and e.family_member_id in (
      select fm.id from family_members fm
      where fm.id = family_id or fm.role = 'admin'
    )
    and c.is_fallback = false
    and 1 - (e.embedding <=> query_embedding) > match_threshold
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function log_expense_audit() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into expense_audit (expense_id, action, after_state, source)
    values (new.id, 'insert', to_jsonb(new), new.source);
  elsif tg_op = 'UPDATE' then
    if old.archived = false and new.archived = true then
      insert into expense_audit (expense_id, action, before_state, after_state)
      values (new.id, 'archive', to_jsonb(old), to_jsonb(new));
    elsif old.category_id is distinct from new.category_id then
      insert into expense_audit (expense_id, action, before_state, after_state)
      values (new.id, 'recategorize', to_jsonb(old), to_jsonb(new));
    else
      insert into expense_audit (expense_id, action, before_state, after_state)
      values (new.id, 'update', to_jsonb(old), to_jsonb(new));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_expense_audit on expenses;
create trigger trg_expense_audit
  after insert or update on expenses
  for each row execute function log_expense_audit();
