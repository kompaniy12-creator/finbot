-- 0031_tenant_id_constraints.sql
-- Multi-tenancy phase 1: tighten tenant_id to NOT NULL + add indexes.
--
-- Safety: this deploy re-runs 0030 first (idempotent backfill), so any rows
-- inserted by the live family bot between phase 0 and now are stamped before
-- we reach the guard below. The guard then aborts rather than corrupt data if
-- anything is still NULL.
--
-- DEFAULT: each tenant_id gets a DEFAULT of the sentinel family tenant. This
-- keeps the live family bot working AFTER the NOT NULL is enforced but BEFORE
-- phase 2 code sets tenant_id explicitly - inserts that omit it land in the
-- family tenant, which is correct while the family bot is the only live bot.
-- These DEFAULTs are DROPPED in phase 4 (before the SaaS bot goes live) so a
-- missed insert then fails loudly instead of leaking into the family tenant.
--
-- bot_id stays NULLABLE until phase 4 (needs a real second bot to matter).

-- Guard: abort if any per-tenant table still has NULL tenant_id.
do $$
declare
  tbl text;
  n bigint;
  tables text[] := array[
    'family_members','categories','expenses','receipts','recurring_expenses',
    'message_log','media_group_buffer','pending_retry','ask_proposals',
    'ask_threads','web_sessions','bank_statements','bank_statement_lines',
    'planned_payments','budgets','credits','debts','notifications_log',
    'anthropic_usage','expense_audit','budget_categories','credit_payments',
    'debt_payments'
  ];
begin
  foreach tbl in array tables loop
    execute format('select count(*) from %I where tenant_id is null', tbl) into n;
    if n > 0 then
      raise exception 'tenant_id backfill incomplete: % has % NULL rows', tbl, n;
    end if;
  end loop;
end $$;

-- Set DEFAULT + NOT NULL on every per-tenant table. set default / set not null
-- are both idempotent (re-applying on an already-constrained column is a no-op).
do $$
declare
  tbl text;
  tables text[] := array[
    'family_members','categories','expenses','receipts','recurring_expenses',
    'message_log','media_group_buffer','pending_retry','ask_proposals',
    'ask_threads','web_sessions','bank_statements','bank_statement_lines',
    'planned_payments','budgets','credits','debts','notifications_log',
    'anthropic_usage','expense_audit','budget_categories','credit_payments',
    'debt_payments'
  ];
begin
  foreach tbl in array tables loop
    execute format(
      'alter table %I alter column tenant_id set default ''00000000-0000-0000-0000-000000000001''',
      tbl);
    execute format('alter table %I alter column tenant_id set not null', tbl);
    execute format('create index if not exists idx_%s_tenant on %I (tenant_id)', tbl, tbl);
  end loop;
end $$;

-- Composite indexes mirroring hot query shapes.
create index if not exists idx_expenses_tenant_date on expenses (tenant_id, expense_date);
create index if not exists idx_receipts_tenant_date on receipts (tenant_id, receipt_date);
create index if not exists idx_expenses_tenant_archived on expenses (tenant_id, archived);
