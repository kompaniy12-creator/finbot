-- 0032_uniqueness.sql
-- Multi-tenancy phase 1: rework uniqueness from global to per-tenant.
--
-- categories.name was globally UNIQUE (0002), which blocks two tenants from
-- each having "Питание продукты". Make it unique per (tenant_id, name, kind).
--
-- family_members.telegram_id was globally UNIQUE (0002). The same human may be
-- in the family on the personal bot AND start a tenant on the SaaS bot, so
-- scope uniqueness to (bot_id, telegram_id): one member row per (bot, user).
--
-- Old constraint names are auto-generated and not guaranteed, so we discover
-- and drop any single-column UNIQUE constraint on those columns dynamically.

-- Drop the global UNIQUE on categories(name), whatever it is named.
do $$
declare c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where rel.relname = 'categories' and ns.nspname = 'public'
      and con.contype = 'u' and array_length(con.conkey, 1) = 1
      and (select attname from pg_attribute
           where attrelid = con.conrelid and attnum = con.conkey[1]) = 'name'
  loop
    execute format('alter table categories drop constraint %I', c);
  end loop;
end $$;

create unique index if not exists categories_tenant_name_kind
  on categories (tenant_id, name, kind);

-- Drop the global UNIQUE on family_members(telegram_id), whatever it is named.
do $$
declare c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where rel.relname = 'family_members' and ns.nspname = 'public'
      and con.contype = 'u' and array_length(con.conkey, 1) = 1
      and (select attname from pg_attribute
           where attrelid = con.conrelid and attnum = con.conkey[1]) = 'telegram_id'
  loop
    execute format('alter table family_members drop constraint %I', c);
  end loop;
end $$;

create unique index if not exists family_members_bot_tid
  on family_members (bot_id, telegram_id);
