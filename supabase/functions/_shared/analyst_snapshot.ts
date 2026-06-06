// Build a compact financial snapshot for the /ask analyst.
// The snapshot is the ONLY source of truth Claude sees - no DB access from
// the LLM. Aim for ~3-5 KB of JSON so Haiku handles it in a single call.

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysIso, todayWarsawIso } from "./dates.ts";
import { tenantDb } from "./tenant_db.ts";
import { loadEurRates, plnToEur } from "./eur_view.ts";

const CCY_ORDER = ["PLN", "EUR", "USD", "ALL"];

function sortCcy(entries: Array<[string, number]>): Array<[string, number]> {
  return entries.sort((a, b) => {
    const ia = CCY_ORDER.indexOf(a[0]);
    const ib = CCY_ORDER.indexOf(b[0]);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a[0].localeCompare(b[0]);
  });
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function previousMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const py = m === 1 ? y! - 1 : y!;
  const pm = m === 1 ? 12 : m! - 1;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

function lastDayOf(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${ym}-${String(d).padStart(2, "0")}`;
}

export interface AnalystSnapshot {
  today: string;
  family: Array<{ id: string; name: string; role: string }>;
  /**
   * Income side (kind='income' rows). Mirrors the expense fields but stays
   * separate so that "totals.eur" etc. continue to mean EXPENSES - the
   * analyst should never silently subtract one from the other unless asked
   * for the explicit `net_eur` field.
   */
  income: {
    month_to_date: { ym: string; eur: number; count: number; net_eur: number };
    previous_month: { ym: string; eur: number; count: number; net_eur: number };
    current_month: {
      by_category: Array<{ name: string; eur: number; count: number; pct: number }>;
      all: Array<{
        date: string;
        name: string;
        amount: number;
        currency: string;
        eur: number;
        category: string;
        member: string;
        source: string;
      }>;
    };
  };
  totals: {
    today: { eur: number; count: number; by_currency: Record<string, number> };
    week_to_date: { eur: number; count: number; days: number };
    month_to_date: {
      ym: string;
      eur: number;
      count: number;
      days_elapsed: number;
      days_in_month: number;
      forecast_eur: number;
      by_currency: Record<string, number>;
    };
    previous_month: {
      ym: string;
      eur: number;
      count: number;
      delta_eur: number;
      delta_pct: number | null;
    };
    last_6_months: Array<{ ym: string; eur: number; count: number }>;
  };
  current_month: {
    by_category: Array<{ name: string; eur: number; count: number; pct: number }>;
    by_member: Array<{ name: string; eur: number; count: number; pct: number }>;
    by_source: Array<{ source: string; eur: number; count: number }>;
    top_expenses: Array<{
      date: string;
      name: string;
      amount: number;
      currency: string;
      eur: number;
      category: string;
      member: string;
    }>;
    /** Full list of individual expense rows in the current month. */
    all_expenses: Array<{
      date: string;
      name: string;
      amount: number;
      currency: string;
      eur: number;
      category: string;
      member: string;
      source: string;
    }>;
  };
  previous_month_expenses: Array<{
    date: string;
    name: string;
    amount: number;
    currency: string;
    eur: number;
    category: string;
    member: string;
    source: string;
  }>;
  recent_receipts: Array<{
    date: string;
    merchant: string | null;
    total: number;
    currency: string;
    eur: number;
    item_count: number;
  }>;
  recurring_expenses: Array<{
    name: string;
    amount: number;
    currency: string;
    day_of_month: number;
    category: string;
    member: string;
    active: boolean;
  }>;
  categories: Array<{
    name: string;
    is_fallback: boolean;
    lifetime_count: number;
    lifetime_eur: number;
  }>;
}

/**
 * Build the snapshot. Heavy on parallel queries; returns in 1-2s in prod.
 */
export async function buildAnalystSnapshot(
  sb: SupabaseClient,
  tenantId: string,
): Promise<AnalystSnapshot> {
  const db = tenantDb(sb, tenantId);
  const today = todayWarsawIso();
  const monthYm = today.slice(0, 7);
  const monthStart = `${monthYm}-01`;
  const monthEnd = lastDayOf(monthYm);
  const prevYm = previousMonth(monthYm);
  const prevStart = `${prevYm}-01`;
  const prevEnd = lastDayOf(prevYm);

  // 6-month window for the trend; first day of 5 months ago.
  let trendStart = monthYm;
  for (let i = 0; i < 5; i++) trendStart = previousMonth(trendStart);
  const trendStartIso = `${trendStart}-01`;

  const weekStart = addDaysIso(today, -6);

  const [
    familyRes,
    catRes,
    trendExpRes,
    monthExpRes,
    prevMonthExpRes,
    receiptsRes,
    recurringRes,
    lifetimeByCatRes,
  ] = await Promise.all([
    db.from("family_members").select("id, name, role").eq("active", true),
    db.from("categories").select("id, name, is_fallback"),
    db.from("expenses")
      .select(
        "kind, amount, currency, amount_pln, category_id, family_member_id, source, expense_date",
      )
      .eq("archived", false)
      .gte("expense_date", trendStartIso)
      .lte("expense_date", today),
    db.from("expenses")
      .select(
        "id, kind, name, amount, currency, amount_pln, category_id, family_member_id, source, expense_date, receipt_id",
      )
      .eq("archived", false)
      .gte("expense_date", monthStart)
      .lte("expense_date", monthEnd),
    db.from("expenses")
      .select(
        "id, kind, name, amount, currency, amount_pln, category_id, family_member_id, source, expense_date",
      )
      .eq("archived", false)
      .gte("expense_date", prevStart)
      .lte("expense_date", prevEnd),
    db.from("receipts")
      .select("id, merchant, total, currency, total_pln, receipt_date")
      .eq("archived", false)
      .gte("receipt_date", weekStart)
      .lte("receipt_date", today)
      .order("created_at", { ascending: false })
      .limit(10),
    db.from("recurring_expenses")
      .select("name, amount, currency, day_of_month, active, category_id, family_member_id"),
    db.from("expenses")
      .select("kind, category_id, amount_pln")
      .eq("archived", false),
  ]);

  const family = (familyRes.data ?? []) as Array<{ id: string; name: string; role: string }>;
  const cats = (catRes.data ?? []) as Array<{
    id: string;
    name: string;
    is_fallback: boolean;
  }>;
  const trendRowsAll = (trendExpRes.data ?? []) as Array<{
    kind: "expense" | "income";
    amount: number;
    currency: string;
    amount_pln: number;
    category_id: string;
    family_member_id: string;
    source: string;
    expense_date: string;
  }>;
  // Existing aggregations were written before income existed; keep them
  // expense-only so "totals.month_to_date.eur" still means EXPENSES, not
  // a sneaky net number. Income gets its own parallel totals at the bottom.
  const trendRows = trendRowsAll.filter((r) => r.kind !== "income");
  const trendIncomeRows = trendRowsAll.filter((r) => r.kind === "income");

  const monthRowsAll = (monthExpRes.data ?? []) as Array<{
    id: string;
    kind: "expense" | "income";
    name: string;
    amount: number;
    currency: string;
    amount_pln: number;
    category_id: string;
    family_member_id: string;
    source: string;
    expense_date: string;
    receipt_id: string | null;
  }>;
  const monthRows = monthRowsAll.filter((r) => r.kind !== "income");
  const monthIncomeRows = monthRowsAll.filter((r) => r.kind === "income");

  const prevMonthRowsFullAll = (prevMonthExpRes.data ?? []) as Array<{
    id: string;
    kind: "expense" | "income";
    name: string;
    amount: number;
    currency: string;
    amount_pln: number;
    category_id: string;
    family_member_id: string;
    source: string;
    expense_date: string;
  }>;
  const prevMonthRowsFull = prevMonthRowsFullAll.filter((r) => r.kind !== "income");
  const prevMonthIncomeRowsFull = prevMonthRowsFullAll.filter((r) => r.kind === "income");
  const receipts = (receiptsRes.data ?? []) as Array<{
    id: string;
    merchant: string | null;
    total: number;
    currency: string;
    total_pln: number;
    receipt_date: string;
  }>;
  const recurring = (recurringRes.data ?? []) as Array<{
    name: string;
    amount: number;
    currency: string;
    day_of_month: number;
    active: boolean;
    category_id: string;
    family_member_id: string;
  }>;
  const lifetimeRows = (lifetimeByCatRes.data ?? []) as Array<{
    kind: "expense" | "income";
    category_id: string;
    amount_pln: number;
  }>;

  // EUR rates: collect every distinct date we'll convert through.
  const allDates = [
    ...trendRows.map((r) => r.expense_date),
    ...receipts.map((r) => r.receipt_date),
  ];
  const eurRates = await loadEurRates(sb, allDates);

  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const memberName = new Map(family.map((m) => [m.id, m.name]));

  // Helper: PLN amount + date -> EUR.
  const toEur = (pln: number, date: string) => plnToEur(Number(pln), date, eurRates) ?? 0;

  // --- 6-month trend buckets -----------------------------------------------
  const byMonthEur = new Map<string, { eur: number; count: number }>();
  for (const r of trendRows) {
    const ym = r.expense_date.slice(0, 7);
    const cur = byMonthEur.get(ym) ?? { eur: 0, count: 0 };
    cur.eur += toEur(Number(r.amount_pln), r.expense_date);
    cur.count++;
    byMonthEur.set(ym, cur);
  }
  // Materialise 6 months even if some are empty, so the LLM sees a stable shape.
  const last6: Array<{ ym: string; eur: number; count: number }> = [];
  let cursor = monthYm;
  for (let i = 0; i < 6; i++) {
    const v = byMonthEur.get(cursor) ?? { eur: 0, count: 0 };
    last6.unshift({ ym: cursor, eur: r2(v.eur), count: v.count });
    cursor = previousMonth(cursor);
  }

  // --- Today / week-to-date -----------------------------------------------
  const todayRows = monthRows.filter((r) => r.expense_date === today);
  const weekRows = trendRows.filter((r) => r.expense_date >= weekStart && r.expense_date <= today);
  let todayEur = 0;
  const todayByCcy = new Map<string, number>();
  for (const r of todayRows) {
    todayEur += toEur(Number(r.amount_pln), r.expense_date);
    todayByCcy.set(r.currency, (todayByCcy.get(r.currency) ?? 0) + Number(r.amount));
  }
  let weekEur = 0;
  const weekDays = new Set<string>();
  for (const r of weekRows) {
    weekEur += toEur(Number(r.amount_pln), r.expense_date);
    weekDays.add(r.expense_date);
  }

  // --- Month-to-date ------------------------------------------------------
  let monthEur = 0;
  const monthByCcy = new Map<string, number>();
  const monthByCatEur = new Map<string, number>();
  const monthByCatCount = new Map<string, number>();
  const monthByMemberEur = new Map<string, number>();
  const monthByMemberCount = new Map<string, number>();
  const monthBySourceEur = new Map<string, number>();
  const monthBySourceCount = new Map<string, number>();
  for (const r of monthRows) {
    const eur = toEur(Number(r.amount_pln), r.expense_date);
    monthEur += eur;
    monthByCcy.set(r.currency, (monthByCcy.get(r.currency) ?? 0) + Number(r.amount));
    monthByCatEur.set(r.category_id, (monthByCatEur.get(r.category_id) ?? 0) + eur);
    monthByCatCount.set(r.category_id, (monthByCatCount.get(r.category_id) ?? 0) + 1);
    monthByMemberEur.set(r.family_member_id, (monthByMemberEur.get(r.family_member_id) ?? 0) + eur);
    monthByMemberCount.set(
      r.family_member_id,
      (monthByMemberCount.get(r.family_member_id) ?? 0) + 1,
    );
    monthBySourceEur.set(r.source, (monthBySourceEur.get(r.source) ?? 0) + eur);
    monthBySourceCount.set(r.source, (monthBySourceCount.get(r.source) ?? 0) + 1);
  }

  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = Number(monthEnd.slice(8, 10));
  const forecastEur = dayOfMonth > 0 ? (monthEur / dayOfMonth) * daysInMonth : 0;

  // --- Previous month -----------------------------------------------------
  const prevRows = trendRows.filter((r) =>
    r.expense_date >= prevStart && r.expense_date <= prevEnd
  );
  let prevEur = 0;
  for (const r of prevRows) prevEur += toEur(Number(r.amount_pln), r.expense_date);
  const deltaEur = monthEur - prevEur;
  const deltaPct = prevEur > 0 ? (deltaEur / prevEur) * 100 : null;

  // --- Full month expense lists (current + previous) -----------------------
  // trendRows already includes both because the trend window covers 6 months,
  // so we slice from it instead of issuing extra queries.
  const decorate = (r: typeof trendRows[number] & { name?: string }) => ({
    date: r.expense_date,
    name: (r as { name?: string }).name ?? "",
    amount: Number(r.amount),
    currency: r.currency,
    eur: r2(toEur(Number(r.amount_pln), r.expense_date)),
    category: catName.get(r.category_id) ?? "?",
    member: memberName.get(r.family_member_id) ?? "?",
    source: r.source,
  });
  // Need `name` for individual rows: trendExpRes didn't select it, so use
  // monthRows for current month (which DOES have name + receipt_id), and
  // fetch previous month names separately.
  const allMonthExpenses = monthRows
    .map((r) => ({
      date: r.expense_date,
      name: r.name,
      amount: Number(r.amount),
      currency: r.currency,
      eur: r2(toEur(Number(r.amount_pln), r.expense_date)),
      category: catName.get(r.category_id) ?? "?",
      member: memberName.get(r.family_member_id) ?? "?",
      source: r.source,
    }))
    .sort((a, b) => a.date === b.date ? b.eur - a.eur : a.date < b.date ? 1 : -1);
  // Top expenses are now derived from the same list, sliced.
  const topExp = [...allMonthExpenses].sort((a, b) => b.eur - a.eur).slice(0, 30);
  void decorate;

  const prevMonthExpensesOut = prevMonthRowsFull
    .map((r) => ({
      date: r.expense_date,
      name: r.name,
      amount: Number(r.amount),
      currency: r.currency,
      eur: r2(toEur(Number(r.amount_pln), r.expense_date)),
      category: catName.get(r.category_id) ?? "?",
      member: memberName.get(r.family_member_id) ?? "?",
      source: r.source,
    }))
    .sort((a, b) => a.date === b.date ? b.eur - a.eur : a.date < b.date ? 1 : -1);

  // --- Recent receipts (already loaded) -----------------------------------
  // Need item_count per receipt.
  const receiptIds = receipts.map((r) => r.id);
  const countMap = new Map<string, number>();
  if (receiptIds.length > 0) {
    const cnt = await db.from("expenses")
      .select("receipt_id")
      .in("receipt_id", receiptIds)
      .eq("archived", false);
    for (const r of (cnt.data ?? []) as Array<{ receipt_id: string }>) {
      countMap.set(r.receipt_id, (countMap.get(r.receipt_id) ?? 0) + 1);
    }
  }
  const recentReceipts = receipts.map((r) => ({
    date: r.receipt_date,
    merchant: r.merchant,
    total: Number(r.total),
    currency: r.currency,
    eur: r2(toEur(Number(r.total_pln), r.receipt_date)),
    item_count: countMap.get(r.id) ?? 0,
  }));

  // --- Recurring ----------------------------------------------------------
  const recurringOut = recurring.map((r) => ({
    name: r.name,
    amount: Number(r.amount),
    currency: r.currency,
    day_of_month: r.day_of_month,
    category: catName.get(r.category_id) ?? "?",
    member: memberName.get(r.family_member_id) ?? "?",
    active: r.active,
  }));

  // --- Lifetime by category (expenses only) -------------------------------
  // Income rows aren't part of the spend lifetime number; they get their
  // own income-side aggregation above.
  const lifetimeByCat = new Map<string, { count: number; pln: number }>();
  for (const r of lifetimeRows) {
    if (r.kind === "income") continue;
    const cur = lifetimeByCat.get(r.category_id) ?? { count: 0, pln: 0 };
    cur.count++;
    cur.pln += Number(r.amount_pln);
    lifetimeByCat.set(r.category_id, cur);
  }

  // Convert lifetime PLN to EUR using today's rate (approximation; cheap).
  const todayEurRate = (await loadEurRates(sb, [today])).get(today) ?? null;
  const plnToEurApprox = (pln: number) => todayEurRate && todayEurRate > 0 ? pln / todayEurRate : 0;

  const categoriesOut = cats.map((c) => {
    const lt = lifetimeByCat.get(c.id) ?? { count: 0, pln: 0 };
    return {
      name: c.name,
      is_fallback: c.is_fallback,
      lifetime_count: lt.count,
      lifetime_eur: r2(plnToEurApprox(lt.pln)),
    };
  }).sort((a, b) => b.lifetime_eur - a.lifetime_eur);

  const byCategoryCurrentMonth = cats
    .map((c) => {
      const eur = monthByCatEur.get(c.id) ?? 0;
      return {
        name: c.name,
        eur: r2(eur),
        count: monthByCatCount.get(c.id) ?? 0,
        pct: monthEur > 0 ? Math.round((eur / monthEur) * 1000) / 10 : 0,
      };
    })
    .filter((x) => x.eur > 0 || x.count > 0)
    .sort((a, b) => b.eur - a.eur);

  const byMemberCurrentMonth = family
    .map((m) => {
      const eur = monthByMemberEur.get(m.id) ?? 0;
      return {
        name: m.name,
        eur: r2(eur),
        count: monthByMemberCount.get(m.id) ?? 0,
        pct: monthEur > 0 ? Math.round((eur / monthEur) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.eur - a.eur);

  const bySourceCurrentMonth = ["text", "voice", "photo"].map((s) => ({
    source: s,
    eur: r2(monthBySourceEur.get(s) ?? 0),
    count: monthBySourceCount.get(s) ?? 0,
  }));

  // --- Income totals (parallel pipeline; expense totals above stay pure) ---
  let monthIncomeEur = 0;
  for (const r of monthIncomeRows) {
    monthIncomeEur += toEur(Number(r.amount_pln), r.expense_date);
  }
  let prevIncomeEur = 0;
  for (const r of prevMonthIncomeRowsFull) {
    prevIncomeEur += toEur(Number(r.amount_pln), r.expense_date);
  }
  void trendIncomeRows;

  const monthIncomeByCatEur = new Map<string, number>();
  const monthIncomeByCatCount = new Map<string, number>();
  for (const r of monthIncomeRows) {
    const eur = toEur(Number(r.amount_pln), r.expense_date);
    monthIncomeByCatEur.set(r.category_id, (monthIncomeByCatEur.get(r.category_id) ?? 0) + eur);
    monthIncomeByCatCount.set(
      r.category_id,
      (monthIncomeByCatCount.get(r.category_id) ?? 0) + 1,
    );
  }
  const incomeByCategoryCurrentMonth = cats
    .map((c) => {
      const eur = monthIncomeByCatEur.get(c.id) ?? 0;
      return {
        name: c.name,
        eur: r2(eur),
        count: monthIncomeByCatCount.get(c.id) ?? 0,
        pct: monthIncomeEur > 0 ? Math.round((eur / monthIncomeEur) * 1000) / 10 : 0,
      };
    })
    .filter((x) => x.eur > 0 || x.count > 0)
    .sort((a, b) => b.eur - a.eur);

  const allMonthIncome = monthIncomeRows
    .map((r) => ({
      date: r.expense_date,
      name: r.name,
      amount: Number(r.amount),
      currency: r.currency,
      eur: r2(toEur(Number(r.amount_pln), r.expense_date)),
      category: catName.get(r.category_id) ?? "?",
      member: memberName.get(r.family_member_id) ?? "?",
      source: r.source,
    }))
    .sort((a, b) => a.date === b.date ? b.eur - a.eur : a.date < b.date ? 1 : -1);

  return {
    today,
    family: family.map((m) => ({ id: m.id, name: m.name, role: m.role })),
    income: {
      month_to_date: {
        ym: monthYm,
        eur: r2(monthIncomeEur),
        count: monthIncomeRows.length,
        net_eur: r2(monthIncomeEur - monthEur),
      },
      previous_month: {
        ym: prevYm,
        eur: r2(prevIncomeEur),
        count: prevMonthIncomeRowsFull.length,
        net_eur: r2(prevIncomeEur - prevEur),
      },
      current_month: {
        by_category: incomeByCategoryCurrentMonth,
        all: allMonthIncome,
      },
    },
    totals: {
      today: {
        eur: r2(todayEur),
        count: todayRows.length,
        by_currency: Object.fromEntries(
          sortCcy([...todayByCcy.entries()]).map(([c, v]) => [c, r2(v)]),
        ),
      },
      week_to_date: {
        eur: r2(weekEur),
        count: weekRows.length,
        days: weekDays.size,
      },
      month_to_date: {
        ym: monthYm,
        eur: r2(monthEur),
        count: monthRows.length,
        days_elapsed: dayOfMonth,
        days_in_month: daysInMonth,
        forecast_eur: r2(forecastEur),
        by_currency: Object.fromEntries(
          sortCcy([...monthByCcy.entries()]).map(([c, v]) => [c, r2(v)]),
        ),
      },
      previous_month: {
        ym: prevYm,
        eur: r2(prevEur),
        count: prevRows.length,
        delta_eur: r2(deltaEur),
        delta_pct: deltaPct === null ? null : Math.round(deltaPct * 10) / 10,
      },
      last_6_months: last6,
    },
    current_month: {
      by_category: byCategoryCurrentMonth,
      by_member: byMemberCurrentMonth,
      by_source: bySourceCurrentMonth,
      top_expenses: topExp,
      all_expenses: allMonthExpenses,
    },
    previous_month_expenses: prevMonthExpensesOut,
    recent_receipts: recentReceipts,
    recurring_expenses: recurringOut,
    categories: categoriesOut,
  };
}
