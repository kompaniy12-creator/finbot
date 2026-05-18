# 06 PROMPTS, точные шаблоны промптов Claude

Все промпты живут в `supabase/functions/_shared/prompts/`. Каждый файл экспортирует функцию, которая
возвращает `{ system, tools, model_hint }`. Это нужно чтобы:

1. Промпты были одним местом для аудита и правок.
2. Динамические части (текущая дата, локаль, список категорий) подставлялись детерминированно.
3. Статическая часть промпта была идентична между вызовами для prompt caching.

## 1. parse_expense.ts

Используется для парсинга текста и транскрибированного голоса. Модель: `CLAUDE_MODEL_FAST` (Haiku
4.5).

```typescript
// supabase/functions/_shared/prompts/parse_expense.ts
import { z } from "npm:zod@3.23.8";

export const ParseExpenseTool = {
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
                "Currency code. Default PLN if user did not specify and is based in Poland.",
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

export function buildParseExpensePrompt(params: {
  todayWarsaw: string;
  userLocale?: string;
}): {
  system: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[];
  tools: typeof ParseExpenseTool[];
} {
  const staticPart =
    `You are FinBot's expense parser. Extract structured expense data from a user's short message (text or voice transcript).

Family context:
- Based in Poznań, Poland.
- Default currency: PLN.
- Languages used: Russian, Ukrainian, Polish, English (mixed often).

Rules:
- Always call the record_expenses tool. Do not respond with plain text.
- Multiple items in one message: emit multiple array entries.
- If the user mentions "плюс", "и", "ещё", treat as separate items.
- If a quantity is implied ("3 кофе по 10 zł"), record as 3 separate items of 10 zł each.
- If currency is unspecified, default to PLN.
- For dates: "вчера" = today-1, "позавчера" = today-2, "в субботу" = last Saturday (not next), "01.03" = March 1 of current year (or previous year if that future date is > 30 days ahead).
- name_normalized_en should be 2-4 English words optimized for semantic search by category. Lowercase. No punctuation. Examples:
  - "молоко 2.5% литр" -> "milk dairy"
  - "espresso в кафе" -> "coffee cafe drink"
  - "Lidl продукты на 130 zl" -> "groceries supermarket"
  - "бензин 95 на 200 zl" -> "fuel gasoline"
  - "детский комбинезон на ребёнка" -> "children clothing baby"
  - "электричество за январь" -> "electricity utility bill"
- If the message is NOT about an expense (greeting, question, etc.), do NOT call the tool. Respond with one short sentence asking what the user spent.`;

  const dynamicPart = `\n\nToday in Europe/Warsaw: ${params.todayWarsaw}.`;

  return {
    system: [
      { type: "text", text: staticPart, cache_control: { type: "ephemeral" } },
      { type: "text", text: dynamicPart },
    ],
    tools: [ParseExpenseTool],
  };
}

export const ParsedExpenseRow = z.object({
  name: z.string().min(1),
  name_normalized_en: z.string().min(1),
  amount: z.number().positive(),
  currency: z.enum(["PLN", "EUR", "ALL", "USD"]),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().optional(),
});
export type ParsedExpenseRow = z.infer<typeof ParsedExpenseRow>;
```

### Использование

```typescript
import { buildParseExpensePrompt, ParseExpenseTool } from "./prompts/parse_expense.ts";
import { Anthropic } from "@anthropic/sdk";

const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
const { system, tools } = buildParseExpensePrompt({ todayWarsaw: "2026-05-18" });

const res = await client.messages.create({
  model: Deno.env.get("CLAUDE_MODEL_FAST")!,
  max_tokens: 1024,
  temperature: 0,
  system,
  tools,
  messages: [{ role: "user", content: userText }],
});

// Найти tool_use блок
const toolUse = res.content.find((c) => c.type === "tool_use");
if (!toolUse || toolUse.name !== "record_expenses") {
  // Не-expense сообщение, либо парсинг провалился
  return null;
}
const parsed = z.object({ expenses: z.array(ParsedExpenseRow) }).parse(toolUse.input);
```

