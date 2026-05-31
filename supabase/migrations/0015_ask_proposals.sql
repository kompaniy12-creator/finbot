-- /ask agent proposal queue.
-- When the analyst wants to change anything, it doesn't write directly: it
-- creates a row here with the planned actions. A bot callback then either
-- executes (askapply) or cancels (askcancel) the proposal. Each proposal
-- expires after 10 minutes so a stale "✅ Применить" tap can't fire writes
-- after the user moved on.

create table if not exists ask_proposals (
  id uuid primary key default uuid_generate_v4(),
  proposer_family_member_id uuid not null references family_members(id),
  proposer_telegram_id bigint not null,
  question text not null,
  -- Array of action objects:
  --   { kind: "delete_expense",      expense_id, summary }
  --   { kind: "recategorize_expense",expense_id, new_category_id, summary }
  --   { kind: "delete_receipt",      receipt_id, summary }
  actions jsonb not null,
  proposed_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  status text not null default 'pending' check (status in ('pending', 'applied', 'cancelled', 'expired')),
  applied_at timestamptz,
  applied_count integer,
  failed_count integer
);

create index if not exists ask_proposals_member_idx
  on ask_proposals (proposer_family_member_id, proposed_at desc);
create index if not exists ask_proposals_status_idx on ask_proposals (status);

alter table ask_proposals disable row level security;
