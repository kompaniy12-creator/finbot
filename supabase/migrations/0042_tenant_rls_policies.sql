-- 0042_tenant_rls_policies.sql
-- Explicit tenant-isolation RLS policies (defense in depth on top of 0041).
--
-- Each per-tenant table gets a policy that only exposes rows whose tenant_id
-- matches the session setting `app.tenant_id`. With the setting unset the
-- comparison is NULL -> no rows (deny by default).
--
-- The Edge Functions connect as service-role, which has BYPASSRLS, so these
-- policies do not change current behaviour - the app still relies on the
-- tenantDb() scoping in code. What they add: the moment any access path uses a
-- NON-bypass role (a future restricted DB role, direct PostgREST as
-- authenticated, etc.), the database itself enforces tenant isolation. The
-- sensitive registry tables (tenants/bots/invite_codes/pending_access) keep the
-- stricter 0041 default-deny (no policy) so non-service roles never read them.
--
-- Idempotent: each policy is dropped and recreated.

do $$
declare
  t text;
  tables text[] := array[
    'family_members','categories','expenses','receipts','recurring_expenses',
    'message_log','media_group_buffer','pending_retry','ask_proposals','ask_threads',
    'web_sessions','bank_statements','bank_statement_lines','planned_payments','budgets',
    'credits','debts','notifications_log','anthropic_usage','expense_audit',
    'budget_categories','credit_payments','debt_payments'
  ];
begin
  foreach t in array tables loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'tenant_id'
    ) then
      execute format('drop policy if exists tenant_isolation on public.%I', t);
      execute format(
        'create policy tenant_isolation on public.%I for all to public '
        || 'using (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
        || 'with check (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
        t
      );
    end if;
  end loop;
end $$;
