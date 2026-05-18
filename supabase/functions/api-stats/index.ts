// GET /api-stats?period=day|week|month: KPI for current period.
import { adminClient } from "../_shared/supabase.ts";
import { authenticateInitData, extractInitData } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { addDaysIso, todayWarsawIso } from "../_shared/dates.ts";

function periodStart(period: string, today: string): string {
  if (period === "day") return today;
  if (period === "week") return addDaysIso(today, -6);
  return today.slice(0, 7) + "-01"; // month default
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const initData = extractInitData(req);
  if (!initData) return unauthorized(req);
  const sb = adminClient();
  const me = await authenticateInitData(initData, sb);
  if (!me) return unauthorized(req);

  const url = new URL(req.url);
  const period = (url.searchParams.get("period") ?? "month").toLowerCase();
  const today = todayWarsawIso();
  const startIso = periodStart(period, today);

  let q = sb.from("expenses")
    .select("amount_pln, category_id")
    .eq("archived", false)
    .gte("expense_date", startIso);
  if (me.role !== "admin") q = q.eq("family_member_id", me.id);
  const res = await q;
  const rows = (res.data ?? []) as Array<{ amount_pln: number; category_id: string }>;

  const total = rows.reduce((acc, r) => acc + Number(r.amount_pln), 0);
  const count = rows.length;
  const byCat = new Map<string, number>();
  for (const r of rows) {
    byCat.set(r.category_id, (byCat.get(r.category_id) ?? 0) + Number(r.amount_pln));
  }
  const topCatEntry = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];

  return json(req, {
    period,
    period_start: startIso,
    total_pln: Math.round(total * 100) / 100,
    count,
    top_category_id: topCatEntry?.[0] ?? null,
    top_category_total: topCatEntry ? Math.round(topCatEntry[1] * 100) / 100 : 0,
  });
});
