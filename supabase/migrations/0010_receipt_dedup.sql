-- Receipt duplicate-detection support.
-- Layer 1: photo_sha256 stores the SHA-256 of the uploaded image bytes,
-- so a re-sent identical photo can be rejected before OCR.
-- Index is partial (only non-archived rows) to keep it lean.

alter table receipts
  add column if not exists photo_sha256 text;

create index if not exists receipts_photo_sha256_family_idx
  on receipts (family_member_id, photo_sha256)
  where archived = false and photo_sha256 is not null;

-- Layer 2 lookup index: content fingerprint (merchant + date + total + currency)
-- for the same family. Used to detect re-photographed-same-receipt cases.
create index if not exists receipts_content_dedup_idx
  on receipts (family_member_id, merchant, receipt_date, total, currency)
  where archived = false;
