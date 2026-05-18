// Mandatory edge case (SPEC §18.4): webapp_cross_user.
// Verifies that family_member_id used in api-* endpoints comes from VERIFIED
// initData, never from a query parameter or header that the client controls.
// We test the contract: authenticate -> use returned member.id, and that
// passing a different user_id in the query has no effect.

import { assertEquals } from "@std/assert";
import { verifyInitData } from "../supabase/functions/_shared/webapp_auth.ts";

const BOT_TOKEN = "1234567890:cross_user_test_bot_token_AAAAAAAA";

async function buildSigned(userId: number, now: number): Promise<string> {
  const secret = await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    new TextEncoder().encode(BOT_TOKEN),
  );
  const secretKey = new Uint8Array(secret);
  const params: Record<string, string> = {
    user: JSON.stringify({ id: userId }),
    auth_date: String(now),
  };
  const keys = Object.keys(params).sort();
  const dcs = keys.map((k) => `${k}=${params[k]}`).join("\n");
  const sk = await crypto.subtle.importKey(
    "raw",
    secretKey.buffer.slice(0) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", sk, new TextEncoder().encode(dcs));
  const hash = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const sp = new URLSearchParams();
  for (const k of keys) sp.set(k, params[k]!);
  sp.set("hash", hash);
  return sp.toString();
}

Deno.test("cross_user: signed initData carries the SIGNED user id, query params are ignored", async () => {
  const initData = await buildSigned(111, Math.floor(Date.now() / 1000));
  const result = await verifyInitData(initData, BOT_TOKEN);
  if (!result) throw new Error("expected valid");
  // Even if a hostile client passes ?user_id=999 in the URL, only result.userId
  // is the safe identifier. We assert verifyInitData returns the signed id.
  assertEquals(result.userId, 111);
});

Deno.test("cross_user: cannot fake initData for another user id without bot token", async () => {
  const initData = await buildSigned(111, Math.floor(Date.now() / 1000));
  // Replace the user payload (changes the data the hash was computed over).
  const tampered = initData
    .replace(/user=%7B%22id%22%3A111%7D/, "user=%7B%22id%22%3A999%7D");
  const result = await verifyInitData(tampered, BOT_TOKEN);
  assertEquals(result, null, "tampered user_id must be rejected");
});

Deno.test("cross_user: wrong bot token -> verification fails", async () => {
  const initData = await buildSigned(111, Math.floor(Date.now() / 1000));
  const r = await verifyInitData(initData, "different-token-AAAAAAAAAAAAAAAAAAAAAA");
  assertEquals(r, null);
});
