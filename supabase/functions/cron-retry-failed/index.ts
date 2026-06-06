// cron-retry-failed: invoked by pg_cron every 5 minutes.
// Picks pending_retry rows ready to retry, re-attempts processing,
// bumps attempt_count + next_retry_at on failure or deletes on success.
//
// Auth: Authorization: Bearer ${CRON_SECRET}.

import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth, clearRetry, MAX_ATTEMPTS, nextRetryAt } from "../_shared/retry.ts";

interface PendingRow {
  id: number;
  tenant_id: string;
  telegram_message_id: number;
  family_member_id: string;
  payload: Record<string, unknown>;
  payload_type: "text" | "voice" | "photo";
  attempt_count: number;
}

const BATCH_LIMIT = 50;

function reprocess(_row: PendingRow): Promise<boolean> {
  // In M3 we do not yet have a full text/voice/photo pipeline; those land in
  // M7, M8, M9. For now this function exists, is callable, and exercises the
  // retry book-keeping. The reprocess hook returns false (still failing) so
  // the row keeps cycling - until the pipeline subroutines are wired in.
  //
  // Once M7 ships we will replace this body with a switch on payload_type
  // that calls the same handlers as tg-webhook. See SPEC §5 + §6.1.
  return Promise.resolve(false);
}

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) {
    log("warn", "cron_retry_unauthorized", {});
    return new Response("forbidden", { status: 401 });
  }

  const sb = adminClient();
  const nowIso = new Date().toISOString();

  const { data, error } = await sb
    .from("pending_retry")
    .select(
      "id, tenant_id, telegram_message_id, family_member_id, payload, payload_type, attempt_count",
    )
    .lt("attempt_count", MAX_ATTEMPTS)
    .lte("next_retry_at", nowIso)
    .order("next_retry_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    log("error", "cron_retry_select_failed", { error: error.message });
    return new Response("db error", { status: 500 });
  }

  const rows = (data ?? []) as PendingRow[];
  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    let ok = false;
    let errMsg: string | null = null;
    try {
      ok = await reprocess(row);
    } catch (err) {
      errMsg = (err as Error).message;
    }

    if (ok) {
      await clearRetry(sb, row.tenant_id, row.id);
      succeeded++;
    } else {
      const newAttempt = row.attempt_count + 1;
      if (newAttempt >= MAX_ATTEMPTS) {
        await sb
          .from("pending_retry")
          .update({
            attempt_count: newAttempt,
            last_error: errMsg ?? "reprocess returned false",
            next_retry_at: new Date(Date.UTC(9999, 0, 1)).toISOString(),
          })
          .eq("id", row.id);
        log("warn", "retry_giving_up", {
          row_id: row.id,
          telegram_message_id: row.telegram_message_id,
        });
      } else {
        const next = nextRetryAt(newAttempt).toISOString();
        await sb
          .from("pending_retry")
          .update({
            attempt_count: newAttempt,
            last_error: errMsg ?? "reprocess returned false",
            next_retry_at: next,
          })
          .eq("id", row.id);
      }
      failed++;
    }
  }

  log("info", "cron_retry_done", { picked: rows.length, succeeded, failed });
  return Response.json({ picked: rows.length, succeeded, failed });
});
