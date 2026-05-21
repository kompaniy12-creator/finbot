// GET /api-stats?period=day|week|month | ?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns totals in EUR (computed per-row using EUR/PLN rate at expense_date).
// total_pln is kept for backwards-compat / internal consumers.
import { adminClient } from "../_shared/supabase.ts";
import { authenticateInitData, extractInitData } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { loadEurRates, plnToEur } from "../_shared/eur_view.ts";
import { resolveDateWindow } from "../_shared/period.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const initData = extractInitData(req);
  if (!initData) return unauthorized(req);
  const sb = adminClient();
  const me = await authenticateInitData(initData, sb);
  if (!me) return unauthorized(req);

  const url = new URL(req.url);
  const today = todayWarsawIso();
  const win = resolveDateWindow(url, today);

  const [expRes, catRes] = await Promise.all([
    (async () => {
      let q = sb.from("expenses")
        .select("amount_pln, category_id, expense_date")
        .eq("archived", false)
        .gte("expense_date", win.start)
        .lte("expense_date", win.end);
      if (me.role !== "admin") q = q.eq("family_member_id", me.id);
      return await q;
    })(),
    sb.from("categories").select("id, name, is_fallback"),
  ]);
  const rows = (expRes.data ?? []) as Array<{
    amount_pln: number;
    category_id: string;
    expense_date: string;
  }>;
  const cats = (catRes.data ?? []) as Array<{
    id: string;
    name: string;
    is_fallback: boolean;
  }>;

  const dates = rows.map((r) => r.expense_date);
  const eurRates = await loadEurRates(sb, dates);

  let totalPln = 0;
  let totalEur = 0;
  const byCatPln = new Map<string, number>();
  const byCatEur = new Map<string, number>();
  const byCatCount = new Map<string, number>();
  for (const r of rows) {
    const pln = Number(r.amount_pln);
    const eur = plnToEur(pln, r.expense_date, eurRates) ?? 0;
    totalPln += pln;
    totalEur += eur;
    byCatPln.set(r.category_id, (byCatPln.get(r.category_id) ?? 0) + pln);
    byCatEur.set(r.category_id, (byCatEur.get(r.category_id) ?? 0) + eur);
    byCatCount.set(r.category_id, (byCatCount.get(r.category_id) ?? 0) + 1);
  }
  const count = rows.length;

  // One entry per category in DB, including zero-spend categories.
  // Sort by total_eur desc; fallback ("Дополнительные расходы") tie-broken to bottom.
  const breakdown = cats.map((c) => ({
    id: c.id,
    name: c.name,
    is_fallback: c.is_fallback,
    total_eur: Math.round((byCatEur.get(c.id) ?? 0) * 100) / 100,
    total_pln: Math.round((byCatPln.get(c.id) ?? 0) * 100) / 100,
    count: byCatCount.get(c.id) ?? 0,
  })).sort((a, b) => {
    if (b.total_eur !== a.total_eur) return b.total_eur - a.total_eur;
    if (a.is_fallback !== b.is_fallback) return a.is_fallback ? 1 : -1;
    return a.name.localeCompare(b.name, "ru");
  });

  const topEntry = breakdown.find((b) => b.total_eur > 0) ?? null;

  return json(req, {
    period: win.period,
    period_start: win.start,
    period_end: win.end,
    total_eur: Math.round(totalEur * 100) / 100,
    total_pln: Math.round(totalPln * 100) / 100,
    count,
    top_category_id: topEntry?.id ?? null,
    top_category_total: topEntry?.total_eur ?? 0,
    top_category_total_pln: topEntry?.total_pln ?? 0,
    by_category: breakdown,
  });
});
