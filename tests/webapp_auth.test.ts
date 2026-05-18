// Unit tests for _shared/webapp_auth.ts: verifyInitData HMAC math.
import { assertEquals } from "@std/assert";
import { extractInitData, verifyInitData } from "../supabase/functions/_shared/webapp_auth.ts";

const BOT_TOKEN = "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";

async function hmac(key: Uint8Array, data: string): Promise<string> {
  const keyBuf = key.buffer.slice(
    key.byteOffset,
    key.byteOffset + key.byteLength,
  ) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildInitData(params: Record<string, string>): Promise<string> {
  const secretKey = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("WebAppData"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      new TextEncoder().encode(BOT_TOKEN),
    ),
  );
  const keys = Object.keys(params).sort();
  const dcs = keys.map((k) => `${k}=${params[k]}`).join("\n");
  const hash = await hmac(secretKey, dcs);
  const sp = new URLSearchParams();
  for (const k of keys) sp.set(k, params[k]!);
  sp.set("hash", hash);
  return sp.toString();
}

Deno.test("verifyInitData: valid signature -> returns user id", async () => {
  const now = Math.floor(Date.now() / 1000);
  const initData = await buildInitData({
    user: JSON.stringify({ id: 1436806270, first_name: "Серхий" }),
    auth_date: String(now),
    query_id: "abc",
  });
  const r = await verifyInitData(initData, BOT_TOKEN);
  if (!r) throw new Error("expected valid");
  assertEquals(r.userId, 1436806270);
});

Deno.test("verifyInitData: tampered hash -> null", async () => {
  const initData = await buildInitData({
    user: JSON.stringify({ id: 1 }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  });
  const tampered = initData.replace(/hash=[0-9a-f]+/, "hash=" + "0".repeat(64));
  assertEquals(await verifyInitData(tampered, BOT_TOKEN), null);
});

Deno.test("verifyInitData: missing hash -> null", async () => {
  const sp = new URLSearchParams();
  sp.set("user", JSON.stringify({ id: 1 }));
  sp.set("auth_date", String(Math.floor(Date.now() / 1000)));
  assertEquals(await verifyInitData(sp.toString(), BOT_TOKEN), null);
});

Deno.test("verifyInitData: expired auth_date -> null", async () => {
  const yesterday = Math.floor(Date.now() / 1000) - 25 * 3600;
  const initData = await buildInitData({
    user: JSON.stringify({ id: 1 }),
    auth_date: String(yesterday),
  });
  assertEquals(await verifyInitData(initData, BOT_TOKEN), null);
});

Deno.test("verifyInitData: tampered user field -> null (hash mismatch)", async () => {
  const initData = await buildInitData({
    user: JSON.stringify({ id: 1 }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  });
  const tampered = initData.replace(/%22id%22%3A1/, "%22id%22%3A2");
  assertEquals(await verifyInitData(tampered, BOT_TOKEN), null);
});

Deno.test("extractInitData: X-Telegram-Init-Data header", () => {
  const req = new Request("https://x/", {
    headers: { "x-telegram-init-data": "user=abc&hash=xy" },
  });
  assertEquals(extractInitData(req), "user=abc&hash=xy");
});

Deno.test("extractInitData: Authorization tma fallback", () => {
  const req = new Request("https://x/", { headers: { authorization: "tma user=abc&hash=xy" } });
  assertEquals(extractInitData(req), "user=abc&hash=xy");
});

Deno.test("extractInitData: neither header -> null", () => {
  const req = new Request("https://x/");
  assertEquals(extractInitData(req), null);
});
