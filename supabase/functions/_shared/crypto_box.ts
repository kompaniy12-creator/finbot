// Envelope encryption (KEK/DEK) for secrets at rest - tenant Anthropic/Groq API
// keys (P0.2).
//
//   KEK (master key)  -> Supabase Vault secret 'finbot_kek_v1', fetched via the
//                        get_kek() RPC (service_role only). Never in a data
//                        table, never in git.
//   DEK (per tenant)  -> random 256-bit key, stored WRAPPED (AES-GCM under the
//                        KEK) in tenant_deks. Generated on first use.
//   field ciphertext  -> AES-256-GCM under the tenant's DEK.
//
// Formats:
//   v2:<key_id>:<b64 iv>:<b64 ct>:<b64 tag>   - current (per-tenant DEK)
//   v1:<b64(iv|ct+tag)>                        - legacy (single KEY_ENC_SECRET);
//                                               still DECRYPTED for back-compat,
//                                               never written anymore.
//   <no prefix>                               - legacy plaintext, returned as-is.
//
// Crypto-shred: deleting a tenant's tenant_deks row makes its v2 data
// unrecoverable. KEK rotation re-wraps DEKs only; DEK rotation re-encrypts one
// tenant only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { tenantDb } from "./tenant_db.ts";

const KEK_NAME = "finbot_kek_v1";
const CURRENT_KEY_ID = "dek1";

// ---- key import helpers ---------------------------------------------------

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function aesEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: Uint8Array; ct: Uint8Array; tag: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  // WebCrypto appends the 16-byte GCM tag to the ciphertext.
  return { iv, ct: out.slice(0, out.length - 16), tag: out.slice(out.length - 16) };
}

async function aesDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ct: Uint8Array,
  tag: Uint8Array,
): Promise<Uint8Array> {
  const buf = new Uint8Array(ct.length + tag.length);
  buf.set(ct, 0);
  buf.set(tag, ct.length);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      buf as BufferSource,
    ),
  );
}

// ---- KEK (from Vault) -----------------------------------------------------

let kekPromise: Promise<CryptoKey> | null = null;
function getKEK(sb: SupabaseClient): Promise<CryptoKey> {
  if (!kekPromise) {
    kekPromise = (async () => {
      const r = await sb.rpc("get_kek", { p_name: KEK_NAME });
      const b64 = r.data as string | null;
      if (r.error || !b64) throw new Error("KEK unavailable from Vault");
      const raw = b64decode(b64);
      if (raw.length !== 32) throw new Error("KEK must be 32 bytes");
      return await importAesKey(raw);
    })();
  }
  return kekPromise;
}

// ---- per-tenant DEK -------------------------------------------------------

// Cache unwrapped DEKs in-memory per invocation, keyed by `${tenantId}:${keyId}`.
const dekCache = new Map<string, CryptoKey>();

interface DekRow {
  key_id: string;
  wrapped_dek: string; // "<iv>:<ct>:<tag>" base64
}

async function unwrapDek(sb: SupabaseClient, wrapped: string): Promise<Uint8Array> {
  const [ivB, ctB, tagB] = wrapped.split(":");
  const kek = await getKEK(sb);
  return await aesDecrypt(kek, b64decode(ivB!), b64decode(ctB!), b64decode(tagB!));
}

// Get (or create) the active DEK for a tenant, returned as an imported key.
async function getActiveDek(
  sb: SupabaseClient,
  tenantId: string,
): Promise<{ keyId: string; key: CryptoKey }> {
  const db = tenantDb(sb, tenantId);
  const existing = await db.from("tenant_deks")
    .select("key_id, wrapped_dek")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = existing.data as DekRow | null;
  if (row) {
    const cacheKey = `${tenantId}:${row.key_id}`;
    let key = dekCache.get(cacheKey);
    if (!key) {
      key = await importAesKey(await unwrapDek(sb, row.wrapped_dek));
      dekCache.set(cacheKey, key);
    }
    return { keyId: row.key_id, key };
  }
  // First use: generate a DEK, wrap it under the KEK, persist.
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const kek = await getKEK(sb);
  const w = await aesEncrypt(kek, dek);
  const wrapped = `${b64encode(w.iv)}:${b64encode(w.ct)}:${b64encode(w.tag)}`;
  const ins = await db.from("tenant_deks").insert({
    key_id: CURRENT_KEY_ID,
    wrapped_dek: wrapped,
    active: true,
  });
  if (ins.error) throw new Error(`could not create DEK: ${ins.error.message}`);
  const key = await importAesKey(dek);
  dekCache.set(`${tenantId}:${CURRENT_KEY_ID}`, key);
  return { keyId: CURRENT_KEY_ID, key };
}

