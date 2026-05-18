// Bridge between categorizer.FallbackResolver and Anthropic Claude.
// Calls categorize_fallback prompt, parses tool_use response, returns
// FallbackResolver-compatible decision.

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaude } from "./claude.ts";
import {
  buildCategorizeFallbackPrompt,
  CategorizeFallbackOutputSchema,
} from "./prompts/categorize_fallback.ts";
import type { CategoryRow, FallbackResolver, SimilarExpenseRow } from "./categorizer.ts";
import { log } from "./log.ts";

export function buildClaudeFallback(
  sb: SupabaseClient,
  familyMemberId: string,
): FallbackResolver {
  return async ({ topCategories, similarExamples, itemName, itemNormalizedEn }) => {
    const { system, tools } = buildCategorizeFallbackPrompt({
      existingCategories: topCategories.map(simplifyCategory),
      similarExpenses: similarExamples.map(simplifyExpense),
    });
    const model = Deno.env.get("CLAUDE_MODEL_FAST") ?? "claude-haiku-4-5-20251001";

    const { response } = await callClaude({
      sb,
      familyMemberId,
      model,
      system,
      tools,
      messages: [{
        role: "user",
        content: `Item: "${itemName}" (normalized: "${itemNormalizedEn}"). Choose a category.`,
      }],
      maxTokens: 256,
    });

    const toolUse = response.content.find((c) => c.type === "tool_use");
    if (!toolUse || toolUse.name !== "assign_category") {
      log("warn", "claude_fallback_no_tool_use", { item: itemName });
      return fallbackToOther(topCategories);
    }
    const parsed = CategorizeFallbackOutputSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      log("warn", "claude_fallback_bad_schema", { item: itemName });
      return fallbackToOther(topCategories);
    }
    const choice = parsed.data.category_choice;
    if (choice.existing_id) {
      const present = topCategories.find((c) => c.id === choice.existing_id);
      if (present) return { kind: "existing", categoryId: choice.existing_id };
      log("warn", "claude_fallback_existing_id_not_in_list", {
        id: choice.existing_id,
      });
      return fallbackToOther(topCategories);
    }
    if (choice.new_category) {
      return {
        kind: "new",
        name: choice.new_category.name,
        description: choice.new_category.description_en,
      };
    }
    return fallbackToOther(topCategories);
  };
}

function simplifyCategory(c: CategoryRow) {
  return { id: c.id, name: c.name, description: c.description };
}

function simplifyExpense(e: SimilarExpenseRow) {
  return { name: e.name, category_id: e.category_id, similarity: e.similarity };
}

function fallbackToOther(cats: CategoryRow[]):
  | { kind: "existing"; categoryId: string }
  | { kind: "new"; name: string; description: string } {
  const other = cats.find((c) => c.is_fallback);
  if (other) return { kind: "existing", categoryId: other.id };
  return { kind: "new", name: "Other", description: "miscellaneous expenses" };
}

// Re-export the Zod schema for tests.
export const _testing = { schema: z.unknown() };
