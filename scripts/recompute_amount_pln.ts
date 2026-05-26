// Recompute amount_pln for ALL/USD/EUR rows where amount==amount_pln,
// which is the fingerprint of the prior photo_pipeline silent-fallback to
// rate=1.0. Also fixes receipts.total_pln where the same bug fired.

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
  if (!r.ok && r.status !== 204) throw new Error(`${r.status}: ${await r.text()}`);
  if (r.status === 204) return null;
  return await r.json();
}

// Build per-currency lookup of stored rates.
async function loadRates(currency: string): Promise<Array<{ date: string; rate: number }>> {
  const r = (await rest(
    `exchange_rates?currency=eq.${currency}&select=rate_date,rate_pln&order=rate_date.asc`,
  )) as Array<{ rate_date: string; rate_pln: number }>;
  return r.map((x) => ({ date: x.rate_date, rate: Number(x.rate_pln) }));
}

function rateAt(rates: Array<{ date: string; rate: number }>, date: string): number | null {
  let best: { date: string; rate: number } | null = null;
  for (const r of rates) {
    if (r.date <= date) best = r;
    else break;
  }
  return best?.rate ?? rates[0]?.rate ?? null;
}

const rateCache = new Map<string, Array<{ date: string; rate: number }>>();
async function getRates(currency: string) {
  if (rateCache.has(currency)) return rateCache.get(currency)!;
  const r = await loadRates(currency);
  rateCache.set(currency, r);
  return r;
}

// 1) Expense rows.
const allExp = (await rest(
  `expenses?archived=eq.false&currency=neq.PLN&select=id,amount,currency,amount_pln,expense_date`,
)) as Array<{
  id: string;
  amount: number;
  currency: string;
  amount_pln: number;
  expense_date: string;
}>;
const broken = allExp.filter((e) => Number(e.amount) === Number(e.amount_pln));
console.log(`expenses with amount==amount_pln (broken rate fallback): ${broken.length}`);

let fixed = 0;
for (const e of broken) {
  const rates = await getRates(e.currency);
  const rate = rateAt(rates, e.expense_date);
  if (!rate) {
    console.log(`  SKIP ${e.id}: no ${e.currency} rate available`);
    continue;
  }
  const newPln = Math.round(Number(e.amount) * rate * 100) / 100;
  if (newPln === Number(e.amount_pln)) continue; // truly was 1:1
  await rest(`expenses?id=eq.${e.id}`, {
    method: "PATCH",
    body: JSON.stringify({ amount_pln: newPln }),
  });
  fixed++;
}
console.log(`expense rows updated: ${fixed}`);

// 2) Receipt totals.
const allRec = (await rest(
  `receipts?archived=eq.false&currency=neq.PLN&select=id,total,currency,total_pln,receipt_date`,
)) as Array<{
  id: string;
  total: number;
  currency: string;
  total_pln: number;
  receipt_date: string;
}>;
const recBroken = allRec.filter((r) => Number(r.total) === Number(r.total_pln));
console.log(`\nreceipts with total==total_pln: ${recBroken.length}`);

let recFixed = 0;
for (const r of recBroken) {
  const rates = await getRates(r.currency);
  const rate = rateAt(rates, r.receipt_date);
  if (!rate) continue;
  const newPln = Math.round(Number(r.total) * rate * 100) / 100;
  if (newPln === Number(r.total_pln)) continue;
  await rest(`receipts?id=eq.${r.id}`, {
    method: "PATCH",
    body: JSON.stringify({ total_pln: newPln }),
  });
  recFixed++;
}
console.log(`receipt totals updated: ${recFixed}`);

console.log("\nDone.");
