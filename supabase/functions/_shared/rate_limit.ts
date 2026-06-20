// Per-(telegram_id, kind, day) rate limiter. Backed by `rate_limit` table
// and the `rate_limit_bump` SQL function (atomic increment, race-safe).
//
// Defaults chosen so legitimate use never hits the cap but a runaway script
// or compromised member account can't burn through the Claude budget:
//   photo:  50/day   (~$2.50 of Vision at $0.05/call)
//   text:   200/day  (Haiku ~$0.001/call -> $0.20/day)
//   voice:  100/day  (Whisper free + Haiku)
//   webhook: 1000/day  catch-all for any other update kind

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./log.ts";
import { todayWarsawIso } from "./dates.ts";

export type RateLimitKind =
  | "photo"
  | "text"
  | "voice"
  | "callback"
  | "webhook"
  | "export"
  | "key_op";

export const RATE_LIMITS: Record<RateLimitKind, number> = {
  photo: 50,
  text: 200,
  voice: 100,
  callback: 500,
  webhook: 1000,
  // Stricter caps on data-exposing / sensitive operations (P1.3).
  export: 20, // CSV exports per day
  key_op: 15, // API-key set/delete per day
};

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  kind: RateLimitKind;
}

/**
 * Atomically bump the counter and decide. On DB failure we ALLOW (fail-open):
 * it's better to risk a few extra requests than to lock out the user when our
 * rate-limit table is unavailable.
 */
export async function checkAndBump(
  sb: SupabaseClient,
  telegramId: number,
  kind: RateLimitKind,
): Promise<RateLimitResult> {
  const limit = RATE_LIMITS[kind];
  const day = todayWarsawIso();
  const { data, error } = await sb.rpc("rate_limit_bump", {
    p_telegram_id: telegramId,
    p_kind: kind,
    p_day: day,
  });
  if (error) {
    log("warn", "rate_limit_bump_failed", { error: error.message, kind, telegramId });
    return { allowed: true, count: 0, limit, kind };
  }
  const count = Number(data ?? 0);
  return { allowed: count <= limit, count, limit, kind };
}
