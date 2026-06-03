-- Income tracking: same machinery as expenses, separated by a `kind` column.
--
-- We deliberately reuse the expenses table (and categorizer pipeline) rather
-- than creating a new "incomes" table. Reasons:
--   1. ~12 api-* endpoints, audit triggers, the analyst snapshot, retraining
--      cron etc. all already work with expenses; a second table doubles the
--      surface area without adding capability.
--   2. The semantic difference is "this number is positive cash flow not
--      negative" - a single discriminator column captures that cleanly.
--   3. EUR conversion / currency / archived / receipt_id / family_member_id
--      mean exactly the same thing for income.
--
-- Defaults are chosen so every existing row stays an expense and every
-- existing query keeps its current semantics: no callsite is forced to
-- think about kind until it wants to.

alter table expenses
  add column if not exists kind text not null default 'expense'
  check (kind in ('expense', 'income'));

alter table categories
  add column if not exists kind text not null default 'expense'
  check (kind in ('expense', 'income'));

-- Speed up by-kind aggregations (dashboard income/expense split).
create index if not exists expenses_kind_date_idx
  on expenses (kind, expense_date desc) where archived = false;

-- Seed 7 income categories. Descriptions are English on purpose - they're
-- fed to gte-small (English-trained) for the centroid embedding. We need
-- placeholder embeddings here because setup-once will re-run later and
-- recompute / upsert; for now we insert a zero vector and rely on setup-once
-- to fill them in on next call. The is_fallback flag is per-kind: one
-- "expense" fallback already exists (Дополнительные расходы); "Прочий" is
-- the income fallback.
--
-- Idempotent: ON CONFLICT (name) DO NOTHING so re-running is safe.

insert into categories (name, description, kind, is_fallback, embedding)
values
  ('Зарплата', 'Salary, monthly wage, paycheck, primary employment income',
    'income', false, array_fill(0::real, ARRAY[384])::vector(384)),
  ('Дивиденды', 'Dividends, stock dividends, equity payouts, investment income, capital distributions',
    'income', false, array_fill(0::real, ARRAY[384])::vector(384)),
  ('Фриланс', 'Freelance income, contract work, consulting fees, side project earnings',
    'income', false, array_fill(0::real, ARRAY[384])::vector(384)),
  ('Темки', 'Side gigs, hustles, one-off deals, ad-hoc opportunities, informal earnings',
    'income', false, array_fill(0::real, ARRAY[384])::vector(384)),
  ('Подарок', 'Gifts received, monetary presents from family or friends, birthday money',
    'income', false, array_fill(0::real, ARRAY[384])::vector(384)),
  ('Возврат долгов', 'Loan repayments received, money returned, debts repaid back to me',
    'income', false, array_fill(0::real, ARRAY[384])::vector(384)),
  ('Прочий', 'Other income, miscellaneous earnings, unclassified positive cash flow',
    'income', true, array_fill(0::real, ARRAY[384])::vector(384))
on conflict (name) do nothing;
