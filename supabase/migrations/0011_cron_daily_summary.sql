-- Daily-summary cron: fires at 20:00 UTC = 22:00 Europe/Warsaw (summer time;
-- in winter it lands at 21:00 Warsaw which is close enough for a daily recap).

do $$
begin
  begin perform cron.unschedule('daily-summary'); exception when others then null; end;
end$$;

select cron.schedule('daily-summary', '0 20 * * *', $$
  select net.http_post(
    url := (select value from settings where key='functions_url') || '/cron-daily-summary',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from settings where key='cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
$$);
