-- 0037_audit_trigger_tenant.sql
-- The expense audit trigger inserted expense_audit rows without tenant_id, so
-- they fell back to the family-tenant column DEFAULT. With a second tenant that
-- leaks one tenant's audit trail into another's /audit view. Stamp tenant_id
-- from the row being audited. Idempotent (create or replace).

create or replace function log_expense_audit() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into expense_audit (expense_id, tenant_id, action, after_state, source)
    values (new.id, new.tenant_id, 'insert', to_jsonb(new), new.source);
  elsif tg_op = 'UPDATE' then
    if old.archived = false and new.archived = true then
      insert into expense_audit (expense_id, tenant_id, action, before_state, after_state)
      values (new.id, new.tenant_id, 'archive', to_jsonb(old), to_jsonb(new));
    elsif old.category_id is distinct from new.category_id then
      insert into expense_audit (expense_id, tenant_id, action, before_state, after_state)
      values (new.id, new.tenant_id, 'recategorize', to_jsonb(old), to_jsonb(new));
    else
      insert into expense_audit (expense_id, tenant_id, action, before_state, after_state)
      values (new.id, new.tenant_id, 'update', to_jsonb(old), to_jsonb(new));
    end if;
  end if;
  return new;
end;
$$;
