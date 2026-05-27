// Verify duplicate-receipt protection.
//
// Approach: create a synthetic non-archived receipt for the admin family
// member, then run the EXACT queries photo_pipeline uses (hash lookup +
// content fingerprint). Confirm they find the row. Then archive it and
// confirm the partial indexes correctly exclude archived rows. Cleanup.

const url = `https://${Deno.env.get("SUPABASE_PROJECT_REF")}.supabase.co`;
const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const adminTid = Number(Deno.env.get("TELEGRAM_ADMIN_TELEGRAM_ID")!);

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

function expect(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) Deno.exit(1);
}

const admins = await rest(
  `family_members?telegram_id=eq.${adminTid}&select=id`,
) as Array<{ id: string }>;
const adminId = admins[0].id;

// Synthetic input that uniquely identifies this run.
const HASH = "dedup_verify_" + crypto.randomUUID().replace(/-/g, "");
const MERCHANT = "DEDUP_VERIFY_" + Date.now();
const DATE = "2026-05-22";
const TOTAL = 12.34;
const CURRENCY = "PLN";

console.log("setup: inserting synthetic receipt...");
const [rec] = await rest("receipts", {
  method: "POST",
  body: JSON.stringify({
    merchant: MERCHANT,
    receipt_date: DATE,
    currency: CURRENCY,
    total: TOTAL,
    total_pln: TOTAL,
    photo_sha256: HASH,
    family_member_id: adminId,
  }),
}) as Array<{ id: string }>;
console.log("  receipt id:", rec.id);

// Layer 1: hash query (mirrors photo_pipeline.ts line "Layer 1").
const sinceIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
const l1 = await rest(
  `receipts?family_member_id=eq.${adminId}&archived=eq.false&photo_sha256=eq.${HASH}` +
    `&created_at=gte.${sinceIso}&limit=1&select=id,merchant`,
) as Array<{ id: string }>;
expect("Layer 1 (hash) finds the row", l1.length === 1 && l1[0].id === rec.id);

// Layer 1 negative: archived rows must NOT match.
await rest(`receipts?id=eq.${rec.id}`, {
  method: "PATCH",
  body: JSON.stringify({ archived: true }),
});
const l1arch = await rest(
  `receipts?family_member_id=eq.${adminId}&archived=eq.false&photo_sha256=eq.${HASH}` +
    `&created_at=gte.${sinceIso}&limit=1&select=id`,
) as Array<{ id: string }>;
expect("Layer 1 (hash) excludes archived rows", l1arch.length === 0);

// Re-activate for layer 2 check.
await rest(`receipts?id=eq.${rec.id}`, {
  method: "PATCH",
  body: JSON.stringify({ archived: false }),
});

// Layer 2: content-fingerprint query (mirrors "Layer 2" block).
const l2 = await rest(
  `receipts?family_member_id=eq.${adminId}&archived=eq.false` +
    `&merchant=eq.${encodeURIComponent(MERCHANT)}` +
    `&receipt_date=eq.${DATE}&currency=eq.${CURRENCY}&total=eq.${TOTAL}` +
    `&limit=1&select=id,merchant,total,currency,receipt_date`,
) as Array<{ id: string }>;
expect("Layer 2 (content fingerprint) finds the row", l2.length === 1 && l2[0].id === rec.id);

// Layer 2 negative: different total -> no match.
const l2miss = await rest(
  `receipts?family_member_id=eq.${adminId}&archived=eq.false` +
    `&merchant=eq.${encodeURIComponent(MERCHANT)}` +
    `&receipt_date=eq.${DATE}&currency=eq.${CURRENCY}&total=eq.99.99` +
    `&limit=1&select=id`,
) as Array<{ id: string }>;
expect("Layer 2 ignores different totals", l2miss.length === 0);

// Cleanup.
await rest(`receipts?id=eq.${rec.id}`, { method: "DELETE" });
console.log("\nAll dedup checks passed.");
