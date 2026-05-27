// Receipt branch verifier: insert receipt + 2 lines, delete via api-delete-item,
// confirm receipt + both lines flipped to archived=true.

const url = `https://${Deno.env.get("SUPABASE_PROJECT_REF")}.supabase.co`;
const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const adminTid = Number(Deno.env.get("TELEGRAM_ADMIN_TELEGRAM_ID")!);

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      apikey: sbKey,
      authorization: `Bearer ${sbKey}`,
      "content-type": "application/json",
      prefer: "return=representation",
    },
  });
}

const memR = await sb(`family_members?telegram_id=eq.${adminTid}&select=id`);
const adminId = (await memR.json())[0].id;
const catR = await sb(`categories?select=id&limit=1`);
const catId = (await catR.json())[0].id;
const today = new Date().toISOString().slice(0, 10);

const recIns = await sb("receipts", {
  method: "POST",
  body: JSON.stringify({
    merchant: "__delete_verify_receipt__",
    receipt_date: today,
    currency: "PLN",
    total: 5.55,
    total_pln: 5.55,
    family_member_id: adminId,
  }),
});
const [rec] = await recIns.json();
console.log(`inserted receipt: ${rec.id}`);

const linesIns = await sb("expenses", {
  method: "POST",
  body: JSON.stringify([
    {
      name: "__verify_line_a__",
      expense_date: today,
      amount: 2.0,
      currency: "PLN",
      amount_pln: 2.0,
      category_id: catId,
      family_member_id: adminId,
      source: "photo",
      receipt_id: rec.id,
      line_index: 900001,
    },
    {
      name: "__verify_line_b__",
      expense_date: today,
      amount: 3.55,
      currency: "PLN",
      amount_pln: 3.55,
      category_id: catId,
      family_member_id: adminId,
      source: "photo",
      receipt_id: rec.id,
      line_index: 900002,
    },
  ]),
});
const lines = await linesIns.json();
console.log(`inserted lines: ${lines.map((l: { id: string }) => l.id).join(", ")}`);

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
  user: JSON.stringify({ id: adminTid, first_name: "VerifyBot" }),
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

const delR = await fetch(`${url}/functions/v1/api-delete-item`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-telegram-init-data": sp.toString(),
  },
  body: JSON.stringify({ kind: "receipt", id: rec.id }),
});
console.log(`api-delete-item: HTTP ${delR.status}`);
console.log("response:", await delR.text());

const after = await sb(`receipts?id=eq.${rec.id}&select=id,archived`).then((r) => r.json());
const afterLines = await sb(
  `expenses?receipt_id=eq.${rec.id}&select=id,archived&order=line_index`,
).then((r) => r.json());

console.log("receipt:", after[0]);
console.log("lines:", afterLines);

const allArchived = after[0]?.archived === true &&
  afterLines.every((l: { archived: boolean }) => l.archived === true);
if (allArchived) console.log("\nPASS: receipt + lines archived");
else {
  console.log("\nFAIL");
  Deno.exit(1);
}