---

## 2. parse_receipt.ts

Используется для распознавания чеков по фото. Модель: `CLAUDE_MODEL_VISION` (Sonnet 4.6).

```typescript
// supabase/functions/_shared/prompts/parse_receipt.ts
import { z } from "npm:zod@3.23.8";

export const ParseReceiptTool = {
  name: "record_receipt",
  description: "Parse a photo of a receipt and extract merchant, date, total, and itemized list.",
  input_schema: {
    type: "object",
    required: ["merchant", "receipt_date", "currency", "total", "items"],
    properties: {
      merchant: {
        type: "string",
        description: "Store/merchant name from the top of the receipt. If unreadable: 'Unknown'.",
      },
      receipt_date: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Date on the receipt in ISO format. If unreadable, use today.",
      },
      currency: {
        type: "string",
        enum: ["PLN", "EUR", "ALL", "USD"],
        description: "Currency. Polish receipts: PLN. Albanian: ALL. Etc.",
      },
      total: {
        type: "number",
        minimum: 0.01,
        description:
          "Final total amount (with tax). Look for 'SUMA', 'RAZEM', 'TOTAL', 'PLTNOSC', large bold number at bottom.",
      },
      items: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["name", "name_normalized_en", "amount"],
          properties: {
            name: {
              type: "string",
              description:
                "Item name as printed (in original language, often Polish abbreviations).",
            },
            name_normalized_en: {
              type: "string",
              description:
                "Short English description for semantic search. Lowercase, 2-4 words. E.g. 'milk dairy', 'bread bakery', 'coffee drink'.",
            },
            amount: {
              type: "number",
              description: "Line item total (price * quantity). Not unit price.",
            },
            qty: {
              type: "number",
              description: "Quantity if visible, default 1.",
            },
          },
        },
      },
      note: {
        type: "string",
        description: "Optional notes: low quality, blurry, missing parts, etc.",
      },
    },
  },
};

export function buildParseReceiptPrompt(params: {
  todayWarsaw: string;
}): {
  system: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[];
  tools: typeof ParseReceiptTool[];
} {
  const staticPart = `You are FinBot's receipt parser. Extract structured data from a receipt photo.

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

  const dynamicPart = `\n\nToday in Europe/Warsaw: ${params.todayWarsaw}.`;

  return {
    system: [
      { type: "text", text: staticPart, cache_control: { type: "ephemeral" } },
      { type: "text", text: dynamicPart },
    ],
    tools: [ParseReceiptTool],
  };
}

export const ParsedReceiptItem = z.object({
  name: z.string().min(1),
  name_normalized_en: z.string().min(1),
  amount: z.number().positive(),
  qty: z.number().positive().optional(),
});
export const ParsedReceipt = z.object({
  merchant: z.string(),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.enum(["PLN", "EUR", "ALL", "USD"]),
  total: z.number().positive(),
  items: z.array(ParsedReceiptItem).min(1),
  note: z.string().optional(),
});
export type ParsedReceipt = z.infer<typeof ParsedReceipt>;
```

### Использование

```typescript
const { system, tools } = buildParseReceiptPrompt({ todayWarsaw: "2026-05-18" });

const res = await client.messages.create({
  model: Deno.env.get("CLAUDE_MODEL_VISION")!,
  max_tokens: 4096,
  temperature: 0,
  system,
  tools,
  messages: [{
    role: "user",
    content: [
      { type: "image", source: { type: "url", url: signedReceiptUrl } },
      { type: "text", text: "Parse this receipt." },
    ],
  }],
});

const toolUse = res.content.find((c) => c.type === "tool_use");
const parsed = ParsedReceipt.parse(toolUse.input);
```

---

## 3. categorize_fallback.ts

Используется когда kNN не уверен (similarity < 0.85). Модель: `CLAUDE_MODEL_FAST`.

```typescript
// supabase/functions/_shared/prompts/categorize_fallback.ts
import { z } from "npm:zod@3.23.8";

