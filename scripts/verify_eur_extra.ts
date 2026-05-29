// Extra coverage:
// (1) api-receipt-items returns correct EUR for a real receipt
// (2) Spot-check a non-PLN source row (e.g. currency != 'PLN'): the
//     stored amount_pln was computed at insert from the source rate, so
//     amount_eur via per-date EUR rate should still match amount_pln / eur_rate.

const url = `https://${Deno.env.get("SUPABASE_PROJECT_REF")}.supabase.co`;
const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const adminTid = Number(Deno.env.get("TELEGRAM_ADMIN_TELEGRAM_ID")!);

async function rest(path: string): Promise<unknown> {
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
const params = {
  user: JSON.stringify({ id: adminTid, first_name: "EurExtra" }),
  auth_date: String(Math.floor(Date.now() / 1000)),
};
const keys = Object.keys(params).sort() as Array<keyof typeof params>;
const dcs = keys.map((k) => `${k}=${params[k]}`).join("\n");
const sk = await hmac(new TextEncoder().encode("WebAppData"), botToken);
const sig = await hmac(sk, dcs);
const hash = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
const sp = new URLSearchParams();
for (const k of keys) sp.set(k, params[k]);
sp.set("hash", hash);
const initData = sp.toString();

async function callApi(path: string): Promise<unknown> {
  return (await fetch(`${url}/functions/v1/${path}`, {
    headers: { "x-telegram-init-data": initData },
  })).json();
}

// (1) Get an existing non-archived receipt
const recs = await rest(
  "receipts?archived=eq.false&select=id,merchant,total,currency,total_pln,receipt_date&limit=1",
) as Array<{
  id: string;
  merchant: string | null;
  total: number;
  currency: string;
  total_pln: number;
  receipt_date: string;
}>;
if (recs.length === 0) {
  console.log("no real receipt -> skipping receipt-items check");
} else {
  const rec = recs[0];
  console.log(
    `receipt: ${rec.merchant} (${rec.id}) ${rec.total} ${rec.currency} on ${rec.receipt_date}`,
  );
  const eurRate = (await rest(
    `exchange_rates?currency=eq.EUR&rate_date=lte.${rec.receipt_date}&order=rate_date.desc&limit=1&select=rate_date,rate_pln`,
  )) as Array<{ rate_date: string; rate_pln: number }>;
  const expectedTotalEur = eurRate[0]
    ? Math.round((Number(rec.total_pln) / Number(eurRate[0].rate_pln)) * 100) / 100
    : null;
  const body = await callApi(`api-receipt-items?id=${rec.id}`) as {
    receipt: { total_pln: number; total_eur: number };
    items: Array<{ id: string; name: string; amount_pln: number; amount_eur: number }>;
  };
  console.log(
    `  api total_pln=${body.receipt.total_pln} total_eur=${body.receipt.total_eur} expected_total_eur=${expectedTotalEur}`,
  );
  console.log(`  ${body.items.length} line(s):`);
  for (const it of body.items.slice(0, 5)) {
    const expectedLineEur = eurRate[0]
      ? Math.round((Number(it.amount_pln) / Number(eurRate[0].rate_pln)) * 100) / 100
      : null;
    const ok = expectedLineEur === it.amount_eur ? "OK" : "MISMATCH";
    console.log(
      `    "${it.name}" pln=${it.amount_pln} eur=${it.amount_eur} expected=${expectedLineEur} [${ok}]`,
    );
  }
}

// (2) Spot-check: any expense where currency != 'PLN'?
const nonPln = await rest(
  "expenses?archived=eq.false&currency=neq.PLN&select=id,name,amount,currency,amount_pln,expense_date&limit=3",
) as Array<{
  id: string;
  name: string;
  amount: number;
  currency: string;
  amount_pln: number;
  expense_date: string;
}>;
if (nonPln.length === 0) {
  console.log("\n(no non-PLN source rows in DB -> skipping)");
} else {
  console.log(`\nnon-PLN source rows: ${nonPln.length}`);
  for (const e of nonPln) {
    const eurRate = (await rest(
      `exchange_rates?currency=eq.EUR&rate_date=lte.${e.expense_date}&order=rate_date.desc&limit=1&select=rate_pln`,
    )) as Array<{ rate_pln: number }>;
    if (!eurRate[0]) continue;
    const expectedEur = Math.round((Number(e.amount_pln) / Number(eurRate[0].rate_pln)) * 100) /
      100;
    console.log(
      `  ${e.expense_date}  ${e.amount} ${e.currency} -> pln=${e.amount_pln}, expected_eur=${expectedEur}`,
    );
  }
}
