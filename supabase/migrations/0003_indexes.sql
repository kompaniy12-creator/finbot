-- 0003_indexes.sql
-- FinBot v6 SPEC §4.3
-- All indexes target FinBot tables only.

create index if not exists idx_family_telegram_id on family_members(telegram_id);
create index if not exists idx_categories_usage on categories(usage_count desc);
create index if not exists idx_receipts_date on receipts(receipt_date desc);
create index if not exists idx_receipts_family on receipts(family_member_id);
create index if not exists idx_receipts_purge on receipts(created_at)
  where photo_purged_at is null;
create index if not exists idx_expenses_date on expenses(expense_date desc);
create index if not exists idx_expenses_category on expenses(category_id);
create index if not exists idx_expenses_family on expenses(family_member_id);
create index if not exists idx_expenses_msg on expenses(telegram_message_id);
create index if not exists idx_expenses_review on expenses(needs_review)
  where needs_review = true;
create index if not exists idx_expenses_confirm on expenses(needs_confirmation)
  where needs_confirmation = true;
create index if not exists idx_expenses_corrected on expenses(corrected_by_user)
  where corrected_by_user = true;
create index if not exists idx_audit_expense on expense_audit(expense_id);
create index if not exists idx_audit_created on expense_audit(created_at desc);
create index if not exists idx_usage_date on anthropic_usage(date);
create index if not exists idx_usage_user_date on anthropic_usage(family_member_id, date);
create index if not exists idx_mgb_received on media_group_buffer(received_at);
create index if not exists idx_pending_retry_next on pending_retry(next_retry_at);
create index if not exists idx_categories_embedding on categories
  using hnsw (embedding vector_cosine_ops);
create index if not exists idx_expenses_embedding on expenses
  using hnsw (embedding vector_cosine_ops);
