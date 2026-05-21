// GET /api-stats?period=day|week|month: KPI for current period.
// Returns totals in EUR (computed per-row using EUR/PLN rate at expense_date).
// total_pln is kept for backwards-compat / internal consumers.
import { adminClient } from "../_shared/supabase.ts";
import { authenticateInitData, extractInitData } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { addDaysIso, todayWarsawIso } from "../_shared/dates.ts";
import { loadEurRates, plnToEur } from "../_shared/eur_view.ts";

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
    .select("amount_pln, category_id, expense_date")
    .eq("archived", false)
    .gte("expense_date", startIso);
  if (me.role !== "admin") q = q.eq("family_member_id", me.id);
  const res = await q;
  const rows = (res.data ?? []) as Array<{
    amount_pln: number;
    category_id: string;
    expense_date: string;
  }>;

  const dates = rows.map((r) => r.expense_date);
  const eurRates = await loadEurRates(sb, dates);

  let totalPln = 0;
  let totalEur = 0;
  const byCatPln = new Map<string, number>();
  const byCatEur = new Map<string, number>();
  for (const r of rows) {
    const pln = Number(r.amount_pln);
    const eur = plnToEur(pln, r.expense_date, eurRates) ?? 0;
    totalPln += pln;
    totalEur += eur;
    byCatPln.set(r.category_id, (byCatPln.get(r.category_id) ?? 0) + pln);
    byCatEur.set(r.category_id, (byCatEur.get(r.category_id) ?? 0) + eur);
  }
  const count = rows.length;
  const topCatEntry = [...byCatEur.entries()].sort((a, b) => b[1] - a[1])[0];
  const topId = topCatEntry?.[0] ?? null;

  return json(req, {
    period,
    period_start: startIso,
    total_eur: Math.round(totalEur * 100) / 100,
    total_pln: Math.round(totalPln * 100) / 100,
    count,
    top_category_id: topId,
    top_category_total: topCatEntry ? Math.round(topCatEntry[1] * 100) / 100 : 0,
    top_category_total_pln: topId ? Math.round((byCatPln.get(topId) ?? 0) * 100) / 100 : 0,
  });
});
