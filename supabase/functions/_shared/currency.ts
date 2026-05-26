// Currency conversion: fetches rates from NBP (PLN/EUR/USD) and
// exchangerate.host (ALL/others), caches in exchange_rates table.
//
// Per SPEC §7 + §6.1: fallback to last working day on 404 (holidays/weekends).

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysIso } from "./dates.ts";
import { log } from "./log.ts";

export type Currency = "PLN" | "EUR" | "ALL" | "USD";

export class RateUnavailableError extends Error {
  constructor(public currency: string, public date: string, public scope: string) {
    super(`Rate unavailable for ${currency}@${date} (${scope})`);
    this.name = "RateUnavailableError";
  }
}

const NBP_FALLBACK_DEPTH = 14; // try up to 2 weeks back on holidays

/**
 * Source of truth for rate fetching. Returns rate per 1 unit of `currency`
 * expressed in PLN. For PLN itself, returns 1.0. For unknown currencies,
 * throws RateUnavailableError.
 */
export async function getRate(
  sb: SupabaseClient,
  currency: Currency,
  dateIso: string,
): Promise<number> {
  if (currency === "PLN") return 1.0;

  // 1. Cache lookup.
  const cached = await sb
    .from("exchange_rates")
    .select("rate_pln, is_fallback")
    .eq("rate_date", dateIso)
    .eq("currency", currency)
    .maybeSingle();
  if (cached.data) return Number((cached.data as { rate_pln: number }).rate_pln);

  // 2. Fetch from upstream with holiday fallback.
  try {
    return await fetchAndStore(sb, currency, dateIso);
  } catch (err) {
    // 3. Last resort: nearest-earlier rate already stored in the DB. Better
    //    than throwing (which forced callers to silently use rate=1.0 and
    //    inflated amount_pln by ~22x for ALL spending).
    const fallback = await sb
      .from("exchange_rates")
      .select("rate_date, rate_pln")
      .eq("currency", currency)
      .lte("rate_date", dateIso)
      .order("rate_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (fallback.data) {
      const row = fallback.data as { rate_date: string; rate_pln: number };
      log("warn", "currency_using_earlier_rate", {
        currency,
        requested: dateIso,
        used: row.rate_date,
      });
      return Number(row.rate_pln);
    }
    // 4. Nothing earlier in DB; try the earliest available (extrapolate).
    const earliest = await sb
      .from("exchange_rates")
      .select("rate_date, rate_pln")
      .eq("currency", currency)
      .order("rate_date", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (earliest.data) {
      const row = earliest.data as { rate_date: string; rate_pln: number };
      log("warn", "currency_using_later_rate", {
        currency,
        requested: dateIso,
        used: row.rate_date,
      });
      return Number(row.rate_pln);
    }
    throw err;
  }
}

async function fetchAndStore(
  sb: SupabaseClient,
  currency: Currency,
  dateIso: string,
): Promise<number> {
  if (currency === "EUR" || currency === "USD") {
    return await fetchNbp(sb, currency, dateIso);
  }
  if (currency === "ALL") {
    return await fetchExchangerateHost(sb, currency, dateIso);
  }
  throw new RateUnavailableError(currency, dateIso, "unsupported");
}

/**
 * NBP table A returns mid rates. URL:
 *   https://api.nbp.pl/api/exchangerates/rates/A/{CODE}/{YYYY-MM-DD}/?format=json
 * Returns 404 on weekends/holidays. We walk back up to NBP_FALLBACK_DEPTH days
 * and store with is_fallback=true if a previous-day rate was used.
 */
async function fetchNbp(
  sb: SupabaseClient,
  currency: "EUR" | "USD",
  dateIso: string,
): Promise<number> {
  let attempt = 0;
  let attemptDate = dateIso;
  while (attempt <= NBP_FALLBACK_DEPTH) {
    const url =
      `https://api.nbp.pl/api/exchangerates/rates/A/${currency}/${attemptDate}/?format=json`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (resp.status === 200) {
      const json = await resp.json() as { rates: Array<{ mid: number }> };
      const rate = json.rates[0]!.mid;
      const isFallback = attempt > 0;
      await sb.from("exchange_rates").insert({
        rate_date: dateIso,
        currency,
        rate_pln: rate,
        source: "nbp",
        is_fallback: isFallback,
        fallback_from_date: isFallback ? attemptDate : null,
      });
      return rate;
    }
    if (resp.status !== 404) {
      log("warn", "currency_nbp_unexpected_status", { status: resp.status, attemptDate });
    }
    attempt++;
    attemptDate = addDaysIso(attemptDate, -1);
  }
  throw new RateUnavailableError(currency, dateIso, "nbp_no_history");
}

/**
 * exchangerate.host is free, no API key needed. We pull PLN-based rates and
 * invert (since the API expresses rates relative to base).
 */
async function fetchExchangerateHost(
  sb: SupabaseClient,
  currency: Currency,
  dateIso: string,
): Promise<number> {
  const url = `https://api.exchangerate.host/${dateIso}?base=PLN&symbols=${currency}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (resp.status !== 200) {
    throw new RateUnavailableError(currency, dateIso, `exchangerate.host_${resp.status}`);
  }
  const json = await resp.json() as { rates?: Record<string, number>; success?: boolean };
  const ratePerPln = json.rates?.[currency];
  if (!ratePerPln || ratePerPln <= 0) {
    throw new RateUnavailableError(currency, dateIso, "exchangerate.host_no_rate");
  }
  const ratePln = 1 / ratePerPln;
  await sb.from("exchange_rates").insert({
    rate_date: dateIso,
    currency,
    rate_pln: ratePln,
    source: "exchangerate.host",
    is_fallback: false,
  });
  return ratePln;
}

/**
 * Convert amount in `from` currency to PLN at the date's rate.
 */
export async function toPln(
  sb: SupabaseClient,
  amount: number,
  from: Currency,
  dateIso: string,
): Promise<number> {
  const rate = await getRate(sb, from, dateIso);
  return Math.round(amount * rate * 100) / 100;
}
