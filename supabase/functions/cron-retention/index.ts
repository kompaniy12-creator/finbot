// cron-retention: daily 02:30 UTC. Removes receipt photos older than
// PHOTO_RETENTION_DAYS (default 90) from Storage; marks photo_purged_at.
// Per SPEC §9.3.

import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";

interface ReceiptRow {
  id: string;
  photo_path: string | null;
}

const BUCKET = "receipts";

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) return new Response("forbidden", { status: 401 });
  const sb = adminClient();
  const days = Number(Deno.env.get("PHOTO_RETENTION_DAYS") ?? "90");
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const res = await sb
    .from("receipts")
    .select("id, photo_path")
    .lt("created_at", cutoff)
    .is("photo_purged_at", null)
    .not("photo_path", "is", null)
    .limit(500);
  if (res.error) {
    log("error", "retention_select_failed", { error: res.error.message });
    return new Response("db error", { status: 500 });
  }

  let purged = 0;
  for (const r of (res.data ?? []) as ReceiptRow[]) {
    if (!r.photo_path) continue;
    const del = await sb.storage.from(BUCKET).remove([r.photo_path]);
    if (del.error) {
      log("warn", "retention_remove_failed", { path: r.photo_path, error: del.error.message });
    }
    await sb.from("receipts").update({ photo_purged_at: new Date().toISOString() }).eq("id", r.id);
    purged++;
  }
  log("info", "retention_done", { purged });
  return Response.json({ purged });
});
