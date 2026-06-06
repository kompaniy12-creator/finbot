import type { SupabaseClient } from "@supabase/supabase-js";
import { tenantDb } from "./tenant_db.ts";
import { log } from "./log.ts";

// Backoff buckets (minutes) per SPEC §5: 1, 5, 15, 60, 300.
// attempt_count is 0 on first enqueue; next backoff comes from BACKOFF_MIN[attempt_count].
export const BACKOFF_MIN = [1, 5, 15, 60, 300] as const;
export const MAX_ATTEMPTS = BACKOFF_MIN.length;

export type PayloadType = "text" | "voice" | "photo";

export interface EnqueueRetryInput {
  telegramMessageId: number;
  familyMemberId: string;
  tenantId: string;
  payload: Record<string, unknown>;
  payloadType: PayloadType;
  error: string;
}

export function nextRetryAt(attemptCount: number, now: Date = new Date()): Date {
  const minutes = BACKOFF_MIN[Math.min(attemptCount, BACKOFF_MIN.length - 1)] ?? 1;
  return new Date(now.getTime() + minutes * 60 * 1000);
}

/**
 * Insert (or update) a pending_retry row. If a row already exists for this
 * (telegram_message_id, family_member_id) pair (i.e. it was retried before),
 * we bump attempt_count and recompute next_retry_at. Otherwise we insert
 * attempt_count=0 with the first backoff bucket.
 */
export async function enqueueRetry(
  sb: SupabaseClient,
  input: EnqueueRetryInput,
): Promise<{ ok: boolean; attempt: number; nextAt: string | null }> {
  const { telegramMessageId, familyMemberId, tenantId, payload, payloadType, error } = input;
  const db = tenantDb(sb, tenantId);

  // Look up existing
  const { data: existing, error: selErr } = await db
    .from("pending_retry")
    .select("id, attempt_count")
    .eq("telegram_message_id", telegramMessageId)
    .eq("family_member_id", familyMemberId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selErr) {
    log("error", "enqueue_retry_select_failed", { error: selErr.message });
    return { ok: false, attempt: 0, nextAt: null };
  }

  if (existing) {
    const newAttempt = (existing.attempt_count as number) + 1;
    if (newAttempt >= MAX_ATTEMPTS) {
      log("warn", "retry_giving_up", {
        telegram_message_id: telegramMessageId,
        attempts: newAttempt,
      });
      // Keep the row so it can be inspected; mark via last_error.
      await db
        .from("pending_retry")
        .update({
          attempt_count: newAttempt,
          last_error: error,
          next_retry_at: new Date(Date.UTC(9999, 0, 1)).toISOString(),
        })
        .eq("id", existing.id);
      return { ok: false, attempt: newAttempt, nextAt: null };
    }
    const next = nextRetryAt(newAttempt).toISOString();
    const { error: upErr } = await db
      .from("pending_retry")
      .update({
        attempt_count: newAttempt,
        last_error: error,
        next_retry_at: next,
      })
      .eq("id", existing.id);
    if (upErr) {
      log("error", "enqueue_retry_update_failed", { error: upErr.message });
      return { ok: false, attempt: newAttempt, nextAt: null };
    }
    return { ok: true, attempt: newAttempt, nextAt: next };
  }

  const next = nextRetryAt(0).toISOString();
  const { error: insErr } = await db.from("pending_retry").insert({
    telegram_message_id: telegramMessageId,
    family_member_id: familyMemberId,
    payload,
    payload_type: payloadType,
    attempt_count: 0,
    last_error: error,
    next_retry_at: next,
  });
  if (insErr) {
    log("error", "enqueue_retry_insert_failed", { error: insErr.message });
    return { ok: false, attempt: 0, nextAt: null };
  }
  return { ok: true, attempt: 0, nextAt: next };
}

/**
 * Remove a pending_retry entry after successful re-processing.
 */
export async function clearRetry(
  sb: SupabaseClient,
  tenantId: string,
  id: number,
): Promise<void> {
  const { error } = await tenantDb(sb, tenantId).from("pending_retry").delete().eq("id", id);
  if (error) {
    log("warn", "clear_retry_failed", { id, error: error.message });
  }
}

/**
 * Auth check for cron Edge Functions: require Bearer CRON_SECRET in header.
 */
export function checkCronAuth(req: Request): boolean {
  const expected = Deno.env.get("CRON_SECRET");
  if (!expected) return false;
  const auth = req.headers.get("Authorization") || "";
  return auth === `Bearer ${expected}`;
}
