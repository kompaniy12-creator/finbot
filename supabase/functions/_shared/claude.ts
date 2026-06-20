// Thin wrapper around npm:@anthropic-ai/sdk for FinBot.
//
// Responsibilities:
//   1. Read model snapshots from env (CLAUDE_MODEL_FAST, CLAUDE_MODEL_VISION).
//   2. Pre-call: enforceBudget (throws BudgetExceededError on global cap hit).
//   3. Call Anthropic with tool_use + temperature=0 + prompt caching support.
//   4. Compute cost in USD from `usage` and MODEL_PRICING constants.
//   5. Insert into anthropic_usage and return parsed response + cost.
//
// Pricing is exported so tests can verify computations against fixtures.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./log.ts";
import { enforceBudget, recordUsage } from "./budget.ts";
import { decryptSecret } from "./crypto_box.ts";

// Per SPEC §5 cost reference (as of Jan 2026). USD per million tokens.
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude Haiku 4.5
  "claude-haiku-4-5-20251001": {
    inputPerMTok: 0.80,
    outputPerMTok: 4.00,
    cacheWritePerMTok: 1.00,
    cacheReadPerMTok: 0.08,
  },
  // Claude Sonnet 4.6
  "claude-sonnet-4-6": {
    inputPerMTok: 3.00,
    outputPerMTok: 15.00,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.30,
  },
};

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Compute cost in USD given a model id and usage block from Anthropic's response.
 * Returns 0 if model is unknown (with warning log so we notice price-list drift).
 */
export function computeCost(model: string, usage: ClaudeUsage): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    log("warn", "claude_unknown_model_pricing", { model });
    return 0;
  }
  const inputCost = (usage.input_tokens / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.outputPerMTok;
  const cacheWriteCost = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
    pricing.cacheWritePerMTok;
  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
    pricing.cacheReadPerMTok;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

// The family tenant uses the owner's env key; SaaS tenants must supply their
// own (so they pay for their own usage). Thrown when a SaaS tenant has no key.
export const NO_API_KEY = "no_api_key";
export const FAMILY_TENANT = "00000000-0000-0000-0000-000000000001";

// Cache Anthropic clients by API key so we reuse connections across calls.
const clientByKey = new Map<string, Anthropic>();
function clientForKey(apiKey: string): Anthropic {
  let c = clientByKey.get(apiKey);
  if (!c) {
    c = new Anthropic({ apiKey });
    clientByKey.set(apiKey, c);
  }
  return c;
}

// Resolve the Anthropic client for a tenant: the tenant's own key if set,
// otherwise the env key for the family tenant. A SaaS tenant without a key
// throws NO_API_KEY (we never bill the owner for a tester's usage).
async function resolveAnthropicClient(
  sb: SupabaseClient,
  tenantId?: string,
): Promise<Anthropic> {
  if (tenantId && tenantId !== FAMILY_TENANT) {
    const r = await sb.from("tenants").select("anthropic_api_key").eq("id", tenantId).maybeSingle();
    const stored = (r.data as { anthropic_api_key: string | null } | null)?.anthropic_api_key;
    const key = await decryptSecret(stored);
    if (key) return clientForKey(key);
    throw new Error(NO_API_KEY);
  }
  return getAnthropicClient();
}

let cachedClient: Anthropic | null = null;
export function getAnthropicClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

export function resetAnthropicClientForTests(): void {
  cachedClient = null;
}

export interface CallClaudeOpts {
  model: string;
  system: Anthropic.Messages.TextBlockParam[] | string;
  tools?: Anthropic.Messages.Tool[];
  messages: Anthropic.Messages.MessageParam[];
  maxTokens?: number;
  toolChoice?: Anthropic.Messages.MessageCreateParams["tool_choice"];
  familyMemberId: string;
  /** Tenant whose API key to bill. Omit/family-sentinel uses the owner's env key. */
  tenantId?: string;
  sb: SupabaseClient;
}

export interface CallClaudeResult {
  response: Anthropic.Messages.Message;
  costUsd: number;
  warning: string | null;
}

/**
 * High-level wrapper: enforce budget, call Anthropic, record usage.
 * Uses temperature=0 by default for deterministic structured output.
 */
export async function callClaude(opts: CallClaudeOpts): Promise<CallClaudeResult> {
  const enforce = await enforceBudget(opts.sb, opts.familyMemberId);
  const client = await resolveAnthropicClient(opts.sb, opts.tenantId);

  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: 0,
    system: typeof opts.system === "string" ? opts.system : opts.system as unknown as string,
    messages: opts.messages,
  };
  if (opts.tools) params.tools = opts.tools;
  if (opts.toolChoice) params.tool_choice = opts.toolChoice;
  if (Array.isArray(opts.system)) {
    // When system is a TextBlockParam[] (e.g. with cache_control), pass as-is.
    (params as unknown as { system: Anthropic.Messages.TextBlockParam[] }).system = opts.system;
  }

  const response = await client.messages.create(params);
  const usage = response.usage as unknown as ClaudeUsage;
  const costUsd = computeCost(opts.model, usage);

  await recordUsage(opts.sb, {
    model: opts.model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd,
    familyMemberId: opts.familyMemberId,
  });

  return { response, costUsd, warning: enforce.warning };
}

/**
 * Build a system param array with prompt caching on the static portion.
 * Per Anthropic docs: only the LAST cache_control marker is honored as the
 * cache breakpoint; everything before it is the cached prefix.
 */
export function cachedSystem(
  staticPrefix: string,
  dynamicSuffix?: string,
): Anthropic.Messages.TextBlockParam[] {
  const blocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: "text",
      text: staticPrefix,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (dynamicSuffix && dynamicSuffix.length > 0) {
    blocks.push({ type: "text", text: dynamicSuffix });
  }
  return blocks;
}
