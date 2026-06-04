-- Notifications cron infrastructure.
--
-- The daily cron-notifications walks planned_payments, budgets, and
-- debts, dispatches Telegram messages for events whose conditions
-- match today's date / current spending, and logs each dispatch into
-- notifications_log so we never spam the same event twice.
--
-- event_key encodes both the kind of event and its occurrence/period:
--   planned_payment + reminder_3d_2026-07-03
--   planned_payment + reminder_on_day_2026-07-03
--   planned_payment + auto_executed_2026-07-03
--   budget          + budget_75_monthly_2026-06
--   budget          + budget_exceed_monthly_2026-06
--   debt            + debt_3d
--   debt            + debt_due
--   debt            + debt_overdue
-- The unique constraint guarantees one Telegram message per logical
-- event per occurrence.

create table if not exists notifications_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('planned_payment', 'budget', 'debt')),
  entity_id uuid not null,
  event_key text not null,
  sent_at timestamptz not null default now(),
  family_member_id uuid not null references family_members(id),
  unique (entity_type, entity_id, event_key)
);
create index if not exists notifications_log_recent_idx
  on notifications_log (family_member_id, sent_at desc);

alter table notifications_log disable row level security;

-- Wire pg_cron to ping cron-notifications every day at 06:00 UTC
-- (~08:00 Warsaw winter, 09:00 summer). Idempotent unschedule first.
do $$
begin
  perform cron.unschedule('notifications-daily');
exception when others then
  null;
end$$;

select cron.schedule('notifications-daily', '0 6 * * *', $$
  select net.http_post(
    url := (select value from settings where key='functions_url') || '/cron-notifications',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from settings where key='cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
$$);
