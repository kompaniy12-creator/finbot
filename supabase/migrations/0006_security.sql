-- 0006_security.sql
-- FinBot v6 SPEC §4.6
-- Single-tenant family bot: RLS DISABLED on FinBot tables ONLY.
-- DO NOT touch RLS on existing non-FinBot tables (payouts/photos/promotions/
-- referrals/transactions/users/withdrawals)  -  those belong to Twoja Decyzja prod.

alter table family_members disable row level security;
alter table categories disable row level security;
alter table expenses disable row level security;
alter table receipts disable row level security;
alter table exchange_rates disable row level security;
alter table recurring_expenses disable row level security;
alter table expense_audit disable row level security;
alter table system_health disable row level security;
alter table message_log disable row level security;
alter table pending_retry disable row level security;
alter table anthropic_usage disable row level security;
alter table media_group_buffer disable row level security;

-- Storage bucket for receipt photos. Idempotent.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;
