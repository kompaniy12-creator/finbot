// Parses free-form Russian/Ukrainian/Polish/English text into a budget
// definition. The intent classifier (intent.ts) routes here any message that
// pairs a creation verb with "бюджет/лимит/budget" and a number, e.g.:
//   - "Добавь бюджет уличные животные 150 евро"
//   - "установи лимит на еду 2000 в месяц"
//   - "create a budget for transport 300 PLN weekly"

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const ParseBudgetTool: Anthropic.Messages.Tool = {
  name: "record_budget",
  description: "Define a spending budget: a cap on one category over a recurring period. " +
    "Extract the category the user named, the amount, the currency, and the period.",
  input_schema: {
    type: "object",
    required: ["category_name", "amount", "currency"],
    properties: {
      category_name: {
        type: "string",
        description: "The spending category the budget covers, in the user's original language " +
          "('уличные животные', 'еда', 'transport'). Strip the words 'бюджет', 'лимит', " +
          "'budget', 'на', 'for' - keep only the category itself.",
      },
      amount: {
        type: "number",
        minimum: 0.01,
        description: "Numeric cap. Always positive. Strip thousands separators.",
      },
      currency: {
        type: "string",
        enum: ["PLN", "EUR", "ALL", "USD"],
        description:
          "ISO code. 'zł'/'zl'/'pln' -> PLN. '€'/'eur'/'евро' -> EUR. 'lek'/'лек' -> ALL. " +
          "'$'/'usd'/'долл' -> USD. Bare number -> PLN.",
      },
      period: {
        type: "string",
        enum: ["weekly", "monthly", "yearly"],
        description: "Recurrence. 'в неделю'/'weekly' -> weekly, 'в год'/'yearly' -> yearly, " +
          "everything else (incl. unspecified) -> monthly.",
      },
    },
  },
};

export const ParseBudgetOutputSchema = z.object({
  category_name: z.string().min(1).max(120),
  amount: z.number().positive(),
  currency: z.enum(["PLN", "EUR", "ALL", "USD"]),
  period: z.enum(["weekly", "monthly", "yearly"]).optional(),
});

export function buildBudgetSystemPrompt(): string {
  return [
    "You are a budget-definition parser for a personal finance Telegram bot.",
    "Always emit exactly one tool call to record_budget. Never explain.",
    "Default currency is PLN when none is specified. Default period is monthly.",
    "category_name: extract the bare category the user wants to cap, dropping the",
    "words 'бюджет'/'лимит'/'budget'/'limit' and prepositions ('на', 'for', 'по').",
  ].join("\n");
}
