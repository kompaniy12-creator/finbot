-- Planned payments (Планирование tab in the Mini App).
--
-- Distinct from `recurring_expenses` (which only supports monthly + same
-- amount + auto-charge by day_of_month): this table supports one-time
-- future payments + flexible frequencies + per-payment notification
-- preferences + a "confirm vs auto" toggle so the user can review each
-- execution before it lands in expenses.
--
-- A cron task (cron-planned-payments, future) walks rows where
-- next_due_date <= today + 3 (for the "за 3 дня" notification) and
-- next_due_date <= today (for the actual execution / day-of notification).

create table if not exists planned_payments (
  id uuid primary key default gen_random_uuid(),
  family_member_id uuid not null references family_members(id),

  -- Basics
  kind text not null default 'expense' check (kind in ('expense', 'income')),
  name text not null,
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null check (currency in ('PLN', 'EUR', 'ALL', 'USD')),
  category_id uuid references categories(id),
  payment_method text not null default 'cash'
    check (payment_method in ('card', 'cash', 'transfer')),

  -- Schedule
  frequency text not null default 'once'
    check (frequency in ('once', 'weekly', 'monthly', 'yearly')),
  next_due_date date not null,

  -- Behavior
  auto_confirm boolean not null default false,
  notify_on_day boolean not null default true,
  notify_3d_before boolean not null default true,

  -- Free-form
  note text,
  active boolean not null default true,

  last_executed_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists planned_payments_due_idx
  on planned_payments (family_member_id, next_due_date) where active;
create index if not exists planned_payments_kind_idx
  on planned_payments (family_member_id, kind) where active;

alter table planned_payments disable row level security;
