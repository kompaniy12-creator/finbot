// Tests for _shared/budget.ts two-tier daily cap behavior (SPEC §7.5).
//
// Per-user cap is a SOFT warn (returns warning string, allowed=true).
// Global cap is a HARD stop (throws BudgetExceededError).

import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  BudgetExceededError,
  enforceBudget,
  getCosts,
  readCapsFromEnv,
  recordUsage,
} from "../supabase/functions/_shared/budget.ts";

interface AnthropicUsageRow {
  date: string;
  family_member_id: string | null;
  cost_usd: number;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

function mockSb(seed: AnthropicUsageRow[] = []) {
  const rows: AnthropicUsageRow[] = [...seed];
  function tableBuilder() {
    const filters: Array<[string, unknown]> = [];
    const obj = {
      select(_cols: string) {
        return obj;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return obj;
      },
      then(onFulfilled: (v: unknown) => unknown) {
        const filtered = rows.filter((r) =>
          filters.every(([c, v]) => {
            const key = c as keyof AnthropicUsageRow;
            return r[key] === v;
          })
        );
        return Promise.resolve({ data: filtered, error: null }).then(onFulfilled);
      },
      insert(payload: AnthropicUsageRow) {
        rows.push(payload);
        return Promise.resolve({ data: payload, error: null });
      },
    };
    return obj;
  }
  // deno-lint-ignore no-explicit-any
  return { sb: { from: (_t: string) => tableBuilder() } as any, rows };
}

const TODAY = new Date().toISOString().slice(0, 10);

Deno.test("getCosts: sums by user and globally for today only", async () => {
  const { sb } = mockSb([
    { date: TODAY, family_member_id: "fm-1", cost_usd: 0.10 },
    { date: TODAY, family_member_id: "fm-1", cost_usd: 0.05 },
    { date: TODAY, family_member_id: "fm-2", cost_usd: 0.20 },
    { date: "2026-05-01", family_member_id: "fm-1", cost_usd: 0.99 }, // old day
  ]);
  const r = await getCosts(sb, "fm-1");
  assertAlmostEquals(r.user, 0.15, 1e-9);
  assertAlmostEquals(r.global, 0.35, 1e-9);
});

Deno.test("getCosts: empty -> zero", async () => {
  const { sb } = mockSb();
  const r = await getCosts(sb, "fm-1");
  assertEquals(r.user, 0);
  assertEquals(r.global, 0);
});

Deno.test("enforceBudget: under both caps -> allowed, no warning", async () => {
  const { sb } = mockSb([
    { date: TODAY, family_member_id: "fm-1", cost_usd: 0.05 },
  ]);
  const r = await enforceBudget(sb, "fm-1", { userCap: 0.30, globalCap: 1.00 });
  assertEquals(r.allowed, true);
  assertEquals(r.warning, null);
});

Deno.test("enforceBudget: per-user soft cap exceeded -> allowed=true with warning", async () => {
  const { sb } = mockSb([
    { date: TODAY, family_member_id: "fm-1", cost_usd: 0.40 }, // > 0.30
    { date: TODAY, family_member_id: "fm-2", cost_usd: 0.10 },
  ]);
  const r = await enforceBudget(sb, "fm-1", { userCap: 0.30, globalCap: 1.00 });
  assertEquals(r.allowed, true);
  // warning is a non-null string
  assertEquals(typeof r.warning, "string");
});

Deno.test("enforceBudget: global hard cap exceeded -> throws BudgetExceededError", async () => {
  const { sb } = mockSb([
    { date: TODAY, family_member_id: "fm-1", cost_usd: 0.60 },
    { date: TODAY, family_member_id: "fm-2", cost_usd: 0.50 }, // global = 1.10
  ]);
  let caught: BudgetExceededError | null = null;
  try {
    await enforceBudget(sb, "fm-1", { userCap: 0.30, globalCap: 1.00 });
  } catch (e) {
    caught = e as BudgetExceededError;
  }
  if (!caught) throw new Error("expected throw");
  assertEquals(caught.scope, "global");
  assertEquals(caught.cap, 1.00);
});

Deno.test("enforceBudget: global takes precedence over per-user warning", async () => {
  const { sb } = mockSb([
    { date: TODAY, family_member_id: "fm-1", cost_usd: 1.50 },
  ]);
  let caught: BudgetExceededError | null = null;
  try {
    await enforceBudget(sb, "fm-1", { userCap: 0.30, globalCap: 1.00 });
  } catch (e) {
    caught = e as BudgetExceededError;
  }
  assertEquals(caught?.scope, "global");
});

Deno.test("recordUsage: inserts a row with computed today date", async () => {
  const { sb, rows } = mockSb();
  const r = await recordUsage(sb, {
    model: "claude-haiku-4-5-20251001",
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.0028,
    familyMemberId: "fm-1",
  });
  assertEquals(r.ok, true);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.date, TODAY);
  assertEquals(rows[0]!.cost_usd, 0.0028);
  assertEquals(rows[0]!.cache_read_tokens, 0);
});

Deno.test("readCapsFromEnv: defaults applied when vars absent", () => {
  Deno.env.delete("ANTHROPIC_DAILY_BUDGET_USD");
  Deno.env.delete("ANTHROPIC_DAILY_BUDGET_USD_PER_USER");
  const c = readCapsFromEnv();
  assertEquals(c.userCap, 0.30);
  assertEquals(c.globalCap, 1.00);
});

Deno.test("readCapsFromEnv: env override is parsed as number", () => {
  Deno.env.set("ANTHROPIC_DAILY_BUDGET_USD", "5.00");
  Deno.env.set("ANTHROPIC_DAILY_BUDGET_USD_PER_USER", "1.25");
  const c = readCapsFromEnv();
  assertEquals(c.globalCap, 5);
  assertEquals(c.userCap, 1.25);
  Deno.env.delete("ANTHROPIC_DAILY_BUDGET_USD");
  Deno.env.delete("ANTHROPIC_DAILY_BUDGET_USD_PER_USER");
});

Deno.test("BudgetExceededError: message contains scope and amounts", () => {
  const err = new BudgetExceededError("global", 1.5, 1.0);
  assertEquals(err.name, "BudgetExceededError");
  if (!err.message.includes("global")) {
    throw new Error("message missing scope");
  }
});

// Sanity that assertThrows works for our error type (covers the type guard).
Deno.test("assertThrows: BudgetExceededError is a real Error subclass", () => {
  assertThrows(
    () => {
      throw new BudgetExceededError("user", 1, 0);
    },
    BudgetExceededError,
  );
});
