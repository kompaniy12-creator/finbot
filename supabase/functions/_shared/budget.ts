// Two-tier daily budget for Anthropic Claude calls.
// Per SPEC §7.5:
//   - per-user soft cap (ANTHROPIC_DAILY_BUDGET_USD_PER_USER, default 0.30 USD/day):
//     warn-only; processing continues until global hits its hard ceiling
//   - global hard cap (ANTHROPIC_DAILY_BUDGET_USD, default 1.00 USD/day):
//     throws BudgetExceededError so caller can show "🚫 Дневной бюджет исчерпан"
//
// Costs are stored in `anthropic_usage` (one row per Claude call) with date,
// model, token counts, computed cost_usd, family_member_id.

import type { SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_USER_CAP = 0.30;
export const DEFAULT_GLOBAL_CAP = 1.00;

export class BudgetExceededError extends Error {
  constructor(public scope: "global" | "user", public spent: number, public cap: number) {
    super(`Budget exceeded (${scope}): $${spent.toFixed(4)} >= $${cap.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

export interface BudgetUsage {
  user: number;
  global: number;
}

export interface BudgetCaps {
  userCap: number;
  globalCap: number;
}

export function readCapsFromEnv(): BudgetCaps {
  const userRaw = Deno.env.get("ANTHROPIC_DAILY_BUDGET_USD_PER_USER");
  const globalRaw = Deno.env.get("ANTHROPIC_DAILY_BUDGET_USD");
  return {
    userCap: userRaw ? Number(userRaw) : DEFAULT_USER_CAP,
    globalCap: globalRaw ? Number(globalRaw) : DEFAULT_GLOBAL_CAP,
  };
}

/**
 * Sum cost_usd over today (in UTC date semantics, same as anthropic_usage.date default).
 */
export async function getCosts(
  sb: SupabaseClient,
  familyMemberId: string,
): Promise<BudgetUsage> {
  const today = new Date().toISOString().slice(0, 10);

  const [userR, globalR] = await Promise.all([
    sb.from("anthropic_usage")
      .select("cost_usd")
      .eq("date", today)
      .eq("family_member_id", familyMemberId),
    sb.from("anthropic_usage")
      .select("cost_usd")
      .eq("date", today),
  ]);

  const userRows = (userR.data ?? []) as Array<{ cost_usd: number | string }>;
  const globalRows = (globalR.data ?? []) as Array<{ cost_usd: number | string }>;

  const sum = (rows: Array<{ cost_usd: number | string }>): number =>
    rows.reduce((acc, r) => acc + Number(r.cost_usd), 0);

  return { user: sum(userRows), global: sum(globalRows) };
}

export interface EnforceResult {
  allowed: boolean;
  warning: string | null;
  usage: BudgetUsage;
}

/**
 * Pre-check before each Claude call. Throws BudgetExceededError on global hit.
 * Returns warning string when per-user soft cap is over.
 */
export async function enforceBudget(
  sb: SupabaseClient,
  familyMemberId: string,
  caps: BudgetCaps = readCapsFromEnv(),
): Promise<EnforceResult> {
  const usage = await getCosts(sb, familyMemberId);

  if (usage.global >= caps.globalCap) {
    throw new BudgetExceededError("global", usage.global, caps.globalCap);
  }

  if (usage.user >= caps.userCap) {
    return {
      allowed: true,
      warning: `per-user soft cap exceeded: $${usage.user.toFixed(4)} >= $${
        caps.userCap.toFixed(2)
      }`,
      usage,
    };
  }

  return { allowed: true, warning: null, usage };
}

export async function recordUsage(
  sb: SupabaseClient,
  args: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd: number;
    familyMemberId: string;
  },
): Promise<{ ok: boolean; error: string | null }> {
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await sb.from("anthropic_usage").insert({
    date: today,
    model: args.model,
    input_tokens: args.inputTokens,
    output_tokens: args.outputTokens,
    cache_read_tokens: args.cacheReadTokens ?? 0,
    cache_write_tokens: args.cacheWriteTokens ?? 0,
    cost_usd: args.costUsd,
    family_member_id: args.familyMemberId,
  });
  return { ok: !error, error: error?.message ?? null };
}
