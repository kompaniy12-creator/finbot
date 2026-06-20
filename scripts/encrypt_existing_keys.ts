// One-off: encrypt any tenant API keys that are still stored in plaintext
// (written before 0041/crypto_box). Reads KEY_ENC_SECRET + Supabase Management
// API creds from the environment, encrypts with the SAME crypto_box the Edge
// runtime uses, and updates the rows. Safe to re-run: already-encrypted values
// (prefixed "v1:") are skipped.
//
//   deno run --allow-env --allow-net scripts/encrypt_existing_keys.ts

import { encryptSecret, isEncrypted } from "../supabase/functions/_shared/crypto_box.ts";

const TOKEN = Deno.env.get("SUPABASE_ACCESS_TOKEN");
const REF = Deno.env.get("SUPABASE_PROJECT_REF");
if (!TOKEN || !REF) throw new Error("SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF required");

async function query(sql: string): Promise<unknown> {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`query failed ${r.status}: ${await r.text()}`);
  return await r.json();
}

const rows = await query(
  "select id, anthropic_api_key, groq_api_key from tenants " +
    "where anthropic_api_key is not null or groq_api_key is not null",
) as Array<{ id: string; anthropic_api_key: string | null; groq_api_key: string | null }>;

let updated = 0;
for (const row of rows) {
  const sets: string[] = [];
  if (row.anthropic_api_key && !isEncrypted(row.anthropic_api_key)) {
    sets.push(`anthropic_api_key = '${await encryptSecret(row.anthropic_api_key)}'`);
  }
  if (row.groq_api_key && !isEncrypted(row.groq_api_key)) {
    sets.push(`groq_api_key = '${await encryptSecret(row.groq_api_key)}'`);
  }
  if (sets.length === 0) continue;
  await query(`update tenants set ${sets.join(", ")} where id = '${row.id}'`);
  updated++;
  console.log(`encrypted keys for tenant ${row.id} (${sets.length} field(s))`);
}
console.log(`done: ${updated} tenant(s) updated, ${rows.length} scanned`);
