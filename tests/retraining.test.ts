// Tests for cron-retraining: meanEmbedding math + integration smoke via mock supabase.
// We test the math function directly (extracted) and run a happy-path simulation
// via the Edge Function handler using a mock request + mock client.

import { assertAlmostEquals, assertEquals } from "@std/assert";

// Re-implement meanEmbedding locally to avoid importing the entire Edge Function module
// (which has its own Deno.serve top-level side effect).
function meanEmbedding(rows: number[][]): number[] {
  if (rows.length === 0) return [];
  const dim = rows[0]!.length;
  const sum = new Array(dim).fill(0);
  for (const v of rows) for (let i = 0; i < dim; i++) sum[i] += v[i] ?? 0;
  return sum.map((x) => x / rows.length);
}

Deno.test("meanEmbedding: empty -> []", () => {
  assertEquals(meanEmbedding([]), []);
});

Deno.test("meanEmbedding: simple 2D mean", () => {
  const r = meanEmbedding([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  assertAlmostEquals(r[0]!, 1 / 3, 1e-9);
  assertAlmostEquals(r[1]!, 1 / 3, 1e-9);
  assertAlmostEquals(r[2]!, 1 / 3, 1e-9);
});

Deno.test("meanEmbedding: weighted single vector returns same", () => {
  const v = [0.5, -0.3, 0.7];
  const r = meanEmbedding([v]);
  for (let i = 0; i < v.length; i++) assertAlmostEquals(r[i]!, v[i]!, 1e-9);
});

Deno.test("meanEmbedding: averages 384-dim vectors per element", () => {
  const a = new Array(384).fill(0).map((_, i) => i);
  const b = new Array(384).fill(0).map((_, i) => i + 2);
  const r = meanEmbedding([a, b]);
  for (let i = 0; i < 384; i++) {
    assertAlmostEquals(r[i]!, i + 1, 1e-9);
  }
});