// Resolve a specific DEK (by key_id) for decryption of older ciphertext.
async function getDekById(
  sb: SupabaseClient,
  tenantId: string,
  keyId: string,
): Promise<CryptoKey> {
  const cacheKey = `${tenantId}:${keyId}`;
  const cached = dekCache.get(cacheKey);
  if (cached) return cached;
  const db = tenantDb(sb, tenantId);
  const r = await db.from("tenant_deks").select("wrapped_dek").eq("key_id", keyId).maybeSingle();
  const row = r.data as { wrapped_dek: string } | null;
  if (!row) throw new Error(`DEK ${keyId} not found (crypto-shredded?)`);
  const key = await importAesKey(await unwrapDek(sb, row.wrapped_dek));
  dekCache.set(cacheKey, key);
  return key;
}

// ---- legacy v1 (single KEY_ENC_SECRET) ------------------------------------

let v1KeyPromise: Promise<CryptoKey> | null = null;
function getV1Key(): Promise<CryptoKey> {
  if (!v1KeyPromise) {
    const b64 = Deno.env.get("KEY_ENC_SECRET");
    if (!b64) throw new Error("KEY_ENC_SECRET not set");
    const raw = b64decode(b64);
    if (raw.length !== 32) throw new Error("KEY_ENC_SECRET must decode to 32 bytes");
    v1KeyPromise = importAesKey(raw);
  }
  return v1KeyPromise;
}

async function decryptV1(stored: string): Promise<string> {
  const key = await getV1Key();
  const buf = b64decode(stored.slice("v1:".length));
  const iv = buf.slice(0, 12);
  const rest = buf.slice(12); // ct + tag
  const dec = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    rest as BufferSource,
  );
  return new TextDecoder().decode(dec);
}

// ---- public API -----------------------------------------------------------

export function isEncrypted(value: string): boolean {
  return value.startsWith("v1:") || value.startsWith("v2:");
}

// Encrypt a secret for a tenant using its DEK. Always produces v2.
export async function encryptSecret(
  sb: SupabaseClient,
  tenantId: string,
  plaintext: string,
): Promise<string> {
  const { keyId, key } = await getActiveDek(sb, tenantId);
  const { iv, ct, tag } = await aesEncrypt(key, new TextEncoder().encode(plaintext));
  return `v2:${keyId}:${b64encode(iv)}:${b64encode(ct)}:${b64encode(tag)}`;
}

// Decrypt a stored secret. Handles v2 (per-tenant DEK), v1 (legacy single key),
// and legacy plaintext (returned as-is).
export async function decryptSecret(
  sb: SupabaseClient,
  tenantId: string,
  stored: string | null | undefined,
): Promise<string | null> {
  if (!stored) return null;
  if (stored.startsWith("v2:")) {
    const [, keyId, ivB, ctB, tagB] = stored.split(":");
    const key = await getDekById(sb, tenantId, keyId!);
    const pt = await aesDecrypt(key, b64decode(ivB!), b64decode(ctB!), b64decode(tagB!));
    return new TextDecoder().decode(pt);
  }
  if (stored.startsWith("v1:")) return await decryptV1(stored);
  return stored; // legacy plaintext
}

// Crypto-shred: drop a tenant's DEK(s) so all their v2 ciphertext becomes
// unrecoverable. Used for account/key deletion (GDPR right to erasure).
export async function shredTenantKeys(sb: SupabaseClient, tenantId: string): Promise<void> {
  for (const k of dekCache.keys()) {
    if (k.startsWith(`${tenantId}:`)) dekCache.delete(k);
  }
  const db = tenantDb(sb, tenantId);
  await db.from("tenant_deks").delete().eq("tenant_id", tenantId);
}
