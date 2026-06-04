-- "Credit for someone" → auto debt.
--
-- A user can take a credit in their own name on behalf of someone else
-- (e.g. helping a friend buy a phone). The bank debits the user each
-- month; that monthly payment is actually money the friend owes back.
--
-- This migration links credits to debts: when a credit has
-- borrowed_for set + auto_create_debt true, every payment that hits
-- the credit's category (whether via api-credits payment, manual user
-- text, or bank statement reconciliation) automatically inserts a
-- corresponding "owed_to_me" debt row in the friend's name.
--
-- Idempotency: debts.source_expense_id enforces one-debt-per-expense,
-- so re-importing the same bank statement never duplicates.

alter table credits
  add column if not exists borrowed_for text,
  add column if not exists auto_create_debt boolean not null default false;

alter table debts
  add column if not exists source_credit_id uuid references credits(id) on delete set null,
  add column if not exists source_expense_id uuid references expenses(id) on delete set null;

create unique index if not exists debts_source_expense_uniq
  on debts (source_expense_id) where source_expense_id is not null;

create or replace function auto_create_debt_for_credit_payment()
returns trigger
language plpgsql
as $$
declare
  v_credit record;
  v_match_tolerance numeric;
begin
  -- Income rows can't be credit payments.
  if new.kind is distinct from 'expense' then return new; end if;
  if new.amount is null or new.amount <= 0 then return new; end if;

  -- Find an active credit owned by the same family member whose
  -- monthly_payment matches the inserted expense's amount within 5%.
  v_match_tolerance := greatest(0.05, 0.05 * new.amount);
  select c.* into v_credit
  from credits c
  where c.family_member_id = new.family_member_id
    and c.currency = new.currency
    and c.status = 'active'
    and c.borrowed_for is not null
    and length(trim(c.borrowed_for)) > 0
    and c.auto_create_debt = true
    and c.monthly_payment is not null
    and abs(c.monthly_payment - new.amount) <= v_match_tolerance
  order by abs(c.monthly_payment - new.amount) asc
  limit 1;

  if v_credit is null or v_credit.id is null then return new; end if;

  -- One-debt-per-expense - the unique index would also catch this, but
  -- exiting cleanly is friendlier than raising on duplicate inserts.
  if exists (select 1 from debts where source_expense_id = new.id) then
    return new;
  end if;

  insert into debts (
    family_member_id, direction, counterparty,
    amount, currency, remaining_balance,
    borrowed_at, status, notes,
    source_credit_id, source_expense_id
  ) values (
    new.family_member_id, 'owed_to_me', v_credit.borrowed_for,
    new.amount, new.currency, new.amount,
    new.expense_date, 'active',
    'Авто: платёж по кредиту "' || v_credit.name || '"',
    v_credit.id, new.id
  );

  return new;
end;
$$;

drop trigger if exists expenses_auto_credit_debt on expenses;
create trigger expenses_auto_credit_debt
  after insert on expenses
  for each row execute function auto_create_debt_for_credit_payment();
