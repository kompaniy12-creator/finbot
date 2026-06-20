// Append-only security audit log (P1.2). Records security-sensitive events
// (key set/delete, crypto-shred, webhook auth failures, access changes, exports,
// rotations). Details are scrubbed of secrets/PII before insert; the table also
// forbids UPDATE/DELETE at the DB level (0044), so the log cannot be rewritten.

import type { SupabaseClient } from "@supabase/supabase-js";
import { log, scrub } from "./log.ts";

export type SecurityAction =
  | "key_set"
  | "key_deleted"
  | "crypto_shred"
  | "webhook_auth_fail"
  | "access_granted"
  | "access_revoked"
  | "export"
  | "key_rotated";

export interface SecurityEvent {
  actorTelegramId?: number | null;
  tenantId?: string | null;
  action: SecurityAction;
  result?: "ok" | "fail";
  correlationId?: string | null;
  details?: Record<string, unknown>;
}

// Never throws: an audit failure must not break the user-facing operation.
export async function recordSecurityEvent(
  sb: SupabaseClient,
  evt: SecurityEvent,
): Promise<void> {
  try {
    await sb.from("security_audit").insert({
      actor_telegram_id: evt.actorTelegramId ?? null,
      tenant_id: evt.tenantId ?? null,
      action: evt.action,
      result: evt.result ?? "ok",
      correlation_id: evt.correlationId ?? null,
      details: evt.details ? scrub(evt.details) : null,
    });
  } catch (err) {
    log("error", "security_audit_insert_failed", { error: (err as Error).message });
  }
}

// Count events of an action within the last `windowMs` - used for anomaly
// detection (e.g. a burst of webhook auth failures).
export async function recentEventCount(
  sb: SupabaseClient,
  action: SecurityAction,
  windowMs: number,
): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const r = await sb.from("security_audit")
    .select("id", { count: "exact", head: true })
    .eq("action", action)
    .gte("ts", since);
  return r.count ?? 0;
}
