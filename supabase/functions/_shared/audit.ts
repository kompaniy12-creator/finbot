// Append a row to system_audit. Used for admin/privileged actions outside
// the expenses table (categories CRUD, member grant/revoke/promote/demote).
// expense_audit covers expense mutations via the SQL trigger.
//
// Failure is logged but never thrown - audit must not block the action.

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./log.ts";

export interface AuditEntry {
  actorTelegramId: number;
  actorFamilyMemberId?: string | null;
  action: string;
  targetId?: string | null;
  targetName?: string | null;
  details?: Record<string, unknown>;
}

export async function recordAudit(
  sb: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  const { error } = await sb.from("system_audit").insert({
    actor_telegram_id: entry.actorTelegramId,
    actor_family_member_id: entry.actorFamilyMemberId ?? null,
    action: entry.action,
    target_id: entry.targetId ?? null,
    target_name: entry.targetName ?? null,
    details: entry.details ?? null,
  });
  if (error) {
    log("warn", "audit_insert_failed", { action: entry.action, error: error.message });
  }
}
