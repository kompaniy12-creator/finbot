// One-shot e2e verifier for api-delete-item.
// 1) Insert a throwaway test expense for the admin family member (source=text).
// 2) Sign initData with the live TELEGRAM_BOT_TOKEN for the admin telegram_id.
// 3) POST /api-delete-item with kind=expense, id=<test row>.
// 4) Read back archived field; report.

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

// 1. Find admin member id + an existing category id.
const memR = await sb(
  `family_members?telegram_id=eq.${adminTid}&select=id,name,role`,
);
const members = await memR.json();
if (!members.length) throw new Error("no admin family member");
const adminId = members[0].id;
console.log(`admin: ${members[0].name} (${adminId})`);

const catR = await sb(`categories?select=id,name&limit=1`);
const cats = await catR.json();
const catId = cats[0].id;

// 2. Insert a test expense (archived=false).
const today = new Date().toISOString().slice(0, 10);
const insR = await sb("expenses", {
  method: "POST",
  body: JSON.stringify({
    name: "__delete_verify__",
    expense_date: today,
    amount: 1.23,
    currency: "PLN",
    amount_pln: 1.23,
    category_id: catId,
    family_member_id: adminId,
    source: "text",
    line_index: 999999, // avoid idempotency clash
  }),
});
if (!insR.ok) {
  console.error("insert failed", insR.status, await insR.text());
  Deno.exit(1);
}
const [row] = await insR.json();
console.log(`inserted test expense: ${row.id} (archived=${row.archived})`);

// 3. Sign initData for admin telegram_id.
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
const initData = sp.toString();

// 4. POST delete.
const delR = await fetch(`${url}/functions/v1/api-delete-item`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-telegram-init-data": initData,
  },
  body: JSON.stringify({ kind: "expense", id: row.id }),
});
console.log(`api-delete-item: HTTP ${delR.status}`);
console.log("response:", await delR.text());

// 5. Read back row to confirm.
const checkR = await sb(`expenses?id=eq.${row.id}&select=id,name,archived`);
const after = await checkR.json();
console.log("after-state:", after[0]);

// 6. Audit row?
const auditR = await sb(
  `expense_audit?expense_id=eq.${row.id}&select=action,created_at&order=created_at.asc`,
);
const audit = await auditR.json();
console.log("audit:", audit);

if (after[0]?.archived === true) {
  console.log("\nPASS: row is archived");
} else {
  console.log("\nFAIL: row is NOT archived");
  Deno.exit(1);
}
