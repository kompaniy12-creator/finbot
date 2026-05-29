// Verify api-stats and api-transactions return correct EUR values.
// Pulls one EUR rate from exchange_rates, picks a real expense row,
// and asserts amount_eur ≈ amount_pln / eur_rate_at_date.

const url = `https://${Deno.env.get("SUPABASE_PROJECT_REF")}.supabase.co`;
const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const adminTid = Number(Deno.env.get("TELEGRAM_ADMIN_TELEGRAM_ID")!);

async function sb(path: string): Promise<unknown> {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: sbKey, authorization: `Bearer ${sbKey}` },
  });
  return await r.json();
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key.buffer.slice(0) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

const params: Record<string, string> = {
  user: JSON.stringify({ id: adminTid, first_name: "EurVerify" }),
  auth_date: String(Math.floor(Date.now() / 1000)),
};
const keys = Object.keys(params).sort();
const dcs = keys.map((k) => `${k}=${params[k]}`).join("\n");
const secretKey = await hmac(new TextEncoder().encode("WebAppData"), botToken);
const sig = await hmac(secretKey, dcs);
const hash = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
const sp = new URLSearchParams();
for (const k of keys) sp.set(k, params[k]);
sp.set("hash", hash);
const initData = sp.toString();

async function call(path: string): Promise<unknown> {
  const r = await fetch(`${url}/functions/v1/${path}`, {
    headers: { "x-telegram-init-data": initData },
  });
  return await r.json();
}

// 1. api-stats month
const stats = await call("api-stats?period=month") as Record<string, unknown>;
console.log("api-stats month:", {
  total_pln: stats.total_pln,
  total_eur: stats.total_eur,
  count: stats.count,
});

// 2. api-transactions: pick first item, verify amount_eur matches per-date rate
const tx = await call("api-transactions?limit=5") as { items: Array<Record<string, unknown>> };
console.log(`\napi-transactions first ${Math.min(3, tx.items.length)}:`);
for (const it of tx.items.slice(0, 3)) {
  const date = it.expense_date as string;
  const rates = await sb(
    `exchange_rates?currency=eq.EUR&rate_date=lte.${date}&order=rate_date.desc&limit=1&select=rate_date,rate_pln`,
  ) as Array<{ rate_date: string; rate_pln: number }>;
  const rate = rates[0]?.rate_pln;
  const expectedEur = rate ? Math.round((Number(it.amount_pln) / Number(rate)) * 100) / 100 : null;
  const ok = expectedEur === it.amount_eur ? "OK" : "MISMATCH";
  console.log(
    `  ${date}  pln=${it.amount_pln}  eur=${it.amount_eur}  expected=${expectedEur} (rate ${rate} from ${
      rates[0]?.rate_date
    }) [${ok}]`,
  );
}

// 3. Sanity: total_eur ≈ sum(amount_eur over all unarchived rows in period)
// Pull aggregated rows directly via REST.
const monthStart = stats.period_start as string;
const all = await sb(
  `expenses?archived=eq.false&expense_date=gte.${monthStart}&select=amount_pln,expense_date`,
) as Array<{ amount_pln: number; expense_date: string }>;
const uniqueDates = [...new Set(all.map((r) => r.expense_date))];
const rateMap = new Map<string, number>();
for (const d of uniqueDates) {
  const r = await sb(
    `exchange_rates?currency=eq.EUR&rate_date=lte.${d}&order=rate_date.desc&limit=1&select=rate_pln`,
  ) as Array<{ rate_pln: number }>;
  if (r[0]) rateMap.set(d, Number(r[0].rate_pln));
}
let expectedTotalEur = 0;
for (const r of all) {
  const rate = rateMap.get(r.expense_date);
  if (rate) expectedTotalEur += Number(r.amount_pln) / rate;
}
expectedTotalEur = Math.round(expectedTotalEur * 100) / 100;
const diff = Math.abs(expectedTotalEur - (stats.total_eur as number));
console.log(
  `\ntotal_eur cross-check: api=${stats.total_eur}  local=${expectedTotalEur}  diff=${
    diff.toFixed(4)
  }`,
);
if (diff < 0.1) console.log("PASS");
else {
  console.log("FAIL");
  Deno.exit(1);
}
