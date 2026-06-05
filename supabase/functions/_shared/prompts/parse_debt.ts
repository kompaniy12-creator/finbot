// Parses free-form Russian/English/Polish/Ukrainian text into a debt
// record. The text classifier (intent.ts DEBT_PATTERNS) routes here
// any message that contains phrases like:
//   - "1000 дал в долг Паше"
//   - "одолжил Маше 200 EUR до 15 июля"
//   - "взял в долг у бати 500 zł"
//   - "Денис должен мне 480"
//   - "I lent Sasha 100 USD"

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const ParseDebtTool: Anthropic.Messages.Tool = {
  name: "record_debt",
  description:
    "Record a single debt: money the user lent to someone, or money the user borrowed. " +
    "Direction is critical: 'owed_to_me' = I gave money to X, X must return it. " +
    "'i_owe' = X gave me money, I must return it to X.",
  input_schema: {
    type: "object",
    required: ["direction", "counterparty", "amount", "currency"],
    properties: {
      direction: {
        type: "string",
        enum: ["owed_to_me", "i_owe"],
        description:
          "owed_to_me = the user lent money out and expects it back. Triggers: 'дал в долг', 'одолжил X-у', 'lent', 'X owes me'. " +
          "i_owe = the user borrowed money and has to pay it back. Triggers: 'взял в долг у', 'занял у', 'borrowed from', 'I owe X'. " +
          "When ambiguous, default to 'owed_to_me' because that's the user's more common use case.",
      },
      counterparty: {
        type: "string",
        description:
          "Other person's name in the original language ('Паша', 'Маша', 'Денис кум', 'Sasha'). Trim titles like 'у', 'для'. If the user wrote a nickname or short form, keep it as-is.",
      },
      amount: {
        type: "number",
        minimum: 0.01,
        description: "Numeric amount. Always positive. Strip thousands separators.",
      },
      currency: {
        type: "string",
        enum: ["PLN", "EUR", "ALL", "USD"],
        description:
          "ISO currency code. Defaults: bare numbers in the user's home region → PLN. 'zł', 'zl', 'pln' → PLN. '€', 'eur', 'евро' → EUR. 'lek', 'лек' → ALL. '$', 'usd', 'долл' → USD.",
      },
      borrowed_at: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description:
          "Date of the deal in YYYY-MM-DD. Use TODAY if the user doesn't say. If they say 'вчера' use yesterday; 'на прошлой неделе' use 7 days ago. Today's date is provided in the system prompt.",
      },
      due_date: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description:
          "Optional repayment deadline. Set ONLY when the user mentions a deadline ('до 15 июля', 'через месяц', 'until July'). If they say 'через месяц' add 30 days to borrowed_at. If they say 'до конца месяца' use the last day of borrowed_at's month. Leave out otherwise.",
      },
      note: {
        type: "string",
        description:
          "Optional free-text context, e.g. 'на машину', 'for rent', 'свадьба'. Skip if the user gave only the bare essentials.",
      },
    },
  },
};

export const ParseDebtOutputSchema = z.object({
  direction: z.enum(["owed_to_me", "i_owe"]),
  counterparty: z.string().min(1).max(120),
  amount: z.number().positive(),
  currency: z.enum(["PLN", "EUR", "ALL", "USD"]),
  borrowed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(500).optional(),
});

export function buildDebtSystemPrompt(todayIso: string): string {
  return [
    "You are a debt-recording parser for a personal finance Telegram bot.",
    `Today's date is ${todayIso} (Europe/Warsaw).`,
    "Always emit exactly one tool call to record_debt. Never explain.",
    "If the message is ambiguous about direction, default to owed_to_me.",
    "Default currency is PLN when none is specified.",
    "Counterparty: extract the bare name. Drop prepositions like 'у', 'для', 'to', 'from'.",
    "If the user names themselves as the lender ('я дал', 'я одолжил'), direction is owed_to_me.",
    "If the user names themselves as the borrower ('я взял', 'я занял'), direction is i_owe.",
  ].join("\n");
}
