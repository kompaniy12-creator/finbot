// Wait for the next receipt insert for the admin user and report verification.
// Polls every 3 seconds for up to 6 minutes. Exits when a new receipt appears
// or on timeout.

const url = `https://${Deno.env.get("SUPABASE_PROJECT_REF")}.supabase.co`;
const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const adminTid = Number(Deno.env.get("TELEGRAM_ADMIN_TELEGRAM_ID")!);

async function rest(path: string): Promise<unknown> {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: sbKey, authorization: `Bearer ${sbKey}` },
  });
  return await r.json();
}

const me = (await rest(`family_members?telegram_id=eq.${adminTid}&select=id`)) as Array<
  { id: string }
>;
const myId = me[0].id;

// Baseline: latest receipt id right now.
const baseline = (await rest(
  `receipts?family_member_id=eq.${myId}&order=created_at.desc&limit=1&select=id,created_at`,
)) as Array<{ id: string; created_at: string }>;
const baseAt = baseline[0]?.created_at ?? new Date(0).toISOString();
console.log(`watching for receipts after ${baseAt}...`);
console.log("Send the photo to the bot now. Will poll for 6 minutes.\n");

const deadline = Date.now() + 6 * 60_000;
let seen: string | null = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const rs = (await rest(
    `receipts?family_member_id=eq.${myId}&created_at=gt.${
      encodeURIComponent(baseAt)
    }&order=created_at.asc&limit=1&select=id,merchant,total,currency,receipt_date,items,created_at,photo_sha256`,
  )) as Array<{
    id: string;
    merchant: string | null;
    total: number;
    currency: string;
    receipt_date: string;
    items: unknown;
    created_at: string;
    photo_sha256: string | null;
  }>;
  if (rs.length > 0) {
    seen = rs[0].id;
    const r = rs[0];
    const ocrCount = Array.isArray(r.items) ? r.items.length : null;
    console.log(`+ new receipt: ${r.id}`);
    console.log(`  merchant=${r.merchant}  total=${r.total} ${r.currency}  date=${r.receipt_date}`);
    console.log(`  OCR items=${ocrCount}  hash=${r.photo_sha256 ? "set" : "null"}`);
    // Now wait briefly for the bulk insert to finish (single SQL but async).
    await new Promise((rs) => setTimeout(rs, 2000));
    const lines = (await rest(
      `expenses?receipt_id=eq.${r.id}&archived=eq.false&select=id,name,amount,currency,category_id,line_index&order=line_index.asc`,
    )) as Array<{
      id: string;
      name: string;
      amount: number;
      currency: string;
      category_id: string;
      line_index: number;
    }>;
    const cats = (await rest(`categories?select=id,name`)) as Array<{ id: string; name: string }>;
    const catName = new Map(cats.map((c) => [c.id, c.name]));
    console.log(`  saved lines: ${lines.length}`);
    for (const l of lines.slice(0, 5)) {
      console.log(
        `    [${l.line_index}] ${l.name} → ${catName.get(l.category_id) ?? "?"}: ${l.amount} ${l.currency}`,
      );
    }
    if (lines.length > 5) console.log(`    ... and ${lines.length - 5} more`);
    if (ocrCount !== null) {
      const verified = lines.length === ocrCount;
      console.log(
        `\n  VERIFICATION: ${verified ? "PASS" : "FAIL"} (${lines.length} / ${ocrCount})`,
      );
    }
    break;
  }
}
if (!seen) console.log("timed out after 6 minutes, no new receipt detected.");
