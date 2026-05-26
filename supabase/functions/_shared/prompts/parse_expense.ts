// FinBot text/voice expense parser. Model: Haiku 4.5.
// Per docs/06_PROMPTS.md §1.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const ParseExpenseTool: Anthropic.Messages.Tool = {
  name: "record_expenses",
  description: "Record one or more expenses extracted from a user message.",
  input_schema: {
    type: "object",
    required: ["expenses"],
    properties: {
      expenses: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["name", "name_normalized_en", "amount", "currency", "expense_date"],
          properties: {
            name: {
              type: "string",
              description:
                "Item name in the original language (e.g., 'молоко 2%', 'kawa', 'хліб').",
            },
            name_normalized_en: {
              type: "string",
              description:
                "Short English description of the item, lowercased, used for semantic search. Examples: 'milk 2 percent', 'coffee', 'bread'. Translate or transliterate proper nouns naturally (e.g., 'Biedronka' -> 'Biedronka grocery store').",
            },
            amount: {
              type: "number",
              minimum: 0.01,
              description: "Amount in the original currency.",
            },
            currency: {
              type: "string",
              enum: ["PLN", "EUR", "ALL", "USD"],
              description:
                "Currency code. If the message contains лек / lek / leku / leke / L → ALL. If zł / zl / pln → PLN. If € / eur → EUR. If $ → USD. Default PLN ONLY when no currency word is present AND the amount looks plausibly Polish.",
            },
            expense_date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description:
                "Date in ISO format (YYYY-MM-DD), in Europe/Warsaw timezone. Use today if not specified, parse 'вчера', 'позавчера', 'в субботу', dd.mm, etc. relative to today.",
            },
            description: {
              type: "string",
              description: "Optional clarification when item name is ambiguous. Brief.",
            },
          },
        },
      },
    },
  },
};

const STATIC_PART =
  `You are FinBot's expense parser. Extract structured expense data from a user's short message (text or voice transcript).

Family context:
- Based in Poznań, Poland, but frequently travels in Albania.
- Default currency: PLN.
- Languages used: Russian, Ukrainian, Polish, English, Albanian (mixed often).

Currency detection (CRITICAL - users often write currency as a word, recognise these aliases):
- ALL (Albanian lek): "лек", "лека", "леке", "леков", "леку", "leк", "lek", "leku", "leke", "lekë", "lekësh", "L". When you see ANY of these next to a number, currency MUST be ALL, never PLN.
- PLN (Polish zloty): "zł", "zl", "pln", "злот", "злотых", "złoty".
- EUR (euro): "€", "eur", "евро".
- USD (dollar): "$", "usd", "долл", "доллар".
- Albanian receipts often have values like 670, 1200, 5000+ (the lek is much weaker than zloty). If a number looks unusually large for the implied category in Poland (e.g. "вода 4000" or "электричество 9565") and the context suggests Albania, default to ALL rather than PLN.
- Only default to PLN when there is no currency word at all AND the amount is plausibly Polish.

Rules:
- Always call the record_expenses tool. Do not respond with plain text.
- Multiple items in one message: emit multiple array entries.
- If the user mentions "плюс", "и", "ещё", treat as separate items.
- If a quantity is implied ("3 кофе по 10 zł"), record as 3 separate items of 10 zł each.
- For dates: "вчера" = today-1, "позавчера" = today-2, "в субботу" = last Saturday (not next), "01.03" = March 1 of current year (or previous year if that future date is > 30 days ahead).
- name_normalized_en should be 2-4 English words optimized for semantic search by category. Lowercase. No punctuation. Examples:
  - "молоко 2.5% литр" -> "milk dairy"
  - "espresso в кафе" -> "coffee cafe drink"
  - "Lidl продукты на 130 zl" -> "groceries supermarket"
  - "бензин 95 на 200 zl" -> "fuel gasoline"
  - "детский комбинезон на ребёнка" -> "children clothing baby"
  - "электричество за январь" -> "electricity utility bill"
- If the message is NOT about an expense (greeting, question, etc.), do NOT call the tool. Respond with one short sentence asking what the user spent.`;

export function buildParseExpensePrompt(params: { todayWarsaw: string }): {
  system: Anthropic.Messages.TextBlockParam[];
  tools: Anthropic.Messages.Tool[];
} {
  return {
    system: [
      { type: "text", text: STATIC_PART, cache_control: { type: "ephemeral" } },
      { type: "text", text: `\n\nToday in Europe/Warsaw: ${params.todayWarsaw}.` },
    ],
    tools: [ParseExpenseTool],
  };
}

export const ParsedExpenseRowSchema = z.object({
  name: z.string().min(1),
  name_normalized_en: z.string().min(1),
  amount: z.number().positive(),
  currency: z.enum(["PLN", "EUR", "ALL", "USD"]),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().optional(),
});
export type ParsedExpenseRow = z.infer<typeof ParsedExpenseRowSchema>;

export const ParseExpenseOutputSchema = z.object({
  expenses: z.array(ParsedExpenseRowSchema).min(1),
});
export type ParseExpenseOutput = z.infer<typeof ParseExpenseOutputSchema>;
