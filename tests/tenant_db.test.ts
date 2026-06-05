// Unit tests for the tenantDb scoping wrapper.
import { assertEquals, assertThrows } from "@std/assert";
import { PER_TENANT_TABLES, tenantDb } from "../supabase/functions/_shared/tenant_db.ts";

const TID = "00000000-0000-0000-0000-000000000001";

// Minimal fake that records what the wrapper did. Each builder method returns
// `this` so chains like .select().eq() work, and we inspect the recorded calls.
function fakeSb() {
  // deno-lint-ignore no-explicit-any
  const calls: any[] = [];
  // deno-lint-ignore no-explicit-any
  const builder: any = {
    _eq: [] as Array<[string, unknown]>,
    select(cols?: string) {
      calls.push({ op: "select", cols });
      return builder;
    },
    insert(values: unknown) {
      calls.push({ op: "insert", values });
      return builder;
    },
    upsert(values: unknown) {
      calls.push({ op: "upsert", values });
      return builder;
    },
    update(values: unknown) {
      calls.push({ op: "update", values });
      return builder;
    },
    delete() {
      calls.push({ op: "delete" });
      return builder;
    },
    eq(col: string, val: unknown) {
      builder._eq.push([col, val]);
      calls.push({ op: "eq", col, val });
      return builder;
    },
  };
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      calls.push({ op: "from", table });
      return builder;
    },
  };
  return { sb, builder, calls };
}

Deno.test("tenantDb requires a tenantId", () => {
  const { sb } = fakeSb();
  assertThrows(() => tenantDb(sb, ""));
});

Deno.test("per-tenant select is scoped by tenant_id", () => {
  const { sb, builder } = fakeSb();
  tenantDb(sb, TID).from("expenses").select("*");
  assertEquals(builder._eq, [["tenant_id", TID]]);
});

Deno.test("per-tenant update and delete are scoped", () => {
  const u = fakeSb();
  tenantDb(u.sb, TID).from("expenses").update({ archived: true });
  assertEquals(u.builder._eq, [["tenant_id", TID]]);

  const d = fakeSb();
  tenantDb(d.sb, TID).from("receipts").delete();
  assertEquals(d.builder._eq, [["tenant_id", TID]]);
});

Deno.test("insert stamps tenant_id (single and array)", () => {
  const one = fakeSb();
  tenantDb(one.sb, TID).from("expenses").insert({ name: "x" });
  const insOne = one.calls.find((c) => c.op === "insert");
  assertEquals(insOne.values, { tenant_id: TID, name: "x" });

  const many = fakeSb();
  tenantDb(many.sb, TID).from("expenses").insert([{ name: "a" }, { name: "b" }]);
  const insMany = many.calls.find((c) => c.op === "insert");
  assertEquals(insMany.values, [
    { tenant_id: TID, name: "a" },
    { tenant_id: TID, name: "b" },
  ]);
});

Deno.test("upsert stamps tenant_id", () => {
  const { sb, calls } = fakeSb();
  tenantDb(sb, TID).from("expenses").upsert({ id: "1", name: "x" });
  const up = calls.find((c) => c.op === "upsert");
  assertEquals(up.values, { tenant_id: TID, id: "1", name: "x" });
});

Deno.test("global tables pass through unscoped", () => {
  const { sb, builder } = fakeSb();
  // exchange_rates is not a per-tenant table.
  tenantDb(sb, TID).from("exchange_rates").select("*");
  assertEquals(builder._eq, []);

  const ins = fakeSb();
  tenantDb(ins.sb, TID).from("settings").insert({ key: "k", value: "v" });
  const i = ins.calls.find((c) => c.op === "insert");
  assertEquals(i.values, { key: "k", value: "v" }); // no tenant_id stamped
});

Deno.test("PER_TENANT_TABLES does not contain known global tables", () => {
  for (const g of ["exchange_rates", "settings", "system_health", "rate_limit", "pending_access"]) {
    assertEquals(PER_TENANT_TABLES.has(g), false);
  }
});
