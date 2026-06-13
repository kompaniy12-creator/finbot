-- 0035_expenses_idempotency_nulls_distinct.sql
-- Fix: recording a second debt return / credit payment from the Mini App failed
-- with "duplicate key value violates unique constraint expenses_idempotency".
--
-- App-created expense rows (debt returns, credit payments) have
-- telegram_message_id = NULL and line_index = 0. The original constraint used
-- NULLS NOT DISTINCT, so two such rows for the same family_member_id collided
-- (NULL == NULL). Telegram-created rows always have a non-null
-- telegram_message_id, so switching to NULLS DISTINCT (the Postgres default)
-- keeps their idempotency intact while letting NULL-tmid app rows coexist.
--
-- Idempotent: drop-if-exists then add; safe to replay every deploy. NULLS
-- DISTINCT is strictly looser than NULLS NOT DISTINCT, so existing data always
-- satisfies the new form.

alter table expenses drop constraint if exists expenses_idempotency;
alter table expenses add constraint expenses_idempotency
  unique nulls distinct (telegram_message_id, family_member_id, line_index);
