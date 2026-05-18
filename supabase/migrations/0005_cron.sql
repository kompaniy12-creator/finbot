-- 0005_cron.sql
-- FinBot v6 SPEC §4.5
-- ALL cron.schedule(...) calls are COMMENTED OUT until M14 (when corresponding
-- Edge Functions are deployed). Activation migration: 0008_cron_activate.sql (M14).
--
-- GUCs `app.functions_url` and `app.cron_secret` will be set in M14 via Management
-- API query (alter database postgres set ...) since we have no psql access.

-- (intentionally empty: cron schedules added in 0008_cron_activate.sql)
-- Heartbeat could be SQL-only here, but we keep it in 0008 too for consistency.
