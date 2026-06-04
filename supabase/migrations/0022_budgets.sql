-- Budgets feature (the "Бюджеты" sub-view inside the 📅 Планирование tab).
--
-- A budget caps spending in a chosen set of categories over a recurring
-- period (week / month / year). Many-to-many to categories via a link
-- table so a single budget can cover e.g. "Еда" + "Кафе" at once.
--
-- Progress is computed at read time by api-budgets: sum amount_pln over
-- the budget's categories within [period_start, today], convert to the
-- budget's currency using today's rate, divide by budget.amount.

create table if not exists budgets (
  id uuid primary key default gen_random_uuid(),
  family_member_id uuid not null references family_members(id),

  name text not null,
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null check (currency in ('PLN', 'EUR', 'ALL', 'USD')),

  period text not null default 'monthly'
    check (period in ('weekly', 'monthly', 'yearly')),

  notify_on_exceed boolean not null default true,
  notify_at_75 boolean not null default true,

  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists budgets_active_idx
  on budgets (family_member_id) where active;

create table if not exists budget_categories (
  budget_id uuid not null references budgets(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  primary key (budget_id, category_id)
);
create index if not exists budget_categories_cat_idx
  on budget_categories (category_id);

alter table budgets disable row level security;
alter table budget_categories disable row level security;