export const CategorizeFallbackTool = {
  name: "assign_category",
  description: "Assign a category to an expense item, either an existing category or a new one.",
  input_schema: {
    type: "object",
    required: ["category_choice"],
    properties: {
      category_choice: {
        type: "object",
        oneOf: [
          {
            required: ["existing_id"],
            properties: {
              existing_id: {
                type: "string",
                description: "UUID of an existing category from the provided list.",
              },
            },
          },
          {
            required: ["new_category"],
            properties: {
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
        ],
      },
      reason: {
        type: "string",
        description: "One short sentence why this category fits.",
      },
    },
  },
};

export function buildCategorizeFallbackPrompt(params: {
  existingCategories: { id: string; name: string; description: string | null }[];
  similarExpenses: { name: string; category_id: string; similarity: number }[];
}): {
  system: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[];
  tools: typeof CategorizeFallbackTool[];
} {
  const staticPart =
    `You are FinBot's category fallback. The kNN classifier was unsure, so you decide.

Rules:
- Prefer existing categories from the provided list whenever any of them could reasonably fit.
- Only suggest a new category if NONE of the existing categories make sense. New categories should be rare. Reuse aggressively.
- "Other" is the fallback when nothing fits and a new category would be too specific.
- Always call assign_category tool. No plain text.`;

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
      { type: "text", text: staticPart, cache_control: { type: "ephemeral" } },
      { type: "text", text: dynamicPart },
    ],
    tools: [CategorizeFallbackTool],
  };
}
```

---

## 4. Prompt caching стратегия

- Статическая часть промпта (правила, инструкции) идёт первым system-блоком с
  `cache_control: { type: "ephemeral" }`.
- Динамическая часть (сегодняшняя дата, список категорий, контекст пользователя) идёт вторым
  system-блоком **без** cache_control.
- Tool definitions (`tools` array) тоже кешируются Anthropic'ом, отдельно прописывать cache_control
  не нужно.
- Первый вызов: `usage.cache_creation_input_tokens > 0`.
- Последующие вызовы (в течение 5 минут): `usage.cache_read_input_tokens > 0`.

Проверка в логах:

```typescript
log("info", "claude_usage", {
  model,
  input: res.usage.input_tokens,
  output: res.usage.output_tokens,
  cache_creation: res.usage.cache_creation_input_tokens ?? 0,
  cache_read: res.usage.cache_read_input_tokens ?? 0,
});
```

---

## 5. Расчёт стоимости

```typescript
const PRICES = {
  // $/MTok input, output, cache_write, cache_read
  "claude-haiku-4-5-20251001": [0.80, 4.00, 1.00, 0.08],
  "claude-sonnet-4-6": [3.00, 15.00, 3.75, 0.30],
};

export function costUsd(model: string, usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): number {
  const p = PRICES[model] ?? [3, 15, 3.75, 0.30]; // default to Sonnet pricing
  const inp = usage.input_tokens / 1_000_000;
  const out = usage.output_tokens / 1_000_000;
  const cw = (usage.cache_creation_input_tokens ?? 0) / 1_000_000;
  const cr = (usage.cache_read_input_tokens ?? 0) / 1_000_000;
  return inp * p[0] + out * p[1] + cw * p[2] + cr * p[3];
}
```

Цены могут устаревать. Если видишь существенное расхождение с фактическим биллингом - обнови
константы.

---

## 6. Тестирование промптов

`tests/prompts.test.ts`:

- Проверь что `buildParseExpensePrompt({ todayWarsaw: ... })` возвращает валидную структуру.
- Проверь что static часть стабильна (та же строка между вызовами с разной dynamic).
- Прогон через mock Anthropic: дан текст "купил кофе за 18 зл" -> tool_use вызвался с правильным
  `record_expenses` и единственным item.

Реальные интеграционные тесты промптов (с настоящим Anthropic API) гоняй **локально** через
`RUN_E2E=1`, не в CI (стоит денег).

---

Конец 06_PROMPTS.md.
