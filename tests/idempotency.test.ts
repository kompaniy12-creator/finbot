// Unit tests for _shared/idempotency.ts: dedupe via message_log.
// Uses an inline minimal mock of Supabase client (no integration round-trip).

import { assertEquals } from "@std/assert";
import { dedupe, markDone, markError } from "../supabase/functions/_shared/idempotency.ts";

type Row = Record<string, unknown>;

function mockSupabaseFor(table: string) {
  const rows: Row[] = [];
  const builder = {
    insert(payload: Row) {
      const pk = `${payload.telegram_message_id}-${payload.family_member_id}`;
      const dup = rows.find(
        (r) => `${r.telegram_message_id}-${r.family_member_id}` === pk,
      );
      if (dup) {
        return {
          select: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: null,
                error: { code: "23505", message: "duplicate key" },
              }),
          }),
        };
      }
      const row = { ...payload, created_at: new Date().toISOString() };
      rows.push(row);
      return {
        select: () => ({
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
        }),
      };
    },
    update(patch: Row) {
      return {
        eq(_col: string, _val: unknown) {
          const eqs: Array<[string, unknown]> = [[_col, _val]];
          return {
            eq(col2: string, val2: unknown) {
              eqs.push([col2, val2]);
              for (const r of rows) {
                if (eqs.every(([c, v]) => r[c] === v)) {
                  Object.assign(r, patch);
                }
              }
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
  };
  // deno-lint-ignore no-explicit-any
  const sb: any = { from: (t: string) => (t === table ? builder : null) };
  return { sb, rows };
}

Deno.test("dedupe: first call inserts and returns true", async () => {
  const { sb, rows } = mockSupabaseFor("message_log");
  const fresh = await dedupe(100, "fm-1", sb);
  assertEquals(fresh, true);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.telegram_message_id, 100);
  assertEquals(rows[0]!.status, "processing");
});

Deno.test("dedupe: second call same (msg,family) returns false", async () => {
  const { sb } = mockSupabaseFor("message_log");
  assertEquals(await dedupe(200, "fm-1", sb), true);
  assertEquals(await dedupe(200, "fm-1", sb), false);
});

Deno.test("dedupe: same msg different family is independent", async () => {
  const { sb, rows } = mockSupabaseFor("message_log");
  assertEquals(await dedupe(300, "fm-1", sb), true);
  assertEquals(await dedupe(300, "fm-2", sb), true);
  assertEquals(rows.length, 2);
});

Deno.test("markDone: updates status to done for matching row", async () => {
  const { sb, rows } = mockSupabaseFor("message_log");
  await dedupe(400, "fm-1", sb);
  await markDone(400, "fm-1", sb);
  assertEquals(rows[0]!.status, "done");
});

Deno.test("markError: writes error and status=error", async () => {
  const { sb, rows } = mockSupabaseFor("message_log");
  await dedupe(500, "fm-1", sb);
  await markError(500, "fm-1", sb, "boom");
  assertEquals(rows[0]!.status, "error");
  assertEquals(rows[0]!.error, "boom");
});
