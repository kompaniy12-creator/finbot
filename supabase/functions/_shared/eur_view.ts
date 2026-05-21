// Per-date EUR/PLN rate lookup for dashboard projection.
//
// Stats and feed endpoints display totals in EUR. The DB stores amount_pln
// computed at insert time using the source-currency rate at the expense_date.
// To project back to EUR we use the EUR/PLN rate from THAT SAME expense_date,
// which preserves the original transaction value (no rate drift).
//
// If a requested date has no EUR rate stored (gap in cron-rates history or
// a future-dated entry), fall back to the nearest earlier rate. If no earlier
// rate exists at all, fall back to the nearest later rate.

import type { SupabaseClient } from "@supabase/supabase-js";

export type EurRateMap = Map<string, number>;

/**
 * Load EUR/PLN rate (PLN per 1 EUR) for each unique date in `dates`.
 * Missing dates use the nearest earlier rate; if none exist, the nearest later.
 * Returns an empty map when no EUR rates are stored at all.
 */
export async function loadEurRates(
  sb: SupabaseClient,
  dates: string[],
): Promise<EurRateMap> {
  const out: EurRateMap = new Map();
  if (dates.length === 0) return out;

  const all = await sb
    .from("exchange_rates")
    .select("rate_date, rate_pln")
    .eq("currency", "EUR")
    .order("rate_date", { ascending: true });
  const rows = (all.data ?? []) as Array<{ rate_date: string; rate_pln: number }>;
  if (rows.length === 0) return out;

  // rows is sorted ascending; build prefix list for binary-search-style lookup.
  const dateStrs = rows.map((r) => r.rate_date);
  const rates = rows.map((r) => Number(r.rate_pln));

  function rateFor(date: string): number {
    // Find the largest index i with dateStrs[i] <= date.
    let lo = 0, hi = dateStrs.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dateStrs[mid]! <= date) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0 ? rates[best]! : rates[0]!;
  }

  const unique = new Set(dates);
  for (const d of unique) out.set(d, rateFor(d));
  return out;
}

/**
 * Convert a PLN amount to EUR using the date's rate. Rounds to 2 decimals.
 * If the date has no rate (empty map), returns null so the caller can decide.
 */
export function plnToEur(
  amountPln: number,
  date: string,
  rates: EurRateMap,
): number | null {
  const rate = rates.get(date);
  if (!rate || rate <= 0) return null;
  return Math.round((amountPln / rate) * 100) / 100;
}
