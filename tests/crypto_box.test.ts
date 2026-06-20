import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { makeMockSb } from "./helpers/mock_sb.ts";

// Legacy v1 path reads KEY_ENC_SECRET from env.
Deno.env.set("KEY_ENC_SECRET", btoa("legacy-v1-key-32-bytes-long!!!!!"));

const { encryptSecret, decryptSecret, isEncrypted, shredTenantKeys } = await import(
  "../supabase/functions/_shared/crypto_box.ts"
);

const KEK = btoa("envelope-master-kek-32bytes-ok!!"); // 32 bytes -> base64
const T_A = "00000000-0000-0000-0000-0000000000aa";
const T_B = "00000000-0000-0000-0000-0000000000bb";

function sb() {
  return makeMockSb({ kekBase64: KEK }) as unknown as Parameters<typeof encryptSecret>[0];
}

Deno.test("crypto_box v2: encrypt -> decrypt round-trips", async () => {
  const s = sb();
  const secret = "sk-ant-api03-" + "x".repeat(40);
  const enc = await encryptSecret(s, T_A, secret);
  assertEquals(enc.startsWith("v2:"), true);
  assertEquals(isEncrypted(enc), true);
  assertNotEquals(enc, secret);
  assertEquals(await decryptSecret(s, T_A, enc), secret);
});

Deno.test("crypto_box v2: one DEK per tenant is created and reused", async () => {
  const s = sb();
  await encryptSecret(s, T_A, "a");
  await encryptSecret(s, T_A, "b");
  // Only one DEK row for the tenant.
  const store = (s as unknown as { _store: Record<string, unknown[]> })._store;
  assertEquals((store.tenant_deks ?? []).length, 1);
});

Deno.test("crypto_box v2: tenant B cannot decrypt tenant A ciphertext", async () => {
  const s = sb();
  const enc = await encryptSecret(s, T_A, "secret-A");
  // T_B has no DEK with A's key_id -> decryption fails.
  await assertRejects(() => decryptSecret(s, T_B, enc) as Promise<unknown>);
});

Deno.test("crypto_box: crypto-shred makes data unrecoverable", async () => {
  const s = sb();
  const enc = await encryptSecret(s, T_A, "shred-me");
  await shredTenantKeys(s, T_A);
  await assertRejects(() => decryptSecret(s, T_A, enc) as Promise<unknown>);
});

Deno.test("crypto_box: legacy v1 ciphertext still decrypts", async () => {
  // Produce a v1 blob the same way the old code did: AES-GCM under KEY_ENC_SECRET,
  // stored as "v1:" + base64(iv || ct+tag).
  const raw = Uint8Array.from(
    atob(btoa("legacy-v1-key-32-bytes-long!!!!!")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM" },
    false,
    [
      "encrypt",
    ],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode("old-secret") as BufferSource,
    ),
  );
  const buf = new Uint8Array(iv.length + ct.length);
  buf.set(iv, 0);
  buf.set(ct, iv.length);
  let b = "";
  for (const x of buf) b += String.fromCharCode(x);
  const v1 = "v1:" + btoa(b);
  assertEquals(await decryptSecret(sb(), T_A, v1), "old-secret");
});

Deno.test("crypto_box: legacy plaintext passes through; null -> null", async () => {
  const s = sb();
  assertEquals(await decryptSecret(s, T_A, "plain-legacy"), "plain-legacy");
  assertEquals(await decryptSecret(s, T_A, null), null);
  assertEquals(await decryptSecret(s, T_A, ""), null);
  assertEquals(isEncrypted("plain-legacy"), false);
});
