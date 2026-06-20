import { assertEquals, assertNotEquals } from "@std/assert";

// 32-byte key (base64) for the test runtime.
Deno.env.set("KEY_ENC_SECRET", btoa("secret-test-key-32-bytes-long!!!"));

const { encryptSecret, decryptSecret, isEncrypted } = await import(
  "../supabase/functions/_shared/crypto_box.ts"
);

Deno.test("crypto_box: encrypt -> decrypt round-trips", async () => {
  const secret = "sk-ant-api03-" + "x".repeat(40);
  const enc = await encryptSecret(secret);
  assertEquals(isEncrypted(enc), true);
  assertNotEquals(enc, secret);
  assertEquals(await decryptSecret(enc), secret);
});

Deno.test("crypto_box: same plaintext yields different ciphertext (random IV)", async () => {
  const a = await encryptSecret("gsk_abc123");
  const b = await encryptSecret("gsk_abc123");
  assertNotEquals(a, b);
  assertEquals(await decryptSecret(a), "gsk_abc123");
  assertEquals(await decryptSecret(b), "gsk_abc123");
});

Deno.test("crypto_box: legacy plaintext (no prefix) passes through decrypt", async () => {
  assertEquals(await decryptSecret("sk-ant-legacy-plaintext"), "sk-ant-legacy-plaintext");
  assertEquals(isEncrypted("sk-ant-legacy-plaintext"), false);
});

Deno.test("crypto_box: null/empty decrypt -> null", async () => {
  assertEquals(await decryptSecret(null), null);
  assertEquals(await decryptSecret(undefined), null);
  assertEquals(await decryptSecret(""), null);
});

Deno.test("crypto_box: ciphertext is not human-readable", async () => {
  const enc = await encryptSecret("super-secret-value");
  assertEquals(enc.includes("super-secret-value"), false);
});
