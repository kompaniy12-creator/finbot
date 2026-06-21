-- 0047_admin_overview.sql
-- Owner-only cross-tenant overview used by the admin dashboard.
--
-- Returns a single jsonb document with one row per tenant: identity, activity
-- (members, expenses, last activity) and AI spend (today + all-time, against the
-- per-tenant daily budget). Heavy lifting stays in SQL so the Edge Function does
-- one round-trip and never fans out N+1 per-tenant queries.
--
-- Security: this function is SECURITY INVOKER and reads across every tenant, so
-- it must only ever be called by the bot owner. The owner gate lives in the
-- calling Edge Function (api-admin-overview), which checks FAMILY_TENANT admin
-- before invoking. No anon/authenticated grants are added; only service_role
-- (used by Edge Functions) can execute it.

create or replace function admin_overview()
returns jsonb
language sql
stable
as $$
  with mem as (
    select tenant_id,
           count(*)                       as member_count,
           count(*) filter (where active) as active_members
    from family_members
    group by tenant_id
  ),
  exp as (
    select tenant_id,
           count(*)        as expense_count,
           max(created_at) as last_activity
    from expenses
    group by tenant_id
  ),
  usage_total as (
    select tenant_id, sum(cost_usd) as cost_total
    from anthropic_usage
    group by tenant_id
  ),
  usage_today as (
    select tenant_id, sum(cost_usd) as cost_today
    from anthropic_usage
    where date = current_date
    group by tenant_id
  )
  select jsonb_build_object(
    'generated_at', now(),
    'tenants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',             t.id,
          'name',           t.name,
          'mode',           t.mode,
          'status',         t.status,
          'locale',         t.locale,
          'created_at',     t.created_at,
          'budget_usd',     t.anthropic_daily_budget_usd,
          'members',        coalesce(m.member_count, 0),
          'active_members', coalesce(m.active_members, 0),
          'expenses',       coalesce(e.expense_count, 0),
          'last_activity',  e.last_activity,
          'ai_cost_total',  round(coalesce(ut.cost_total, 0), 4),
          'ai_cost_today',  round(coalesce(ud.cost_today, 0), 4)
        )
        -- Owner's own family tenant first, then most-recently-active tenants.
        order by (t.mode = 'family') desc, e.last_activity desc nulls last
      )
      from tenants t
      left join mem         m  on m.tenant_id  = t.id
      left join exp         e  on e.tenant_id  = t.id
      left join usage_total ut on ut.tenant_id = t.id
      left join usage_today ud on ud.tenant_id = t.id
    ), '[]'::jsonb)
  );
$$;
