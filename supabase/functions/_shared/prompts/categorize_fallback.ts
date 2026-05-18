// Categorize fallback prompt - used when kNN is unsure (similarity < 0.85).
// Model: Haiku 4.5. Per docs/06_PROMPTS.md §3.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const CategorizeFallbackTool: Anthropic.Messages.Tool = {
  name: "assign_category",
  description: "Assign a category to an expense item, either existing or a new one.",
  input_schema: {
    type: "object",
    required: ["category_choice"],
    properties: {
      category_choice: {
        type: "object",
        description: "Choose either existing_id or new_category, not both.",
        properties: {
          existing_id: {
            type: "string",
            description: "UUID of an existing category from the provided list.",
          },
          new_category: {
            type: "object",
            required: ["name", "description_en"],
            properties: {
              name: { type: "string", description: "Russian or Polish localized name." },
              description_en: {
                type: "string",
                description: "Short English description for embedding generation.",
              },
            },
          },
        },
      },
      reason: { type: "string", description: "One short sentence why this category fits." },
    },
  },
};

const STATIC_PART =
  `You are FinBot's category fallback. The kNN classifier was unsure, so you decide.

Rules:
- Prefer existing categories from the provided list whenever any of them could reasonably fit.
- Only suggest a new category if NONE of the existing categories make sense. New categories should be rare. Reuse aggressively.
- "Other" is the fallback when nothing fits and a new category would be too specific.
- Always call assign_category tool. No plain text.`;

export function buildCategorizeFallbackPrompt(params: {
  existingCategories: Array<{ id: string; name: string; description: string | null }>;
  similarExpenses: Array<{ name: string; category_id: string; similarity: number }>;
}): {
  system: Anthropic.Messages.TextBlockParam[];
  tools: Anthropic.Messages.Tool[];
} {
  const categoriesList = params.existingCategories
    .map((c) => `- ${c.id} | ${c.name}${c.description ? " (" + c.description + ")" : ""}`)
    .join("\n");
  const examplesList = params.similarExpenses
    .map((e) =>
      `- "${e.name}" -> category ${e.category_id} (similarity ${e.similarity.toFixed(2)})`
    )
    .join("\n");
  const dynamicPart =
    `\n\nExisting categories:\n${categoriesList}\n\nSimilar past expenses (low confidence):\n${
      examplesList || "(none)"
    }\n`;
  return {
    system: [
      { type: "text", text: STATIC_PART, cache_control: { type: "ephemeral" } },
      { type: "text", text: dynamicPart },
    ],
    tools: [CategorizeFallbackTool],
  };
}

export const CategorizeFallbackOutputSchema = z.object({
  category_choice: z.object({
    existing_id: z.string().uuid().optional(),
    new_category: z.object({
      name: z.string().min(1),
      description_en: z.string().min(1),
    }).optional(),
  }),
  reason: z.string().optional(),
});
export type CategorizeFallbackOutput = z.infer<typeof CategorizeFallbackOutputSchema>;
