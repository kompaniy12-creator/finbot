-- 0029_tenant_id_nullable.sql
-- Multi-tenancy phase 0: add NULLABLE tenant_id to every per-tenant table,
-- plus bot_id on family_members. Nothing is tightened here and no code reads
-- these columns yet, so deploying this changes nothing at runtime. The
-- backfill (0030) populates them; constraints (0031) tighten afterwards.
--
-- Child tables (expense_audit, budget_categories, credit_payments,
-- debt_payments) get a DENORMALIZED tenant_id so every query can filter
-- directly without a join. bank_statement_lines already carries
-- family_member_id, so it is treated like a top-level table.

-- family_members: tenant membership + which bot reaches this member.
alter table family_members add column if not exists tenant_id uuid references tenants(id);
alter table family_members add column if not exists bot_id uuid references bots(id);

-- Top-level per-tenant data tables.
alter table categories add column if not exists tenant_id uuid references tenants(id);
alter table expenses add column if not exists tenant_id uuid references tenants(id);
alter table receipts add column if not exists tenant_id uuid references tenants(id);
alter table recurring_expenses add column if not exists tenant_id uuid references tenants(id);
alter table message_log add column if not exists tenant_id uuid references tenants(id);
alter table media_group_buffer add column if not exists tenant_id uuid references tenants(id);
alter table pending_retry add column if not exists tenant_id uuid references tenants(id);
alter table ask_proposals add column if not exists tenant_id uuid references tenants(id);
alter table ask_threads add column if not exists tenant_id uuid references tenants(id);
alter table web_sessions add column if not exists tenant_id uuid references tenants(id);
alter table bank_statements add column if not exists tenant_id uuid references tenants(id);
alter table bank_statement_lines add column if not exists tenant_id uuid references tenants(id);
alter table planned_payments add column if not exists tenant_id uuid references tenants(id);
alter table budgets add column if not exists tenant_id uuid references tenants(id);
alter table credits add column if not exists tenant_id uuid references tenants(id);
alter table debts add column if not exists tenant_id uuid references tenants(id);
alter table notifications_log add column if not exists tenant_id uuid references tenants(id);

-- anthropic_usage: scope cost tracking per tenant for billing.
alter table anthropic_usage add column if not exists tenant_id uuid references tenants(id);

-- Child tables: denormalized tenant_id (derived from parent in 0030).
alter table expense_audit add column if not exists tenant_id uuid references tenants(id);
alter table budget_categories add column if not exists tenant_id uuid references tenants(id);
alter table credit_payments add column if not exists tenant_id uuid references tenants(id);
alter table debt_payments add column if not exists tenant_id uuid references tenants(id);
