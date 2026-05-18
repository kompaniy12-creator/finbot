// GET /api-health: admin-only extended status.
import { adminClient } from "../_shared/supabase.ts";
import { authenticateInitData, extractInitData } from "../_shared/webapp_auth.ts";
import { forbidden, handleOptions, json, unauthorized } from "../_shared/api_response.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const initData = extractInitData(req);
  if (!initData) return unauthorized(req);
  const sb = adminClient();
  const me = await authenticateInitData(initData, sb);
  if (!me) return unauthorized(req);
  if (me.role !== "admin") return forbidden(req);

  const sh = await sb.from("system_health").select("*").eq("id", 1).maybeSingle();
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = await sb.from("expenses")
    .select("id", { count: "exact", head: true })
    .eq("expense_date", today);
  const usage = await sb.from("anthropic_usage")
    .select("cost_usd")
    .eq("date", today);
  const cost = ((usage.data ?? []) as Array<{ cost_usd: number }>)
    .reduce((acc, r) => acc + Number(r.cost_usd), 0);

  return json(req, {
    system_health: sh.data,
    expenses_today: todayCount.count ?? 0,
    anthropic_cost_today_usd: Math.round(cost * 10_000) / 10_000,
  });
});
