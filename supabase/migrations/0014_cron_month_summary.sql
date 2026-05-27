-- Monthly summary cron: fires on the 1st of every month at 07:00 UTC
-- (~ 09:00 Europe/Warsaw in DST, 08:00 outside). Calls cron-month-summary
-- which builds the previous-month recap and DMs each family member.

do $$
begin
  begin perform cron.unschedule('month-summary'); exception when others then null; end;
end$$;

select cron.schedule('month-summary', '0 7 1 * *', $$
  select net.http_post(
    url := (select value from settings where key='functions_url') || '/cron-month-summary',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from settings where key='cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
$$);
