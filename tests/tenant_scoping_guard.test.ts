// Static guard against cross-tenant data leaks.
//
// Edge Functions use the service-role client (`sb`), which bypasses RLS, so a
// raw `sb.from("<per-tenant table>")` is only safe if it scopes by tenant_id
// itself. The safe path is the tenantDb() wrapper (db.from(...)), which scopes
// automatically. This test fails CI if a NEW raw `sb.from(<per-tenant>)`
// appears in a file that is not on the reviewed allowlist below.
//
// Ratchet: as each function is migrated to tenantDb in phase 2, remove it from
// ALLOWED_RAW. Once a file is off the list, any future raw per-tenant query in
// it fails the build. Entries still on the list are pre-existing, tracked debt.

import { assert } from "@std/assert";
import { PER_TENANT_TABLES } from "../supabase/functions/_shared/tenant_db.ts";

// Files allowed to use raw `sb.from(<per-tenant>)` for now (phase 1 baseline).
// SHRINK this set as functions are converted to tenantDb in phase 2.
const ALLOWED_RAW = new Set<string>([
  "supabase/functions/_shared/analyst_snapshot.ts",
  "supabase/functions/_shared/ask_agent.ts",
  "supabase/functions/_shared/auth.ts",
  "supabase/functions/_shared/budget.ts",
  "supabase/functions/_shared/categorizer.ts",
  "supabase/functions/_shared/idempotency.ts",
  "supabase/functions/_shared/reconcile.ts",
  "supabase/functions/_shared/retrain.ts",
  "supabase/functions/_shared/retry.ts",
  "supabase/functions/_shared/webapp_auth.ts",
  "supabase/functions/api-budgets/index.ts",
  "supabase/functions/api-categories/index.ts",
  "supabase/functions/api-category-mutate/index.ts",
  "supabase/functions/api-credits/index.ts",
  "supabase/functions/api-debts/index.ts",
  "supabase/functions/api-delete-item/index.ts",
  "supabase/functions/api-export/index.ts",
  "supabase/functions/api-family-mutate/index.ts",
  "supabase/functions/api-family/index.ts",
  "supabase/functions/api-health/index.ts",
  "supabase/functions/api-me-mutate/index.ts",
  "supabase/functions/api-me/index.ts",
  "supabase/functions/api-payment-calendar/index.ts",
  "supabase/functions/api-planned-payments/index.ts",
  "supabase/functions/api-recategorize/index.ts",
  "supabase/functions/api-receipt-items/index.ts",
  "supabase/functions/api-receipt-photo/index.ts",
  "supabase/functions/api-stats/index.ts",
  "supabase/functions/api-transactions/index.ts",
  "supabase/functions/api-web-exchange/index.ts",
  "supabase/functions/cron-anomaly/index.ts",
  "supabase/functions/cron-auto-confirm/index.ts",
  "supabase/functions/cron-daily-summary/index.ts",
  "supabase/functions/cron-media-group-sweep/index.ts",
  "supabase/functions/cron-month-summary/index.ts",
  "supabase/functions/cron-notifications/index.ts",
  "supabase/functions/cron-recurring/index.ts",
  "supabase/functions/cron-retention/index.ts",
  "supabase/functions/cron-retraining/index.ts",
  "supabase/functions/cron-retry-failed/index.ts",
  "supabase/functions/setup-once/index.ts",
  "supabase/functions/tg-webhook/bank_pipeline.ts",
  "supabase/functions/tg-webhook/callbacks.ts",
  "supabase/functions/tg-webhook/commands.ts",
  "supabase/functions/tg-webhook/debt_pipeline.ts",
  "supabase/functions/tg-webhook/photo_pipeline.ts",
  "supabase/functions/tg-webhook/router.ts",
  "supabase/functions/tg-webhook/text_pipeline.ts",
]);

const ROOT = "supabase/functions";
// Matches `sb.from("table")` / `sb .from('table')` across whitespace/newlines.
const RAW_FROM = /\bsb\s*\.\s*from\(\s*["']([a-z_]+)["']/gs;

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walk(path);
    else if (entry.isFile && path.endsWith(".ts")) yield path;
  }
}

Deno.test("tenant scoping guard: no raw per-tenant sb.from outside allowlist", async () => {
  const offenders: string[] = [];
  const seen = new Set<string>();

  for await (const path of walk(ROOT)) {
    const src = await Deno.readTextFile(path);
    let m: RegExpExecArray | null;
    RAW_FROM.lastIndex = 0;
    while ((m = RAW_FROM.exec(src)) !== null) {
      const table = m[1]!;
      if (!PER_TENANT_TABLES.has(table)) continue;
      seen.add(path);
      if (!ALLOWED_RAW.has(path)) {
        offenders.push(`${path} -> sb.from("${table}")`);
      }
    }
  }

  assert(
    offenders.length === 0,
    "Unscoped raw per-tenant query found outside allowlist. Use tenantDb(sb, tenantId).from(...) " +
      "instead of sb.from(...), or scope by tenant_id explicitly:\n" + offenders.join("\n"),
  );

  // Soft hygiene: warn about stale allowlist entries (file converted but not
  // removed from ALLOWED_RAW). Not fatal, to avoid friction mid-conversion.
  const stale = [...ALLOWED_RAW].filter((f) => !seen.has(f));
  if (stale.length > 0) {
    console.warn("[tenant-guard] stale allowlist entries (safe to remove):\n" + stale.join("\n"));
  }
});
