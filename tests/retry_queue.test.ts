// Unit tests for _shared/retry.ts:
//   - nextRetryAt: maps attempt_count to correct backoff bucket
//   - enqueueRetry: insert on fresh, bump on existing, gives up at MAX_ATTEMPTS
//   - checkCronAuth: rejects wrong / missing Bearer

import { assertEquals } from "@std/assert";
import {
  BACKOFF_MIN,
  checkCronAuth,
  enqueueRetry,
  MAX_ATTEMPTS,
  nextRetryAt,
} from "../supabase/functions/_shared/retry.ts";

type Row = Record<string, unknown>;

function mockSupabaseForPendingRetry() {
  const rows: Row[] = [];
  let nextId = 1;

  function builder() {
    let table: string = "";
    let where: Array<[string, unknown]> = [];
    let order: { col: string; asc: boolean } | undefined;
    let limit: number | undefined;

    const obj = {
      from(t: string) {
        table = t;
        where = [];
        order = undefined;
        limit = undefined;
        return obj;
      },
      select(_cols: string) {
        return obj;
      },
      eq(col: string, val: unknown) {
        where.push([col, val]);
        return obj;
      },
      lt(col: string, val: unknown) {
        where.push([`__lt_${col}`, val]);
        return obj;
      },
      lte(col: string, val: unknown) {
        where.push([`__lte_${col}`, val]);
        return obj;
      },
      order(col: string, opts: { ascending: boolean }) {
        order = { col, asc: opts.ascending };
        return obj;
      },
      limit(n: number) {
        limit = n;
        return obj;
      },
      _apply() {
        if (table !== "pending_retry") return [];
        let r = rows.filter((row) =>
          where.every(([c, v]) => {
            if (c.startsWith("__lt_")) {
              return (row[c.slice(5)] as number) < (v as number);
            }
            if (c.startsWith("__lte_")) {
              return (row[c.slice(6)] as string) <= (v as string);
            }
            return row[c] === v;
          })
        );
        if (order) {
          const o = order;
          r = [...r].sort((a, b) =>
            o.asc
              ? String(a[o.col]).localeCompare(String(b[o.col]))
              : String(b[o.col]).localeCompare(String(a[o.col]))
          );
        }
        if (limit) r = r.slice(0, limit);
        return r;
      },
      maybeSingle() {
        return Promise.resolve({ data: obj._apply()[0] ?? null, error: null });
      },
      insert(payload: Row) {
        const row = { id: nextId++, ...payload };
        rows.push(row);
        return Promise.resolve({ data: row, error: null });
      },
      update(patch: Row) {
        const conds: Array<[string, unknown]> = [];
        const u = {
          eq(col: string, val: unknown) {
            conds.push([col, val]);
            return u;
          },
          then(onF: (v: unknown) => unknown) {
            for (const r of rows) {
              if (conds.every(([c, v]) => r[c] === v)) Object.assign(r, patch);
            }
            return Promise.resolve({ data: rows, error: null }).then(onF);
          },
        };
        return u;
      },
      delete() {
        const conds: Array<[string, unknown]> = [];
        const d = {
          eq(col: string, val: unknown) {
            conds.push([col, val]);
            return d;
          },
          then(onF: (v: unknown) => unknown) {
            for (let i = rows.length - 1; i >= 0; i--) {
              if (conds.every(([c, v]) => rows[i]![c] === v)) rows.splice(i, 1);
            }
            return Promise.resolve({ data: null, error: null }).then(onF);
          },
        };
        return d;
      },
    };
    return obj;
  }

  // deno-lint-ignore no-explicit-any
  const sb: any = builder();
  return { sb, rows };
}

Deno.test("nextRetryAt: returns correct bucket for each attempt", () => {
  const now = new Date("2026-05-18T00:00:00Z");
  for (let i = 0; i < BACKOFF_MIN.length; i++) {
    const got = nextRetryAt(i, now);
    const want = new Date(now.getTime() + BACKOFF_MIN[i]! * 60_000);
    assertEquals(got.getTime(), want.getTime(), `bucket ${i}`);
  }
});

