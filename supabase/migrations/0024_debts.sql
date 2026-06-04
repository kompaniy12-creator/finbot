-- Debts feature (the "🤝 Долги" tab in the Mini App).
--
-- Tracks informal debts in both directions:
--   - i_owe       I borrowed from someone; recording a repayment
--                 inserts an expense row in their name.
--   - owed_to_me  I lent to someone; recording a return inserts an
--                 income row.
--
-- Reminders: each debt carries notify_* toggles that a future cron
-- task uses to ping the user N days before due_date / on due_date /
-- after due_date when status flips to overdue.

create table if not exists debts (
  id uuid primary key default gen_random_uuid(),
  family_member_id uuid not null references family_members(id),

  direction text not null check (direction in ('i_owe', 'owed_to_me')),
  counterparty text not null,

  amount numeric(14, 2) not null check (amount > 0),
  currency text not null check (currency in ('PLN', 'EUR', 'ALL', 'USD')),
  remaining_balance numeric(14, 2) not null check (remaining_balance >= 0),

  borrowed_at date not null,
  due_date date,

  notify_3d_before boolean not null default true,
  notify_on_due boolean not null default true,
  notify_overdue boolean not null default true,

  status text not null default 'active'
    check (status in ('active', 'closed', 'overdue')),
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists debts_active_idx
  on debts (family_member_id, direction) where status = 'active';
create index if not exists debts_due_idx
  on debts (due_date) where status = 'active' and due_date is not null;

create table if not exists debt_payments (
  id uuid primary key default gen_random_uuid(),
  debt_id uuid not null references debts(id) on delete cascade,
  expense_id uuid references expenses(id) on delete set null,
  amount numeric(14, 2) not null check (amount > 0),
  paid_at date not null,
  created_at timestamptz not null default now()
);
create index if not exists debt_payments_debt_idx
  on debt_payments (debt_id, paid_at desc);

alter table debts disable row level security;
alter table debt_payments disable row level security;
