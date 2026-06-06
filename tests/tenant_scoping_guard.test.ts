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

// Files allowed to use raw `sb.from(<per-tenant>)`. SHRINK this set as
// functions are converted to tenantDb in phase 2.
//
// PERMANENT entries (identity resolution: they query family_members /
// web_sessions to FIND the tenant, so they cannot be tenant-scoped):
// _shared/auth.ts, _shared/webapp_auth.ts, api-web-exchange/index.ts.
const ALLOWED_RAW = new Set<string>([
  "supabase/functions/_shared/auth.ts",
  "supabase/functions/_shared/webapp_auth.ts",
  "supabase/functions/api-web-exchange/index.ts",
  "supabase/functions/_shared/budget.ts",
  "supabase/functions/_shared/reconcile.ts",
  "supabase/functions/_shared/retrain.ts",
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
]);

const ROOT = "supabase/functions";
// Matches raw per-tenant access through either the bare service client
// (`sb.from(...)`) or the tenantDb escape hatch (`db.raw.from(...)`), across
// whitespace/newlines. The escape hatch must only touch global tables/RPC, so
// using it on a per-tenant table is just as much a leak as a raw sb.from.
const RAW_FROM = /(?:\bsb|\braw)\s*\.\s*from\(\s*["']([a-z_]+)["']/gs;

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
