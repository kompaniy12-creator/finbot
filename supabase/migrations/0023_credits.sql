-- Credits feature (the "🏦 Кредит" tab in the Mini App).
--
-- Covers all forms of debt: bank loans, store installments, credit
-- cards, mortgages, auto loans, POS credits, microloans, overdrafts.
-- The user records principal + terms once, then logs each monthly
-- payment via api-credits?action=payment which decrements
-- remaining_balance and creates the matching expense row (under
-- category "Выплаты по кредиту" when present, fallback otherwise).

create table if not exists credits (
  id uuid primary key default gen_random_uuid(),
  family_member_id uuid not null references family_members(id),

  -- Identity
  name text not null,
  -- 9 types cover all real-world debt instruments. "other" is the
  -- escape hatch so the user never has to lie about what they took on.
  type text not null default 'cash_loan' check (
    type in (
      'cash_loan',
      'installment',
      'credit_card',
      'mortgage',
      'auto_loan',
      'pos_credit',
      'microloan',
      'overdraft',
      'other'
    )
  ),
  lender text,

  -- Money
  principal numeric(14, 2) not null check (principal > 0),
  currency text not null check (currency in ('PLN', 'EUR', 'ALL', 'USD')),
  interest_rate numeric(6, 3) not null default 0 check (interest_rate >= 0),

  -- Schedule
  start_date date not null,
  term_months integer check (term_months is null or term_months > 0),
  monthly_payment numeric(14, 2),
  payment_day integer check (payment_day is null or (payment_day between 1 and 31)),

  -- Current state
  remaining_balance numeric(14, 2) not null check (remaining_balance >= 0),

  status text not null default 'active'
    check (status in ('active', 'closed', 'overdue')),
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists credits_active_idx
  on credits (family_member_id) where status = 'active';

-- Optional: each recorded payment links back to the expense it created
-- so we can show a history per credit and avoid double-counting if the
-- user manually edits the expense.
create table if not exists credit_payments (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references credits(id) on delete cascade,
  expense_id uuid references expenses(id) on delete set null,
  amount numeric(14, 2) not null check (amount > 0),
  paid_at date not null,
  created_at timestamptz not null default now()
);
create index if not exists credit_payments_credit_idx
  on credit_payments (credit_id, paid_at desc);

alter table credits disable row level security;
alter table credit_payments disable row level security;
