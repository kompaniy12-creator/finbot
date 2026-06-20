-- 0045_delete_tenant_data.sql
-- GDPR "right to erasure" (P2.2): delete ALL data for one tenant in a single
-- transaction, in FK-safe order (children before parents). Crypto-shred of the
-- DEK happens too (tenant_deks row removed), so any leftover ciphertext in
-- backups is unrecoverable. Refuses to touch the family/owner tenant.
--
-- SECURITY DEFINER + service_role-only execute. Returns jsonb with row counts.
-- Idempotent: deleting an already-empty tenant is a no-op.

create or replace function delete_tenant_data(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family uuid := '00000000-0000-0000-0000-000000000001';
  v_total bigint := 0;
  v_n bigint;
  t text;
  -- Child tables first, then parents, then identity/keys, then the tenant row.
  tables text[] := array[
    'expense_audit','credit_payments','debt_payments','budget_categories',
    'bank_statement_lines',
    'expenses','receipts','recurring_expenses','planned_payments','budgets',
    'credits','debts','bank_statements','notifications_log','anthropic_usage',
    'ask_proposals','ask_threads','web_sessions','message_log',
    'media_group_buffer','pending_retry',
    'categories','tenant_deks','family_members'
  ];
begin
  if p_tenant_id = v_family then
    return jsonb_build_object('error', 'refusing_to_delete_family_tenant');
  end if;

  foreach t in array tables loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'tenant_id'
    ) then
      execute format('delete from public.%I where tenant_id = $1', t) using p_tenant_id;
      get diagnostics v_n = row_count;
      v_total := v_total + v_n;
    end if;
  end loop;

  -- invite_codes references tenants(id); detach so the tenant row can go.
  delete from invite_codes where tenant_id = p_tenant_id;
  delete from tenants where id = p_tenant_id and mode = 'saas';

  return jsonb_build_object('tenant_id', p_tenant_id, 'rows_deleted', v_total);
end;
$$;

revoke all on function delete_tenant_data(uuid) from public, anon, authenticated;
grant execute on function delete_tenant_data(uuid) to service_role;
