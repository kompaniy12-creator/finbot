// scripts/rotate_keys.ts - production key rotation / re-encryption tool (P1.1).
//
// Re-encrypts tenant API keys to the current envelope format (v2:). Reuses the
// SAME crypto_box the Edge runtime uses (via a real service-role supabase-js
// client), so there is no second crypto implementation to drift.
//
// Handles:
//   - legacy plaintext  -> v2
//   - legacy v1:        -> v2   (decrypted with KEY_ENC_SECRET)
//   - already v2:       -> skipped (idempotent; also makes the run resumable -
//                          a re-run after an interruption continues where it
//                          stopped because done rows are already v2)
//
// No downtime: rows are migrated one tenant at a time; the runtime keeps reading
// both v1: and v2: during the migration. Secrets are never logged.
//
// Usage:
//   deno run -A scripts/rotate_keys.ts [--dry-run] [--tenant <id|all>]
//       [--from-version v1|plaintext|any] [--batch-size N]
//
// Env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KEY_ENC_SECRET.

import { createClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "../supabase/functions/_shared/crypto_box.ts";

function arg(name: string, def?: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Deno.args[i + 1];
  return v && !v.startsWith("--") ? v : def;
}
const DRY = Deno.args.includes("--dry-run");
const ONLY_TENANT = arg("tenant", "all")!;
const FROM = arg("from-version", "any")!; // v1 | plaintext | any
const BATCH = Math.max(1, Number(arg("batch-size", "50")));

const URL = Deno.env.get("SUPABASE_URL");
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!URL || !KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required");
if (!Deno.env.get("KEY_ENC_SECRET")) throw new Error("KEY_ENC_SECRET required (legacy v1 reads)");

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const FIELDS = ["anthropic_api_key", "groq_api_key"] as const;

function version(v: string): "v2" | "v1" | "plaintext" {
  if (v.startsWith("v2:")) return "v2";
  if (v.startsWith("v1:")) return "v1";
  return "plaintext";
}

// Should this value be rotated, given the --from-version filter?
function shouldRotate(v: string | null): boolean {
  if (!v) return false;
  const ver = version(v);
  if (ver === "v2") return false; // already current -> idempotent skip
  if (FROM === "any") return true;
  return ver === FROM;
}

interface Tenant {
  id: string;
  anthropic_api_key: string | null;
  groq_api_key: string | null;
}

let scanned = 0, rotated = 0, fieldsRotated = 0, cursor = "";
console.log(`[rotate] start dry_run=${DRY} from=${FROM} tenant=${ONLY_TENANT} batch=${BATCH}`);

while (true) {
  let q = sb.from("tenants")
    .select("id, anthropic_api_key, groq_api_key")
    .order("id", { ascending: true })
    .limit(BATCH);
  if (cursor) q = q.gt("id", cursor);
  if (ONLY_TENANT !== "all") q = q.eq("id", ONLY_TENANT);
  const { data, error } = await q;
  if (error) throw new Error(`query failed: ${error.message}`);
  const rows = (data ?? []) as Tenant[];
  if (rows.length === 0) break;
  cursor = rows[rows.length - 1]!.id;

  for (const t of rows) {
    scanned++;
    const updates: Record<string, string> = {};
    for (const f of FIELDS) {
      const cur = t[f];
      if (!shouldRotate(cur)) continue;
      // Decrypt to validate (read-only). Catches undecryptable rows in dry-run.
      const plain = await decryptSecret(sb, t.id, cur);
      if (!plain) {
        console.warn(
          `[rotate] tenant=${t.id} field=${f} could not decrypt (${version(cur!)}) - skip`,
        );
        continue;
      }
      fieldsRotated++;
      if (DRY) {
        // Read-only: do NOT call encryptSecret (it would provision a DEK).
        console.log(`[rotate] tenant=${t.id} field=${f} ${version(cur!)} -> v2 (dry-run)`);
        continue;
      }
      updates[f] = await encryptSecret(sb, t.id, plain);
      console.log(`[rotate] tenant=${t.id} field=${f} ${version(cur!)} -> v2`);
    }
    if (Object.keys(updates).length === 0) continue;
    const upd = await sb.from("tenants").update(updates).eq("id", t.id);
    if (upd.error) throw new Error(`update tenant ${t.id} failed: ${upd.error.message}`);
    rotated++;
  }
  if (ONLY_TENANT !== "all") break;
}

console.log(
  `[rotate] done: scanned=${scanned} tenants_changed=${rotated} fields_rotated=${fieldsRotated}${
    DRY ? " (dry-run, nothing written)" : ""
  }`,
);
