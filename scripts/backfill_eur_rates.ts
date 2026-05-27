// Backfill EUR/USD rates from NBP for all expense_date values missing in
// exchange_rates. Uses the same fallback-to-prev-workday logic as the
// production helper (since NBP returns 404 on weekends/holidays).

const url = `https://${Deno.env.get("SUPABASE_PROJECT_REF")}.supabase.co`;
const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rest(path: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      apikey: sbKey,
      authorization: `Bearer ${sbKey}`,
      "content-type": "application/json",
      prefer: "return=representation",
    },
  });
  if (!r.ok) throw new Error(`REST ${r.status}: ${await r.text()}`);
  return await r.json();
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function fetchNbp(
  currency: "EUR" | "USD",
  date: string,
): Promise<{ rate: number; fromDate: string; isFallback: boolean } | null> {
  let attempt = 0;
  let attemptDate = date;
  while (attempt <= 14) {
    const u =
      `https://api.nbp.pl/api/exchangerates/rates/A/${currency}/${attemptDate}/?format=json`;
    const r = await fetch(u, { headers: { Accept: "application/json" } });
    if (r.status === 200) {
      const j = await r.json() as { rates: Array<{ mid: number }> };
      return { rate: j.rates[0].mid, fromDate: attemptDate, isFallback: attempt > 0 };
    }
    if (r.status !== 404) console.warn(`NBP ${currency} ${attemptDate}: HTTP ${r.status}`);
    attempt++;
    attemptDate = addDays(attemptDate, -1);
  }
  return null;
}

// 1. Collect expense + receipt date ranges.
const expDates = (await rest(
  "expenses?archived=eq.false&select=expense_date",
)) as Array<{ expense_date: string }>;
const recDates = (await rest(
  "receipts?archived=eq.false&select=receipt_date",
)) as Array<{ receipt_date: string }>;
const needed = new Set<string>([
  ...expDates.map((e) => e.expense_date),
  ...recDates.map((r) => r.receipt_date),
]);
console.log(`unique dates referenced by rows: ${needed.size}`);

// 2. Find already-stored dates per currency.
const have = (await rest(
  "exchange_rates?currency=in.(EUR,USD)&select=currency,rate_date",
)) as Array<{ currency: string; rate_date: string }>;
const haveSet = new Set(have.map((h) => `${h.currency}|${h.rate_date}`));

// 3. For each missing (currency, date), fetch and insert.
let inserted = 0;
let skipped = 0;
for (const currency of ["EUR", "USD"] as const) {
  for (const d of needed) {
    if (haveSet.has(`${currency}|${d}`)) {
      skipped++;
      continue;
    }
    const r = await fetchNbp(currency, d);
    if (!r) {
      console.warn(`no NBP data for ${currency}@${d}`);
      continue;
    }
    await rest("exchange_rates", {
      method: "POST",
      body: JSON.stringify({
        rate_date: d,
        currency,
        rate_pln: r.rate,
        source: "nbp",
        is_fallback: r.isFallback,
        fallback_from_date: r.isFallback ? r.fromDate : null,
      }),
    });
    inserted++;
    console.log(
      `+ ${currency} ${d} = ${r.rate}${r.isFallback ? ` (fallback from ${r.fromDate})` : ""}`,
    );
  }
}
console.log(`\ndone: inserted=${inserted} skipped=${skipped}`);
