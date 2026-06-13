// Receipt vision parser. Model: Sonnet 4.6.
// Per docs/06_PROMPTS.md §2.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const ParseReceiptTool: Anthropic.Messages.Tool = {
  name: "record_receipt",
  description:
    "Parse a photo of a receipt and extract merchant, date, total, itemized list, and the best-fit category for each item from the provided category list.",
  input_schema: {
    type: "object",
    required: ["merchant", "receipt_date", "currency", "total", "items"],
    properties: {
      merchant: { type: "string" },
      receipt_date: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      },
      currency: { type: "string", enum: ["PLN", "EUR", "ALL", "USD"] },
      total: { type: "number", minimum: 0.01 },
      kind: {
        type: "string",
        enum: ["expense", "income"],
        description: "Direction of money for the WHOLE document. 'income' = money RECEIVED: " +
          "a bank-app screenshot of an incoming/credited transfer ('wpływy', " +
          "'uznanie', 'przychodzący', 'wynagrodzenie', 'przelew przychodzący', a green " +
          "or '+' amount), a salary/dividend/payout deposit, money-in notification. " +
          "'expense' (DEFAULT) = a normal purchase receipt from a shop/restaurant, or " +
          "an outgoing/debited transfer ('obciążenie', 'wychodzący', a '-' amount).",
      },
      items: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["name", "name_normalized_en", "amount", "category_id"],
          properties: {
            name: { type: "string" },
            name_normalized_en: { type: "string" },
            amount: { type: "number" },
            qty: { type: "number" },
            category_id: {
              type: "string",
              description:
                "Pick the UUID of the best-fit category from the provided list. Must match one of the IDs exactly. If unsure, pick the fallback category.",
            },
          },
        },
      },
      note: { type: "string" },
    },
  },
};

const STATIC_PART =
  `You are FinBot's receipt parser. Extract structured data from a receipt photo and assign each line item to one of the family's existing categories.

Family context:
- Based in Poznań, Poland (most receipts are Polish, in PLN, from chains like Biedronka, Lidl, Auchan, Carrefour, Żabka, Rossmann, etc.).
- Occasional Albanian receipts (ALL currency, business trip context).
- Receipts may be in Polish, English, German, Ukrainian, Albanian.

Rules:
- Always call the record_receipt tool with structured data. Do not respond with prose.
- Extract EVERY line item that is a purchased product or service. Skip non-items: subtotals, discounts (unless explicitly a discount item), tax lines, payment method lines.
- amount must be the line total (after any item-level discount), not unit price.
- Sum of items.amount should match total within +/- 5%. If it doesn't, still emit your best guess for each, the application will reconcile.
- For each item, name_normalized_en should categorize the item generically in English: 'milk dairy', 'bread bakery', 'cheese dairy', 'fruit fresh', 'shampoo cosmetics', 'detergent household', etc.
- For each item, category_id MUST be one of the UUIDs from the provided "Available categories" list. Pick the closest semantic match. Pet food + pet care + vet items go to the pets category. Alcohol (wine, beer, spirits) goes to the alcohol category. Cosmetics + grooming + beauty go to the self-care category. Cleaning supplies, household chemicals go to the home-care category. If genuinely unsure or the item is miscellaneous, use the category marked (fallback).
- If receipt is blurry/unreadable in parts: still emit what you can, set 'note' field describing what's missing.
- Date format on Polish receipts is usually DD-MM-YYYY or YYYY-MM-DD. Convert to ISO YYYY-MM-DD.
- Receipt date should be very close to today's date (typically within the last few days). If the printed year is partly cut off or ambiguous (e.g. "25/05/26" could be 2025 or 2026), assume it is THIS year - the year given as "today" in the system prompt. Never emit a date more than 60 days in the past or more than 1 day in the future; if unsure, use today's date.
- Currency: Polish receipts use 'zł' suffix or 'PLN'. Default PLN if unclear.
- kind: set 'income' ONLY when the photo is clearly MONEY RECEIVED - a bank-app
  screenshot of an incoming/credited transfer (wpływy, uznanie, przychodzący,
  wynagrodzenie, a green or '+' amount, salary/dividend/payout deposit). A normal
  shop/restaurant purchase receipt, or an outgoing/debited transfer, is 'expense'
  (the default). When in doubt, use 'expense'.`;

export interface VisionCategoryHint {
  id: string;
  name: string;
  is_fallback: boolean;
}

export function buildParseReceiptPrompt(params: {
  todayWarsaw: string;
  categories: VisionCategoryHint[];
}): {
  system: Anthropic.Messages.TextBlockParam[];
  tools: Anthropic.Messages.Tool[];
} {
  const catLines = params.categories
    .map((c) => `- ${c.id}  ${c.name}${c.is_fallback ? "  (fallback)" : ""}`)
    .join("\n");
  return {
    system: [
      { type: "text", text: STATIC_PART, cache_control: { type: "ephemeral" } },
      {
        type: "text",
        text: `\n\nAvailable categories (use these UUIDs exactly for category_id):\n${catLines}`,
      },
      { type: "text", text: `\n\nToday in Europe/Warsaw: ${params.todayWarsaw}.` },
    ],
    tools: [ParseReceiptTool],
  };
}

export const ParsedReceiptItemSchema = z.object({
  name: z.string().min(1),
  name_normalized_en: z.string().min(1),
  amount: z.number().positive(),
  qty: z.number().positive().optional(),
  category_id: z.string().regex(/^[0-9a-f-]{36}$/i),
});
export const ParsedReceiptSchema = z.object({
  merchant: z.string(),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.enum(["PLN", "EUR", "ALL", "USD"]),
  total: z.number().positive(),
  kind: z.enum(["expense", "income"]).default("expense"),
  items: z.array(ParsedReceiptItemSchema).min(1),
  note: z.string().optional(),
});
export type ParsedReceipt = z.infer<typeof ParsedReceiptSchema>;
