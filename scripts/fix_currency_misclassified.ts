// One-shot correction script for the misclassified records audited
// on 2026-05-26. See chat for the audit results.

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
  if (!r.ok && r.status !== 204) {
    throw new Error(`${r.status}: ${await r.text()}`);
  }
  if (r.status === 204) return null;
  return await r.json();
}

// Load ALL→PLN rate for a date with nearest-earlier (or earliest available) fallback.
const allRates = (await rest(
  `exchange_rates?currency=eq.ALL&select=rate_date,rate_pln&order=rate_date.asc`,
)) as Array<{ rate_date: string; rate_pln: number }>;
function allRateAt(date: string): number {
  // largest rate_date <= date, else earliest
  let best: { rate_date: string; rate_pln: number } | null = null;
  for (const r of allRates) {
    if (r.rate_date <= date) best = r;
    else break;
  }
  return Number((best ?? allRates[0]).rate_pln);
}

// 1) PLN → ALL flips by id-or-criteria. Each row identified by deterministic
//    fields so the script is idempotent (re-running on already-flipped rows
//    is a no-op since they no longer match currency=PLN).
const flips: Array<
  { name: string; amount: number; expense_date: string }
> = [
  { name: "Аптека", amount: 670.0, expense_date: "2026-05-26" },
  { name: "вода", amount: 3776.0, expense_date: "2026-04-30" },
  { name: "вода", amount: 4180.0, expense_date: "2026-03-31" },
  { name: "электричество за апрель 2026", amount: 5665.0, expense_date: "2026-04-30" },
  { name: "электричество за март 2026", amount: 9565.0, expense_date: "2026-03-31" },
];

for (const f of flips) {
  const found = (await rest(
    `expenses?source=eq.text&archived=eq.false&currency=eq.PLN` +
      `&name=eq.${encodeURIComponent(f.name)}` +
      `&amount=eq.${f.amount}&expense_date=eq.${f.expense_date}` +
      `&select=id,amount,currency,amount_pln`,
  )) as Array<{ id: string; amount: number; currency: string; amount_pln: number }>;
  if (found.length === 0) {
    console.log(`SKIP "${f.name}" ${f.amount} on ${f.expense_date}: not found (already fixed?)`);
    continue;
  }
  for (const row of found) {
    const rate = allRateAt(f.expense_date);
    const newPln = Math.round(row.amount * rate * 100) / 100;
    await rest(`expenses?id=eq.${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ currency: "ALL", amount_pln: newPln }),
    });
    console.log(
      `FLIP "${f.name}" ${row.amount} PLN -> ALL ` +
        `(amount_pln ${row.amount_pln} -> ${newPln}, rate ${rate})`,
    );
  }
}

// 2) Archive the 2 orphan duplicates of "Суп в ресторане" 400 PLN from the
//    cancelled high-amount flow. The third (already archived) is left alone.
const orphans = (await rest(
  `expenses?source=eq.text&archived=eq.false&currency=eq.PLN` +
    `&name=eq.${encodeURIComponent("Суп в ресторане")}&amount=eq.400` +
    `&expense_date=eq.2026-05-26&select=id,created_at`,
)) as Array<{ id: string; created_at: string }>;
for (const o of orphans) {
  await rest(`expenses?id=eq.${o.id}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
  console.log(`ARCHIVE orphan Суп в ресторане 400 PLN (${o.id} @ ${o.created_at})`);
}

console.log("\nDone.");
