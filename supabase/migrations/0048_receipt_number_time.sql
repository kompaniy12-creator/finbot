-- 0048_receipt_number_time.sql
-- Add fiscal receipt number and receipt time so duplicate detection can tell
-- apart genuinely different receipts that happen to share merchant + date +
-- total + currency (e.g. two identical coffees bought the same day). Both are
-- nullable: Vision may not always read them off a blurry/partial photo. When
-- present they act as extra discriminators in the content-fingerprint dedup
-- (see tg-webhook/photo_pipeline.ts, "Layer 2"). Idempotent.

alter table receipts
  add column if not exists receipt_number text,
  add column if not exists receipt_time  text;

-- Widen the content-dedup helper index to include the new discriminators so
-- the candidate lookup stays index-covered. The old narrower index from 0010
-- is left in place (harmless); this one is the preferred match.
create index if not exists receipts_content_dedup_v2_idx
  on receipts (family_member_id, merchant, receipt_date, total, currency)
  include (receipt_number, receipt_time)
  where archived = false;
