-- 0030_backfill_default_tenant.sql
-- Multi-tenancy phase 0: backfill. All existing data belongs to ONE family,
-- so every per-tenant row is stamped with the fixed sentinel tenant id and
-- the family bot. Idempotent: every UPDATE is guarded by `tenant_id is null`
-- and inserts use ON CONFLICT DO NOTHING, so re-running on each deploy is a
-- no-op once populated.

-- 1. The legacy family tenant (fixed UUID so app code / tests can reference it).
insert into tenants (id, name, mode, anthropic_daily_budget_usd)
values ('00000000-0000-0000-0000-000000000001', 'Семья', 'family', null)
on conflict (id) do nothing;

-- 2. Register the existing family bot (@KSSfinance_bot). Uses the legacy
--    webhook secret name; token + secret live in Supabase secrets.
insert into bots (telegram_bot_id, mode, token_secret_name, webhook_secret_name)
values (8628608360, 'family', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET')
on conflict (telegram_bot_id) do nothing;

-- 3. Stamp tenant + bot onto family_members.
update family_members
set tenant_id = '00000000-0000-0000-0000-000000000001'
where tenant_id is null;

update family_members
set bot_id = (select id from bots where telegram_bot_id = 8628608360)
where bot_id is null;

-- 4. Stamp the default tenant onto every per-tenant data table. Single
--    historical tenant means a blanket assignment is correct.
update categories set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update expenses set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update receipts set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update recurring_expenses set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update message_log set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update media_group_buffer set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update pending_retry set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update ask_proposals set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update ask_threads set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update web_sessions set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update bank_statements set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update bank_statement_lines set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update planned_payments set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update budgets set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update credits set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update debts set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update notifications_log set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update anthropic_usage set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;

-- Child tables (denormalized).
update expense_audit set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update budget_categories set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update credit_payments set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update debt_payments set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
