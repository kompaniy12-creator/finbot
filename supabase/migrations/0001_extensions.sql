-- 0001_extensions.sql
-- FinBot v6 SPEC §4.1
-- Idempotent: IF NOT EXISTS on every extension.
-- Shared-org safety: this only enables extensions; does not touch existing tables.

create extension if not exists "uuid-ossp";
create extension if not exists "vector";
create extension if not exists "pg_trgm";
create extension if not exists "pg_cron";
create extension if not exists "pg_net";
