-- Bank statement reconciliation.
--
-- User flow:
--   1. User sends a PDF bank statement (mBank or Revolut) to the bot.
--   2. Bot parses lines via Claude, stores them in bank_statement_lines.
--   3. For each parsed line, auto-match against expenses by
--      (date ±2 days, amount, currency, family_member_id).
--   4. Matched rows: stamp expenses.reconciled_at + payment_method.
--   5. Unmatched lines stay status='pending' until the user triages each
--      one via inline callback (add as new expense, change category, skip).
--
-- payment_method also lives on expenses so manually-entered rows can be
-- annotated by the user from the Mini App (later) without going through
-- a bank statement.

-- ---- expenses: payment + reconciliation columns -------------------------
alter table expenses
  add column if not exists payment_method text not null default 'unknown'
  check (payment_method in ('card', 'cash', 'transfer', 'unknown'));

alter table expenses
  add column if not exists reconciled_at timestamptz;

alter table expenses
  add column if not exists bank_statement_line_id uuid;

create index if not exists expenses_reconciled_idx
  on expenses (family_member_id, reconciled_at) where archived = false;

-- ---- bank_statements: one row per imported PDF --------------------------
create table if not exists bank_statements (
  id uuid primary key default uuid_generate_v4(),
  family_member_id uuid not null references family_members(id),
  -- The source of the statement: 'mbank' / 'revolut' / 'other'. Detected
  -- from the PDF content during parsing.
  source text not null default 'other',
  filename text,
  -- SHA-256 of the file bytes for byte-identical dedup (so re-sending the
  -- same PDF doesn't double-parse and re-create everything).
  sha256 text,
  period_start date,
  period_end date,
  total_lines integer not null default 0,
  matched_lines integer not null default 0,
  added_lines integer not null default 0,
  skipped_lines integer not null default 0,
  raw_text text,  -- first ~10KB of extracted text for debugging
  status text not null default 'parsing'
    check (status in ('parsing', 'parsed', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  unique (family_member_id, sha256)
);

create index if not exists bank_statements_member_idx
  on bank_statements (family_member_id, created_at desc);

-- ---- bank_statement_lines: one row per transaction extracted from PDF ---
create table if not exists bank_statement_lines (
  id uuid primary key default uuid_generate_v4(),
  statement_id uuid not null references bank_statements(id) on delete cascade,
  family_member_id uuid not null references family_members(id),
  -- Parsed from PDF.
  posted_date date not null,
  amount numeric(12, 2) not null,
  currency text not null check (currency in ('PLN', 'EUR', 'ALL', 'USD')),
  description text,
  -- 'card' | 'cash' (rare in bank stmts) | 'transfer'. Driven by mBank's
  -- transaction type or Revolut's payment method.
  method text not null default 'card'
    check (method in ('card', 'cash', 'transfer', 'fee')),
  -- 'income' if money came IN (positive cashflow), 'expense' otherwise.
  kind text not null default 'expense' check (kind in ('expense', 'income')),
  raw_row jsonb,
  -- Reconciliation state.
  status text not null default 'pending'
    check (status in ('matched', 'pending', 'added', 'skipped')),
  matched_expense_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists bsl_statement_idx on bank_statement_lines (statement_id);
create index if not exists bsl_match_search_idx
  on bank_statement_lines (family_member_id, posted_date, currency)
  where status = 'pending';

-- Back-reference: which expenses came from which bank line. Added as FK
-- now that both tables exist.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'expenses_bank_statement_line_id_fkey'
  ) then
    alter table expenses
      add constraint expenses_bank_statement_line_id_fkey
      foreign key (bank_statement_line_id) references bank_statement_lines(id)
      on delete set null;
  end if;
end$$;

alter table bank_statements disable row level security;
alter table bank_statement_lines disable row level security;
