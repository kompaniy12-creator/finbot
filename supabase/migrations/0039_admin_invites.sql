-- 0039_admin_invites.sql
-- Owner-facing control panel for the SaaS bot: list invite codes + testers and
-- grant/revoke access. These run cross-tenant (the owner manages every tenant),
-- so they live in SQL rather than the tenant-scoped app layer. Idempotent
-- (create or replace).

-- Snapshot for the /invites panel: free (unredeemed, unexpired) codes plus the
-- list of testers (one row per redeemed tenant + its admin member).
create or replace function admin_list_invites()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'free', coalesce((
      select jsonb_agg(jsonb_build_object('code', c.code) order by c.created_at)
      from invite_codes c
      where c.use_count < c.max_uses
        and (c.expires_at is null or c.expires_at > now())
    ), '[]'::jsonb),
    'testers', coalesce((
      select jsonb_agg(t order by t.redeemed_at desc nulls last)
      from (
        select
          c.tenant_id,
          tn.name        as tenant_name,
          tn.status      as tenant_status,
          c.code,
          c.redeemed_by_telegram_id as telegram_id,
          c.redeemed_at,
          coalesce(bool_or(fm.active), false) as active
        from invite_codes c
        join tenants tn on tn.id = c.tenant_id
        left join family_members fm on fm.tenant_id = c.tenant_id
        where c.tenant_id is not null
        group by c.tenant_id, tn.name, tn.status, c.code, c.redeemed_by_telegram_id, c.redeemed_at
      ) t
    ), '[]'::jsonb)
  );
$$;

-- Grant or revoke a tester's access. Revoke suspends the tenant and deactivates
-- its members (so authorize() returns null and they can no longer use the bot);
-- grant restores both. Returns the new active state.
create or replace function admin_set_tenant_access(p_tenant_id uuid, p_active boolean)
returns jsonb
language plpgsql
as $$
begin
  update tenants
    set status = case when p_active then 'active' else 'suspended' end
  where id = p_tenant_id and mode = 'saas';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  update family_members set active = p_active where tenant_id = p_tenant_id;
  return jsonb_build_object('tenant_id', p_tenant_id, 'active', p_active);
end;
$$;
