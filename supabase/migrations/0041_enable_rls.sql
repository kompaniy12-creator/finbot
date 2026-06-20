-- 0041_enable_rls.sql
-- Defense in depth: turn on Row Level Security for every table that holds user
-- data. The Edge Functions talk to Postgres with the service-role key, which
-- BYPASSES RLS, so the app keeps working unchanged. What this closes is direct
-- access via the anon/authenticated PostgREST roles: with RLS on and no
-- permissive policy, those roles get zero rows. Tenant isolation in the app
-- still comes from the tenant_id scoping (tenantDb wrapper); this is a second
-- lock at the database boundary.
--
-- Idempotent: "enable row level security" is a no-op if already enabled.

do $$
declare
  t text;
  tables text[] := array[
    -- per-tenant data
    'family_members','categories','expenses','receipts','recurring_expenses',
    'message_log','media_group_buffer','pending_retry','ask_proposals','ask_threads',
    'web_sessions','bank_statements','bank_statement_lines','planned_payments','budgets',
    'credits','debts','notifications_log','anthropic_usage','expense_audit',
    'budget_categories','credit_payments','debt_payments',
    -- sensitive registry / control tables (tenants holds the encrypted API keys)
    'tenants','bots','invite_codes','pending_access'
  ];
begin
  foreach t in array tables loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      execute format('alter table public.%I enable row level security', t);
      execute format('alter table public.%I force row level security', t);
    end if;
  end loop;
end $$;
