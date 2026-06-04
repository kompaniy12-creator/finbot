// Bank statement parser - mBank PL + Revolut. Sends the PDF to Claude
// Sonnet (document content type) and forces a structured tool call that
// returns one row per transaction.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const ParseBankStatementTool: Anthropic.Messages.Tool = {
  name: "parse_bank_statement",
  description:
    "Extract every transaction from a bank statement PDF. One call captures the entire statement.",
  input_schema: {
    type: "object",
    required: ["source", "lines"],
    properties: {
      source: {
        type: "string",
        enum: ["mbank", "revolut", "other"],
        description: "Detected bank from logo / header / format clues.",
      },
      period_start: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      period_end: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      lines: {
        type: "array",
        items: {
          type: "object",
          required: ["posted_date", "amount", "currency", "description", "method", "kind"],
          properties: {
            posted_date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Data księgowania / posted / settlement date (when bank applied it).",
            },
            transaction_date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description:
                "Data operacji / actual purchase date if explicitly mentioned (mBank prints 'DATA TRANSAKCJI: YYYY-MM-DD' for card purchases). Same as posted_date when not stated.",
            },
            amount: {
              type: "number",
              minimum: 0.01,
              description:
                "Always positive. The sign / inflow vs outflow is captured by the 'kind' field below.",
            },
            currency: {
              type: "string",
              enum: ["PLN", "EUR", "ALL", "USD"],
            },
            description: {
              type: "string",
              description: "Full text from the 'Opis operacji' field.",
            },
            merchant: {
              type: "string",
              description:
                "Best-guess merchant name (e.g. 'SPAR PLAZH DURRES', 'HOTEL ALION', 'PayPal'). Empty for internal transfers and bank fees.",
            },
            method: {
              type: "string",
              enum: ["card", "cash", "transfer", "fee"],
              description:
                "'card' for ZAKUP PRZY UŻYCIU KARTY / card payment. 'transfer' for PRZELEW / WIRE / BLIK / SEPA. 'fee' for bank charges, ODSETKI, OPŁATA. 'cash' if statement explicitly says cash (rare).",
            },
            kind: {
              type: "string",
              enum: ["expense", "income"],
              description:
                "'income' if money flows TO the account (Uznania / +), 'expense' if it flows OUT (Obciążenia / -).",
            },
            is_internal_transfer: {
              type: "boolean",
              description:
                "true if this is a transfer between the user's own accounts ('PRZELEW WŁASNY' or 'PRZELEW WEWNĘTRZNY' to the same name). The matcher will skip these.",
            },
          },
        },
      },
    },
  },
};

const PARSE_RULES =
  `You are a bank-statement parser. Read the attached PDF and emit ONE structured tool call describing every transaction.

CRITICAL ACCURACY RULES:
- Capture EVERY transaction line - do not summarize, do not skip "small" rows.
- Amounts are always positive in the output; the sign in the PDF maps to 'kind' (negative = expense, positive = income).
- For mBank PL: card purchases say "ZAKUP PRZY UŻYCIU KARTY <MERCHANT> /<CITY> DATA TRANSAKCJI: YYYY-MM-DD". Use that DATA TRANSAKCJI as the transaction_date and keep the booking date as posted_date.
- For Revolut: each row has the actual transaction date, no separate booking. Use the same date for both fields.
- Currency: bank charges are typically PLN (mBank) or whatever account currency Revolut shows. Even if the merchant is abroad, the bank line currency is the account currency (the bank already converted).
- For BLIK rows: method='transfer'. For "PRZELEW" of any kind: method='transfer'. For "ZAKUP KARTĄ": method='card'. For "ODSETKI" / "OPŁATA" / "PROWIZJA": method='fee'.
- Internal transfers: PRZELEW WŁASNY ("own transfer") and PRZELEW WEWNĘTRZNY (within same bank, same name) - set is_internal_transfer=true.
- Format dates strictly as YYYY-MM-DD.

PERIOD: emit period_start and period_end as written in the statement header (e.g. "od 2026-06-01 do 2026-06-03" → period_start 2026-06-01, period_end 2026-06-03).
`;

export function buildBankStatementPrompt(): {
  system: Anthropic.Messages.TextBlockParam[];
  tools: Anthropic.Messages.Tool[];
} {
  return {
    system: [{ type: "text", text: PARSE_RULES, cache_control: { type: "ephemeral" } }],
    tools: [ParseBankStatementTool],
  };
}

export const ParsedBankLineSchema = z.object({
  posted_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amount: z.number().positive(),
  currency: z.enum(["PLN", "EUR", "ALL", "USD"]),
  description: z.string(),
  merchant: z.string().optional(),
  method: z.enum(["card", "cash", "transfer", "fee"]),
  kind: z.enum(["expense", "income"]),
  is_internal_transfer: z.boolean().optional().default(false),
});
export type ParsedBankLine = z.infer<typeof ParsedBankLineSchema>;

export const ParseBankStatementOutputSchema = z.object({
  source: z.enum(["mbank", "revolut", "other"]).default("other"),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(ParsedBankLineSchema),
});
export type ParseBankStatementOutput = z.infer<typeof ParseBankStatementOutputSchema>;
