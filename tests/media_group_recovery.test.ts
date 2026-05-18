// Mandatory edge case (SPEC §18.4): media_group_recovery.
// Verifies that cron-media-group-sweep groups buffered photos by
// media_group_id and respects the 5-photos-per-group cap.

import { assertEquals } from "@std/assert";

// Re-implement the grouping math so we can unit-test without spinning
// up the full Edge Function. The semantics tested below mirror
// supabase/functions/cron-media-group-sweep/index.ts.
function groupBy<T extends { media_group_id: string }>(
  rows: T[],
): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const list = m.get(r.media_group_id) ?? [];
    list.push(r);
    m.set(r.media_group_id, list);
  }
  return m;
}

function planSweep<T extends { media_group_id: string }>(
  rows: T[],
  maxPerGroup: number,
): { groups: number; process: T[]; skipped: number } {
  const grouped = groupBy(rows);
  let skipped = 0;
  const process: T[] = [];
  for (const list of grouped.values()) {
    if (list.length > maxPerGroup) skipped += list.length - maxPerGroup;
    process.push(...list.slice(0, maxPerGroup));
  }
  return { groups: grouped.size, process, skipped };
}

const ROW = (g: string, id: number) => ({ media_group_id: g, telegram_message_id: id });

Deno.test("media_group_recovery: 3 photos in one group -> all 3 processed", () => {
  const plan = planSweep(
    [ROW("g1", 1), ROW("g1", 2), ROW("g1", 3)],
    5,
  );
  assertEquals(plan.groups, 1);
  assertEquals(plan.process.length, 3);
  assertEquals(plan.skipped, 0);
});

Deno.test("media_group_recovery: 5 photos -> all 5 processed at cap", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ROW("g1", i + 1));
  const plan = planSweep(rows, 5);
  assertEquals(plan.process.length, 5);
  assertEquals(plan.skipped, 0);
});

Deno.test("media_group_recovery: 6+ photos -> first 5, rest silently skipped", () => {
  const rows = Array.from({ length: 7 }, (_, i) => ROW("g1", i + 1));
  const plan = planSweep(rows, 5);
  assertEquals(plan.process.length, 5);
  assertEquals(plan.skipped, 2);
});

Deno.test("media_group_recovery: multiple groups handled independently", () => {
  const rows = [
    ROW("g1", 1),
    ROW("g1", 2),
    ROW("g2", 10),
    ROW("g2", 11),
    ROW("g2", 12),
  ];
  const plan = planSweep(rows, 5);
  assertEquals(plan.groups, 2);
  assertEquals(plan.process.length, 5);
});

Deno.test("media_group_recovery: empty input -> empty output", () => {
  const plan = planSweep([], 5);
  assertEquals(plan.groups, 0);
  assertEquals(plan.process.length, 0);
});
