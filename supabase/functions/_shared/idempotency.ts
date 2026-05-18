import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./log.ts";

/**
 * Returns true if message is fresh (first time we see it),
 * false if already in message_log (idempotent skip).
 */
export async function dedupe(
  telegramMessageId: number,
  familyMemberId: string,
  sb: SupabaseClient,
): Promise<boolean> {
  const { data, error } = await sb
    .from("message_log")
    .insert({
      telegram_message_id: telegramMessageId,
      family_member_id: familyMemberId,
      status: "processing",
    })
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      log("info", "dedupe_hit", {
        telegram_message_id: telegramMessageId,
        family_member_id: familyMemberId,
      });
      return false;
    }
    log("error", "dedupe_error", { error: error.message });
    return false;
  }
  return data !== null;
}

export async function markDone(
  telegramMessageId: number,
  familyMemberId: string,
  sb: SupabaseClient,
): Promise<void> {
  const { error } = await sb
    .from("message_log")
    .update({ status: "done", updated_at: new Date().toISOString() })
    .eq("telegram_message_id", telegramMessageId)
    .eq("family_member_id", familyMemberId);
  if (error) {
    log("warn", "mark_done_failed", { error: error.message });
  }
}

export async function markError(
  telegramMessageId: number,
  familyMemberId: string,
  sb: SupabaseClient,
  errorMessage: string,
): Promise<void> {
  const { error } = await sb
    .from("message_log")
    .update({
      status: "error",
      error: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq("telegram_message_id", telegramMessageId)
    .eq("family_member_id", familyMemberId);
  if (error) {
    log("warn", "mark_error_failed", { error: error.message });
  }
}
