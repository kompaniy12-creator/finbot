// Telegram WebApp initData HMAC-SHA256 validator.
//
// Per https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app:
//   secret_key = HMAC_SHA256(bot_token, "WebAppData")
//   data_check_string = "auth_date=...\n<key>=<value>\n..."  (sorted, hash excluded)
//   expected = HMAC_SHA256(data_check_string, secret_key) hex
//   if hex(expected) == hash -> ok
//
// auth_date TTL: 24 hours (configurable).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "./types.ts";
import { log } from "./log.ts";

// 1-hour TTL on initData. Telegram's auth_date is unix-seconds; we refuse
// anything older. Was 24h; tightened so a stolen/leaked initData URL is
// only useful for at most an hour before the user must reopen the Mini App.
const TTL_SECONDS = 60 * 60;

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  // Copy to a fresh ArrayBuffer so the type narrows to ArrayBuffer (not SharedArrayBuffer).
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
  const enc = new TextEncoder().encode(data);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc);
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface InitDataValid {
  authDate: number;
  userId: number;
  rawUser: Record<string, unknown>;
}

/**
 * Verify initData signature. Returns the parsed claims on success, null on failure.
 */
export async function verifyInitData(
  initData: string,
  botToken: string,
  now: Date = new Date(),
): Promise<InitDataValid | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const pairs: string[] = [];
  const keys = [...params.keys()].sort();
  for (const k of keys) pairs.push(`${k}=${params.get(k)}`);
  const dataCheckString = pairs.join("\n");

  const secretKey = await hmacSha256(
    new TextEncoder().encode("WebAppData"),
    botToken,
  );
  const expected = await hmacSha256(secretKey, dataCheckString);
  if (toHex(expected) !== hash) return null;

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > TTL_SECONDS) return null;
  void now;

  const userRaw = params.get("user");
  if (!userRaw) return null;
  let user: { id?: number };
  try {
    user = JSON.parse(userRaw);
  } catch {
    return null;
  }
  if (!user.id) return null;

  return {
    authDate,
    userId: user.id,
    rawUser: user as Record<string, unknown>,
  };
}

/**
 * Verify initData and resolve to a FamilyMember. Returns null if either step fails.
 */
export async function authenticateInitData(
  initData: string,
  sb: SupabaseClient,
): Promise<FamilyMember | null> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return null;
  const valid = await verifyInitData(initData, token);
  if (!valid) return null;
  const { data, error } = await sb
    .from("family_members")
    .select("id, telegram_id, name, role, active")
    .eq("telegram_id", valid.userId)
    .eq("active", true)
    .maybeSingle();
  if (error) {
    log("error", "webapp_auth_db_error", { error: error.message });
    return null;
  }
  return (data as FamilyMember | null) ?? null;
}

/**
 * Extract initData from request: prefer X-Telegram-Init-Data header,
 * fall back to Authorization: "tma <initData>".
 */
export function extractInitData(req: Request): string | null {
  const header = req.headers.get("x-telegram-init-data");
  if (header) return header;
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("tma ")) return auth.slice(4);
  return null;
}
