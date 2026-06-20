-- 0036_redeem_invite.sql
-- Atomic onboarding for the SaaS bot: redeem an invite code into a new tenant.
-- Called by tg-webhook on /start <code> from an unknown user on a saas-mode bot.
-- Returns jsonb: {tenant_id, created} on success, {error} otherwise.
--
-- Race-safe: the use_count bump is a single conditional UPDATE, so two parallel
-- /start <code> on a max_uses=1 code cannot both succeed. Idempotent for a
-- repeat /start by an already-onboarded user (returns their tenant, no code
-- consumed).

create or replace function redeem_invite(
  p_code text,
  p_telegram_id bigint,
  p_bot_id uuid,
  p_first_name text
)
returns jsonb
language plpgsql
as $$
declare
  v_tenant uuid;
  v_consumed text;
  v_name text := coalesce(nullif(trim(p_first_name), ''), 'Workspace');
begin
  -- Already onboarded on this bot? Return existing tenant, don't consume a code.
  select tenant_id into v_tenant
  from family_members
  where bot_id = p_bot_id and telegram_id = p_telegram_id and active = true
  limit 1;
  if found then
    return jsonb_build_object('tenant_id', v_tenant, 'created', false);
  end if;

  -- Consume the code atomically (bounded by max_uses + expiry).
  update invite_codes
    set use_count = use_count + 1,
        redeemed_by_telegram_id = p_telegram_id,
        redeemed_at = now()
  where code = p_code
    and use_count < max_uses
    and (expires_at is null or expires_at > now())
  returning code into v_consumed;
  if v_consumed is null then
    return jsonb_build_object('error', 'invalid_code');
  end if;

  -- New tenant (saas mode, $0.50/day Claude cap) + its first admin member.
  insert into tenants (name, mode, anthropic_daily_budget_usd)
  values (v_name, 'saas', 0.50)
  returning id into v_tenant;

  insert into family_members (tenant_id, bot_id, telegram_id, name, role, active)
  values (v_tenant, p_bot_id, p_telegram_id, v_name, 'admin', true);

  update invite_codes set tenant_id = v_tenant where code = p_code;

  return jsonb_build_object('tenant_id', v_tenant, 'created', true);
end;
$$;
