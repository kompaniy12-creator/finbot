// cron-auto-confirm: runs every minute. Clears needs_confirmation flag for
// expenses older than CONFIRMATION_TIMEOUT_SEC (default 60). After this
// window, high-amount expenses are auto-confirmed (per SPEC §6.6).

import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) return new Response("forbidden", { status: 401 });
  const sb = adminClient();
  const timeoutSec = Number(Deno.env.get("CONFIRMATION_TIMEOUT_SEC") ?? "60");
  const cutoff = new Date(Date.now() - timeoutSec * 1000).toISOString();
  const { error, count } = await sb
    .from("expenses")
    .update({ needs_confirmation: false }, { count: "exact" })
    .eq("needs_confirmation", true)
    .lt("created_at", cutoff);
  if (error) {
    log("error", "auto_confirm_failed", { error: error.message });
    return new Response("db error", { status: 500 });
  }
  log("info", "auto_confirm_done", { affected: count ?? 0 });
  return Response.json({ affected: count ?? 0 });
});
