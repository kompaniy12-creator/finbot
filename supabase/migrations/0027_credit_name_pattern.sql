-- Pattern-based auto-debt matching for variable-amount credit payments.
--
-- The amount-based match (±5% of monthly_payment) doesn't fit
-- overdrafts and credit-line interest charges where the debit amount
-- varies every month. Add a `name_pattern` field: when set, the
-- trigger first tries to match by case-insensitive substring of the
-- inserted expense's name against the pattern, regardless of amount.
-- The amount-based fallback still works for installment-style credits
-- where monthly_payment is fixed.

alter table credits
  add column if not exists name_pattern text;

create or replace function auto_create_debt_for_credit_payment()
returns trigger
language plpgsql
as $$
declare
  v_credit record;
  v_match_tolerance numeric;
begin
  if new.kind is distinct from 'expense' then return new; end if;
  if new.amount is null or new.amount <= 0 then return new; end if;

  -- Path A: pattern-based match (variable amount, fixed naming).
  select c.* into v_credit
  from credits c
  where c.family_member_id = new.family_member_id
    and c.currency = new.currency
    and c.status = 'active'
    and c.borrowed_for is not null
    and length(trim(c.borrowed_for)) > 0
    and c.auto_create_debt = true
    and c.name_pattern is not null
    and length(trim(c.name_pattern)) > 0
    and new.name ilike '%' || c.name_pattern || '%'
  order by length(c.name_pattern) desc
  limit 1;

  -- Path B: amount-based fallback when no pattern matched.
  if v_credit is null or v_credit.id is null then
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
  end if;

  if v_credit is null or v_credit.id is null then return new; end if;

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
