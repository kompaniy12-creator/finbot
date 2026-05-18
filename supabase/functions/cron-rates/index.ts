// cron-rates: daily 05:00 UTC. Fetch today's rates for EUR, USD, ALL into
// exchange_rates table so the text pipeline does not block on first request.
// Idempotent: getRate is cache-first and skips if cached.

import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";
import { type Currency, getRate } from "../_shared/currency.ts";
import { todayWarsawIso } from "../_shared/dates.ts";

const CURRENCIES: Currency[] = ["EUR", "USD", "ALL"];

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) return new Response("forbidden", { status: 401 });
  const sb = adminClient();
  const today = todayWarsawIso();
  const results: Record<string, number | string> = {};
  for (const c of CURRENCIES) {
    try {
      const rate = await getRate(sb, c, today);
      results[c] = rate;
    } catch (err) {
      results[c] = `error: ${(err as Error).message}`;
      log("warn", "cron_rates_failed", { currency: c, error: (err as Error).message });
    }
  }
  log("info", "cron_rates_done", { date: today, ...results });
  return Response.json({ date: today, rates: results });
});
