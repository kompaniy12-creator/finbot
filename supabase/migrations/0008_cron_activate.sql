-- 0008_cron_activate.sql
-- FinBot M14: activate all pg_cron schedules.
--
-- Shared-org adaptation: we cannot ALTER DATABASE SET app.* on a Supabase
-- managed instance (permission denied). Instead we keep a `settings` key/value
-- table (in our whitelist per CLAUDE.local.md) and read from it inside the
-- cron job bodies. The two required values are populated by Management API
-- after this migration runs.

create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table settings disable row level security;

-- Placeholder seeds so cron jobs do not crash on first activation.
insert into settings (key, value) values
  ('functions_url', 'https://example.invalid/functions/v1'),
  ('cron_secret', 'placeholder')
on conflict (key) do nothing;

-- Unschedule any prior jobs so re-applying this migration is idempotent.
do $$
declare
  jobs text[] := array[
    'recurring-daily',
    'retention-daily',
    'retraining-weekly',
    'heartbeat-minutely',
    'anomaly-daily',
    'media-group-sweep',
    'rates-daily',
    'auto-confirm-minutely',
    'retry-failed-5min'
  ];
  j text;
begin
  foreach j in array jobs loop
    begin
      perform cron.unschedule(j);
    exception when others then
      null;
    end;
  end loop;
end$$;

-- Heartbeat: pure SQL, no Edge Function call needed.
select cron.schedule(
  'heartbeat-minutely',
  '* * * * *',
  $$ update system_health set last_seen = now() where id = 1 $$
);

-- Helper macro - we inline a (settings-read + http_post) per job.

select cron.schedule('recurring-daily', '0 7 * * *', $$
  select net.http_post(
    url := (select value from settings where key='functions_url') || '/cron-recurring',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from settings where key='cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
$$);

select cron.schedule('retention-daily', '30 2 * * *', $$
  select net.http_post(
    url := (select value from settings where key='functions_url') || '/cron-retention',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from settings where key='cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
$$);

select cron.schedule('retraining-weekly', '0 3 * * 0', $$
  select net.http_post(
    url := (select value from settings where key='functions_url') || '/cron-retraining',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from settings where key='cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
$$);

select cron.schedule('anomaly-daily', '0 8 * * *', $$
  select net.http_post(
    url := (select value from settings where key='functions_url') || '/cron-anomaly',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from settings where key='cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
$$);

select cron.schedule('media-group-sweep', '*/2 * * * *', $$
  select net.http_post(
    url := (select value from settings where key='functions_url') || '/cron-media-group-sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from settings where key='cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
$$);

select cron.schedule('rates-daily', '0 5 * * *', $$
  select net.http_post(
    url := (select value from settings where key='functions_url') || '/cron-rates',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from settings where key='cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
$$);

select cron.schedule('auto-confirm-minutely', '* * * * *', $$
  select net.http_post(
    url := (select value from settings where key='functions_url') || '/cron-auto-confirm',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from settings where key='cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
$$);

select cron.schedule('retry-failed-5min', '*/5 * * * *', $$
  select net.http_post(
    url := (select value from settings where key='functions_url') || '/cron-retry-failed',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from settings where key='cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
$$);