Deno.test("nextRetryAt: caps at last bucket if attempt exceeds array", () => {
  const now = new Date("2026-05-18T00:00:00Z");
  const lastBucket = BACKOFF_MIN[BACKOFF_MIN.length - 1]!;
  const got = nextRetryAt(99, now);
  assertEquals(got.getTime(), now.getTime() + lastBucket * 60_000);
});

Deno.test("enqueueRetry: inserts with attempt_count=0 on first call", async () => {
  const { sb, rows } = mockSupabaseForPendingRetry();
  const result = await enqueueRetry(sb, {
    telegramMessageId: 1001,
    familyMemberId: "fm-1",
    tenantId: "t-1",
    payload: { text: "test" },
    payloadType: "text",
    error: "first failure",
  });
  assertEquals(result.ok, true);
  assertEquals(result.attempt, 0);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.attempt_count, 0);
  assertEquals(rows[0]!.last_error, "first failure");
});

Deno.test("enqueueRetry: bumps attempt_count on repeat", async () => {
  const { sb, rows } = mockSupabaseForPendingRetry();
  await enqueueRetry(sb, {
    telegramMessageId: 1002,
    familyMemberId: "fm-1",
    tenantId: "t-1",
    payload: {},
    payloadType: "text",
    error: "first",
  });
  await enqueueRetry(sb, {
    telegramMessageId: 1002,
    familyMemberId: "fm-1",
    tenantId: "t-1",
    payload: {},
    payloadType: "text",
    error: "second",
  });
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.attempt_count, 1);
  assertEquals(rows[0]!.last_error, "second");
});

Deno.test("enqueueRetry: gives up at MAX_ATTEMPTS", async () => {
  const { sb, rows } = mockSupabaseForPendingRetry();
  // First call inserts attempt_count=0. Then MAX_ATTEMPTS more calls bump
  // through 1..MAX_ATTEMPTS. Final call triggers the giveup branch
  // (attempt_count = MAX_ATTEMPTS, next_retry_at pushed to year 9999).
  for (let i = 0; i <= MAX_ATTEMPTS; i++) {
    await enqueueRetry(sb, {
      telegramMessageId: 1003,
      familyMemberId: "fm-1",
      tenantId: "t-1",
      payload: {},
      payloadType: "text",
      error: `failure ${i + 1}`,
    });
  }
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.attempt_count, MAX_ATTEMPTS);
  const nextAt = String(rows[0]!.next_retry_at);
  assertEquals(nextAt.startsWith("9999-"), true, "giveup pushes far future");
});

Deno.test("checkCronAuth: accepts correct Bearer", () => {
  Deno.env.set("CRON_SECRET", "test-secret-12345");
  const req = new Request("https://x/", {
    headers: { Authorization: "Bearer test-secret-12345" },
  });
  assertEquals(checkCronAuth(req), true);
  Deno.env.delete("CRON_SECRET");
});

Deno.test("checkCronAuth: rejects wrong Bearer", () => {
  Deno.env.set("CRON_SECRET", "test-secret-12345");
  const req = new Request("https://x/", {
    headers: { Authorization: "Bearer wrong-token" },
  });
  assertEquals(checkCronAuth(req), false);
  Deno.env.delete("CRON_SECRET");
});

Deno.test("checkCronAuth: rejects when CRON_SECRET unset", () => {
  Deno.env.delete("CRON_SECRET");
  const req = new Request("https://x/", {
    headers: { Authorization: "Bearer anything" },
  });
  assertEquals(checkCronAuth(req), false);
});

Deno.test("checkCronAuth: rejects when header missing", () => {
  Deno.env.set("CRON_SECRET", "test-secret-12345");
  const req = new Request("https://x/");
  assertEquals(checkCronAuth(req), false);
  Deno.env.delete("CRON_SECRET");
});
