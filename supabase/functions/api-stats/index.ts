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

  // Previous-period window for delta comparison: same length, ending the day
  // before the current window starts.
  const winStartMs = new Date(win.start + "T00:00:00Z").getTime();
  const winEndMs = new Date(win.end + "T00:00:00Z").getTime();
  const lenMs = winEndMs - winStartMs + 86_400_000; // inclusive day count
  const prevEndIso = new Date(winStartMs - 86_400_000).toISOString().slice(0, 10);
  const prevStartIso = new Date(winStartMs - lenMs).toISOString().slice(0, 10);

  // Family-wide visibility: every authenticated family member sees the joint
  // picture (totals, categories, transactions). Per-member edit/delete still
  // requires ownership or admin, but viewing is shared.
  void me;
  const [expRes, catRes, prevRes] = await Promise.all([
    sb.from("expenses")
      .select("amount, currency, amount_pln, category_id, expense_date")
      .eq("archived", false)
      .gte("expense_date", win.start)
      .lte("expense_date", win.end),
    sb.from("categories").select("id, name, is_fallback"),
    sb.from("expenses")
      .select("amount_pln, expense_date")
      .eq("archived", false)
      .gte("expense_date", prevStartIso)
      .lte("expense_date", prevEndIso),
  ]);
  const rows = (expRes.data ?? []) as Array<{
    amount: number;
    currency: string;
    amount_pln: number;
    category_id: string;
    expense_date: string;
  }>;
  const cats = (catRes.data ?? []) as Array<{
    id: string;
    name: string;
    is_fallback: boolean;
  }>;

  const prevRows = (prevRes.data ?? []) as Array<{
    amount_pln: number;
    expense_date: string;
  }>;

  const dates = [...rows.map((r) => r.expense_date), ...prevRows.map((r) => r.expense_date)];
  const eurRates = await loadEurRates(sb, dates);

  let prevTotalEur = 0;
  for (const r of prevRows) {
    prevTotalEur += plnToEur(Number(r.amount_pln), r.expense_date, eurRates) ?? 0;
  }
  const prevCount = prevRows.length;

  let totalPln = 0;
  let totalEur = 0;
  const byCatPln = new Map<string, number>();
  const byCatEur = new Map<string, number>();
  const byCatCount = new Map<string, number>();
  const byDayEur = new Map<string, number>();
  const byCurrency = new Map<string, number>(); // source-currency totals
  for (const r of rows) {
    const pln = Number(r.amount_pln);
    const eur = plnToEur(pln, r.expense_date, eurRates) ?? 0;
    totalPln += pln;
    totalEur += eur;
    byCatPln.set(r.category_id, (byCatPln.get(r.category_id) ?? 0) + pln);
    byCatEur.set(r.category_id, (byCatEur.get(r.category_id) ?? 0) + eur);
    byCatCount.set(r.category_id, (byCatCount.get(r.category_id) ?? 0) + 1);
    byDayEur.set(r.expense_date, (byDayEur.get(r.expense_date) ?? 0) + eur);
    byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + Number(r.amount));
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

  // Delta vs previous-period: percent shift in EUR + absolute count diff.
  // null when there is no comparable previous data.
  const prevEurRounded = Math.round(prevTotalEur * 100) / 100;
  const deltaEur = Math.round((totalEur - prevTotalEur) * 100) / 100;
  const deltaCount = count - prevCount;
  const deltaEurPct = prevEurRounded > 0
    ? Math.round(((totalEur - prevTotalEur) / prevTotalEur) * 1000) / 10
    : null;

  // Month-end forecast: linear extrapolation of the current pace to the
  // end of the active CALENDAR month. Only meaningful when the active
  // window is a month-to-date view, so we gate it.
  let forecastTotalEur: number | null = null;
  let forecastDaysRemaining: number | null = null;
  if (win.period === "month" && win.end === today) {
    const monthYm = today.slice(0, 7);
    const [yy, mm] = monthYm.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(yy!, mm!, 0)).getUTCDate();
    const dayOfMonth = Number(today.slice(8, 10));
    if (dayOfMonth > 0) {
      const avgPerDay = totalEur / dayOfMonth;
      forecastTotalEur = Math.round(avgPerDay * daysInMonth * 100) / 100;
      forecastDaysRemaining = daysInMonth - dayOfMonth;
    }
  }

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
    prev_period_start: prevStartIso,
    prev_period_end: prevEndIso,
    prev_total_eur: prevEurRounded,
    prev_count: prevCount,
    delta_eur: deltaEur,
    delta_count: deltaCount,
    delta_eur_pct: deltaEurPct,
    forecast_total_eur: forecastTotalEur,
    forecast_days_remaining: forecastDaysRemaining,
    by_category: breakdown,
    by_currency: [...byCurrency.entries()]
      .map(([currency, total]) => ({
        currency,
        total: Math.round(total * 100) / 100,
      }))
      // Stable order: PLN, EUR, USD, ALL, then anything else alphabetically.
      .sort((a, b) => {
        const order = ["PLN", "EUR", "USD", "ALL"];
        const ia = order.indexOf(a.currency);
        const ib = order.indexOf(b.currency);
        if (ia >= 0 && ib >= 0) return ia - ib;
        if (ia >= 0) return -1;
        if (ib >= 0) return 1;
        return a.currency.localeCompare(b.currency);
      }),
    by_day: [...byDayEur.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, total]) => ({
        date,
        total_eur: Math.round(total * 100) / 100,
      })),
  });
});
