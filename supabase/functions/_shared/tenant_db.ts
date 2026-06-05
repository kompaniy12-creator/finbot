// tenant_db.ts - tenant-scoped wrapper around the service-role Supabase client.
//
// Every Edge Function talks to Postgres with the SERVICE_ROLE key, which
// BYPASSES RLS. Isolation between tenants is therefore enforced here, in
// application code: a forgotten `.eq("tenant_id", ...)` would leak data across
// tenants. This wrapper makes the safe path the default.
//
// Usage:
//   const db = tenantDb(sb, member.tenant_id);
//   db.from("expenses").select("*").eq("archived", false)  // auto-scoped
//   db.from("expenses").insert({ ... })                     // tenant_id stamped
//   db.raw.rpc("match_expenses", { tenant: db.tenantId, ... })  // escape hatch
//
// Reads/updates/deletes on per-tenant tables get `.eq("tenant_id", tenantId)`
// prepended; inserts/upserts get `tenant_id` merged into each row. Global
// tables (exchange_rates, settings, etc.) pass straight through. For RPCs and
// anything that needs the bare client, use `db.raw`.
//
// The companion test tests/tenant_scoping_guard.test.ts fails CI if a per-tenant
// table is queried through the raw `sb` client outside a reviewed allowlist.

import type { SupabaseClient } from "@supabase/supabase-js";

// Tables carrying a tenant_id column. Keep in sync with migrations 0029/0031.
// Anything not listed is global and is not scoped.
export const PER_TENANT_TABLES: ReadonlySet<string> = new Set([
  "family_members",
  "categories",
  "expenses",
  "receipts",
  "recurring_expenses",
  "message_log",
  "media_group_buffer",
  "pending_retry",
  "ask_proposals",
  "ask_threads",
  "web_sessions",
  "bank_statements",
  "bank_statement_lines",
  "planned_payments",
  "budgets",
  "credits",
  "debts",
  "notifications_log",
  "anthropic_usage",
  "expense_audit",
  "budget_categories",
  "credit_payments",
  "debt_payments",
]);

// deno-lint-ignore no-explicit-any
type AnyRow = Record<string, any>;

class ScopedFrom {
  // deno-lint-ignore no-explicit-any
  constructor(private qb: any, private tenantId: string, private scoped: boolean) {}

  // deno-lint-ignore no-explicit-any
  select(columns?: string, opts?: any) {
    const b = this.qb.select(columns, opts);
    return this.scoped ? b.eq("tenant_id", this.tenantId) : b;
  }

  // deno-lint-ignore no-explicit-any
  insert(values: AnyRow | AnyRow[], opts?: any) {
    return this.qb.insert(this.scoped ? this.stamp(values) : values, opts);
  }

  // deno-lint-ignore no-explicit-any
  upsert(values: AnyRow | AnyRow[], opts?: any) {
    return this.qb.upsert(this.scoped ? this.stamp(values) : values, opts);
  }

  // deno-lint-ignore no-explicit-any
  update(values: AnyRow, opts?: any) {
    const b = this.qb.update(values, opts);
    return this.scoped ? b.eq("tenant_id", this.tenantId) : b;
  }

  // deno-lint-ignore no-explicit-any
  delete(opts?: any) {
    const b = this.qb.delete(opts);
    return this.scoped ? b.eq("tenant_id", this.tenantId) : b;
  }

  private stamp(values: AnyRow | AnyRow[]): AnyRow | AnyRow[] {
    return Array.isArray(values)
      ? values.map((v) => ({ tenant_id: this.tenantId, ...v }))
      : { tenant_id: this.tenantId, ...values };
  }
}

export interface TenantDb {
  readonly tenantId: string;
  /** Bare service-role client. Use for RPCs and global tables only. */
  readonly raw: SupabaseClient;
  from(table: string): ScopedFrom;
}

export function tenantDb(sb: SupabaseClient, tenantId: string): TenantDb {
  if (!tenantId) throw new Error("tenantDb: tenantId is required");
  return {
    tenantId,
    raw: sb,
    from(table: string): ScopedFrom {
      return new ScopedFrom(sb.from(table), tenantId, PER_TENANT_TABLES.has(table));
    },
  };
}
