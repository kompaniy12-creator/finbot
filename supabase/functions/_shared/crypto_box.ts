// AES-256-GCM encryption for secrets at rest (tenant Anthropic/Groq API keys).
//
// The encryption key lives ONLY in the Edge runtime env (KEY_ENC_SECRET), never
// in the database. So a database dump - or anyone with read access to the
// `tenants` table - sees only ciphertext, not the keys. Decryption happens
// in-memory, only at the moment we make an AI call.
//
// Stored format: "v1:" + base64( iv(12 bytes) || ciphertext+GCM-tag ).
// Values without the "v1:" prefix are treated as legacy plaintext (written
// before encryption was added) and returned as-is, so nothing breaks during the
// rollout; they get re-encrypted the next time the user sets a key.

const PREFIX = "v1:";

let keyPromise: Promise<CryptoKey> | null = null;

function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const b64 = Deno.env.get("KEY_ENC_SECRET");
    if (!b64) throw new Error("KEY_ENC_SECRET not set");
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (raw.length !== 32) throw new Error("KEY_ENC_SECRET must decode to 32 bytes");
    keyPromise = crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }
  return keyPromise;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const buf = new Uint8Array(iv.length + ct.length);
  buf.set(iv, 0);
  buf.set(ct, iv.length);
  return PREFIX + toB64(buf);
}

// Decrypt a stored secret. Legacy plaintext (no "v1:" prefix) is returned as-is.
export async function decryptSecret(stored: string | null | undefined): Promise<string | null> {
  if (!stored) return null;
  if (!isEncrypted(stored)) return stored; // legacy plaintext
  const key = await getKey();
  const buf = Uint8Array.from(atob(stored.slice(PREFIX.length)), (c) => c.charCodeAt(0));
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
