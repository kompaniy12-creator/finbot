-- Pending access requests from non-family Telegram users.
-- An unauthorized incoming message UPSERTs a row here; the admin sees a
-- one-tap notification (Дать доступ / Отклонить) and the callbacks look up
-- the row to know first_name + username. last_notified_at is used to throttle
-- repeated requests from the same user to once per hour.

create table if not exists pending_access (
  telegram_id bigint primary key,
  first_name text,
  username text,
  requested_at timestamptz not null default now(),
  last_notified_at timestamptz not null default now()
);

create index if not exists pending_access_last_notified_idx
  on pending_access (last_notified_at desc);

alter table pending_access disable row level security;
