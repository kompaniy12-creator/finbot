// FinBot text/voice expense parser. Model: Haiku 4.5.
// Per docs/06_PROMPTS.md §1.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const ParseExpenseTool: Anthropic.Messages.Tool = {
  name: "record_expenses",
  description:
    "Record one or more cash-flow events extracted from a user message. Each event is either an expense (money out) or income (money in).",
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
            kind: {
              type: "string",
              enum: ["expense", "income"],
              description:
                "expense (money out, default) or income (money in). Set 'income' when the user is reporting received money. Income triggers: 'получил', 'пришла', 'прислали', 'зарплата', 'аванс', 'гонорар', 'фриланс', 'халтура', 'темка', 'темки', 'дивиденды', 'кэшбэк', 'кешбек', 'возврат', 'вернули', 'отдали долг', 'подарили', 'подарок', 'salary', 'paycheck', 'freelance', 'refund', 'dividend', 'gift', 'paid me'. Default to 'expense' when unclear.",
            },
            name: {
              type: "string",
              description:
                "Item name in the original language (e.g., 'молоко 2%', 'kawa', 'зарплата июнь').",
            },
            name_normalized_en: {
              type: "string",
              description:
                "Short English description, lowercased, used for semantic search. For expenses: item name ('milk 2 percent', 'coffee'). For income: source/type ('salary monthly wage', 'freelance contract', 'dividend payout', 'gift from parents', 'cashback refund').",
            },
            amount: {
              type: "number",
              minimum: 0.01,
              description: "Amount in the original currency. Always positive, regardless of kind.",
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
                "Date the cash actually moved (Europe/Warsaw, ISO YYYY-MM-DD). Default to today. Phrases like 'за март', '03/2026', 'за апрель 2026' describe what was paid for or what period is covered, NOT when - keep them in the name and leave expense_date as today. Only explicit time words override today: 'вчера' = today-1, 'позавчера' = today-2, 'в субботу' = last Saturday, '12.05.2026' = that exact date.",
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

Bulk pasted lists with date-section headers (CRITICAL):
- A user may paste many expenses at once, grouped under date headers. A header looks like "Финансы: 01.06.2026", "01.06.2026:", "06.06.2026", "Расходы 5 июня", or a timestamped line "[06.06.2026 14:05] Финансы: 02.06.2026". The DATE inside such a header sets expense_date for EVERY item line that follows it, until the next header. Convert DD.MM.YYYY to ISO YYYY-MM-DD. If a timestamped prefix like "[06.06.2026 14:05]" and a "Финансы: 02.06.2026" appear on the same header line, the date is the one after "Финансы:" (02.06.2026), not the bracketed timestamp.
- Item lines look like "Maxi - 1620 lek", "Spar 2950 lek", "Rizoto - 1200", "Western - 300 lek". Emit ONE expense per item line: name = the merchant/item text, amount = the number, currency from the line (lek -> ALL), expense_date = the active header date (or today if no header has appeared yet).
- SKIP summary/total lines entirely - do NOT emit them as expenses: "Итого: 4570 lek", "💰 Чек: 4570 lek", "Всего: ...", "Total", "Сумма: ...", "Подытог". They are running totals.
- SKIP item lines that have NO amount: "Wes (сумма не указана?)", a bare "Western" with no number. Do not invent a number.
- A date header with no item lines under it (e.g. a lone "02.06.2026" / "03.06.2026") produces nothing.
- Keep going through the WHOLE message - a long list may contain 20+ items across many dates. Emit them all.

Dates (CRITICAL):
- expense_date is the date the user PAID, not the period the payment covers.
- "за <месяц>", "за <месяц> <год>", "03/2026", "04/2026", "за март", "электричество за апрель", "коммуналка за февраль", "оплата за квартал" are DESCRIPTIONS of what was paid for - they describe the billing period. KEEP that text inside the item name, and set expense_date = today.
- Explicit payment-date markers DO override today: "вчера" = today-1, "позавчера" = today-2, "в субботу" = last Saturday (not next), "01.03" = March 1 of current year (or previous year if that future date is > 30 days ahead), "12.05.2026" = that exact date.
- Examples:
  - "Электричество за март 9565 лек" today → expense_date = TODAY (the payment date), name = "электричество за март"
  - "9565 лек за электричество за март" today → expense_date = TODAY
  - "Вчера электричество за март 9565 лек" → expense_date = today-1
  - "12.05.2026 электричество за март 9565 лек" → expense_date = 2026-05-12
- name_normalized_en should be 2-4 English words optimized for semantic search by category. Lowercase. No punctuation. Examples:
  - "молоко 2.5% литр" -> "milk dairy"
  - "espresso в кафе" -> "coffee cafe drink"
  - "Lidl продукты на 130 zl" -> "groceries supermarket"
  - "бензин 95 на 200 zl" -> "fuel gasoline"
  - "детский комбинезон на ребёнка" -> "children clothing baby"
  - "электричество за январь" -> "electricity utility bill"
- If the message is NOT about an expense or income (greeting, question, etc.), do NOT call the tool. Respond with one short sentence asking what the user spent.

Income vs expense (NEW, CRITICAL):
- kind="income" when the user is reporting MONEY RECEIVED.
  Russian triggers: "получил/получила", "пришла", "пришло", "прислали", "зарплата", "аванс", "гонорар", "фриланс", "халтура", "темка", "темки", "дивиденды", "кэшбэк", "кешбек", "возврат", "вернули", "отдали долг", "подарили", "подарок мне".
  English triggers: "salary", "paycheck", "freelance", "refund", "dividend", "gift", "paid me", "got paid".
  Polish: "wypłata", "pensja", "zwrot", "prezent".
- kind="expense" (default) when user is reporting MONEY SPENT.
- Same item can never be both. If ambiguous (e.g. just "5000 zł"), default to expense.
- Examples:
  - "получил зарплату 5000 zł" -> kind=income, name="зарплата", name_normalized_en="salary monthly wage"
  - "фриланс 800 €" -> kind=income, name="фриланс", name_normalized_en="freelance contract work"
  - "дивиденды Apple 120 $" -> kind=income, name="дивиденды Apple", name_normalized_en="dividend stock payout"
  - "вернули долг 200 zł" -> kind=income, name="возврат долга", name_normalized_en="loan repayment received"
  - "подарили на ДР 500 zł" -> kind=income, name="подарок на день рождения", name_normalized_en="gift birthday money"
  - "Алла прислала кэшбэк 50 zł" -> kind=income, name="кэшбэк", name_normalized_en="cashback refund"
  - "кофе 12 zł" -> kind=expense (default)
  - "5000 zł" (no context) -> kind=expense (default)
`;

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
  kind: z.enum(["expense", "income"]).default("expense"),
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
