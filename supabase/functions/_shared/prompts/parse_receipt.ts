// Receipt vision parser. Model: Sonnet 4.6.
// Per docs/06_PROMPTS.md §2.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const ParseReceiptTool: Anthropic.Messages.Tool = {
  name: "record_receipt",
  description: "Parse a photo of a receipt and extract merchant, date, total, and itemized list.",
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
      items: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["name", "name_normalized_en", "amount"],
          properties: {
            name: { type: "string" },
            name_normalized_en: { type: "string" },
            amount: { type: "number" },
            qty: { type: "number" },
          },
        },
      },
      note: { type: "string" },
    },
  },
};

const STATIC_PART = `You are FinBot's receipt parser. Extract structured data from a receipt photo.

Family context:
- Based in Poznań, Poland (most receipts are Polish, in PLN, from chains like Biedronka, Lidl, Auchan, Carrefour, Żabka, Rossmann, etc.).
- Occasional Albanian receipts (ALL currency, business trip context).
- Receipts may be in Polish, English, German, Ukrainian.

Rules:
- Always call the record_receipt tool with structured data. Do not respond with prose.
- Extract EVERY line item that is a purchased product or service. Skip non-items: subtotals, discounts (unless explicitly a discount item), tax lines, payment method lines.
- amount must be the line total (after any item-level discount), not unit price.
- Sum of items.amount should match total within +/- 5%. If it doesn't, still emit your best guess for each, the application will reconcile.
- For each item, name_normalized_en should categorize the item generically in English: 'milk dairy', 'bread bakery', 'cheese dairy', 'fruit fresh', 'shampoo cosmetics', 'detergent household', etc.
- If receipt is blurry/unreadable in parts: still emit what you can, set 'note' field describing what's missing.
- Date format on Polish receipts is usually DD-MM-YYYY or YYYY-MM-DD. Convert to ISO YYYY-MM-DD.
- Currency: Polish receipts use 'zł' suffix or 'PLN'. Default PLN if unclear.`;

export function buildParseReceiptPrompt(params: { todayWarsaw: string }): {
  system: Anthropic.Messages.TextBlockParam[];
  tools: Anthropic.Messages.Tool[];
} {
  return {
    system: [
      { type: "text", text: STATIC_PART, cache_control: { type: "ephemeral" } },
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
});
export const ParsedReceiptSchema = z.object({
  merchant: z.string(),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.enum(["PLN", "EUR", "ALL", "USD"]),
  total: z.number().positive(),
  items: z.array(ParsedReceiptItemSchema).min(1),
  note: z.string().optional(),
});
export type ParsedReceipt = z.infer<typeof ParsedReceiptSchema>;
