// Unit tests for cost computation per model.
// Pricing constants from SPEC §5; if Anthropic changes prices, update
// MODEL_PRICING in _shared/claude.ts and adjust these expected values.

import { assertAlmostEquals } from "@std/assert";
import { computeCost, MODEL_PRICING } from "../supabase/functions/_shared/claude.ts";

Deno.test("computeCost: Haiku 4.5 basic input+output", () => {
  // 1000 input tokens at $0.80/MTok = $0.0008
  // 500 output tokens at $4.00/MTok = $0.002
  // Total = $0.0028
  const cost = computeCost("claude-haiku-4-5-20251001", {
    input_tokens: 1000,
    output_tokens: 500,
  });
  assertAlmostEquals(cost, 0.0028, 1e-6);
});

Deno.test("computeCost: Haiku 4.5 with cache_read", () => {
  // 200 cache_read at $0.08/MTok = $0.000016
  // 100 input at $0.80/MTok      = $0.00008
  // 50 output at $4.00/MTok      = $0.0002
  // Total = ~$0.000296
  const cost = computeCost("claude-haiku-4-5-20251001", {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 200,
  });
  assertAlmostEquals(cost, 0.000296, 1e-7);
});

Deno.test("computeCost: Haiku 4.5 with cache_creation", () => {
  // 1000 cache_creation at $1.00/MTok = $0.001
  const cost = computeCost("claude-haiku-4-5-20251001", {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 1000,
  });
  assertAlmostEquals(cost, 0.001, 1e-7);
});

Deno.test("computeCost: Sonnet 4.6 mix of all four counters", () => {
  // 10000 input * $3.00/MTok      = $0.030
  // 2000 output * $15.00/MTok     = $0.030
  // 5000 cache_write * $3.75/MTok = $0.01875
  // 8000 cache_read * $0.30/MTok  = $0.0024
  // Total = $0.08115
  const cost = computeCost("claude-sonnet-4-6", {
    input_tokens: 10_000,
    output_tokens: 2_000,
    cache_creation_input_tokens: 5_000,
    cache_read_input_tokens: 8_000,
  });
  assertAlmostEquals(cost, 0.08115, 1e-6);
});

Deno.test("computeCost: unknown model returns 0 (warning logged)", () => {
  const cost = computeCost("unknown-model-id", {
    input_tokens: 999_999,
    output_tokens: 999_999,
  });
  assertAlmostEquals(cost, 0, 1e-9);
});

Deno.test("computeCost: zero tokens -> zero cost", () => {
  const cost = computeCost("claude-haiku-4-5-20251001", {
    input_tokens: 0,
    output_tokens: 0,
  });
  assertAlmostEquals(cost, 0, 1e-9);
});

Deno.test("computeCost: 1 million input tokens equals the per-MTok price", () => {
  // Sanity that the unit conversion is correct.
  const cost = computeCost("claude-haiku-4-5-20251001", {
    input_tokens: 1_000_000,
    output_tokens: 0,
  });
  assertAlmostEquals(
    cost,
    MODEL_PRICING["claude-haiku-4-5-20251001"]!.inputPerMTok,
    1e-9,
  );
});
