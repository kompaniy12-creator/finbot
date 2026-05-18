# 03 CONVENTIONS, стиль кода и паттерны

## 1. TypeScript

### 1.1 Strict mode

Везде. В `deno.json`:

```json
"compilerOptions": {
  "strict": true,
  "noImplicitAny": true,
  "noImplicitThis": true,
  "strictNullChecks": true,
  "strictFunctionTypes": true,
  "noUnusedLocals": true,
  "noUnusedParameters": false,
  "noFallthroughCasesInSwitch": true,
  "exactOptionalPropertyTypes": false,
  "noUncheckedIndexedAccess": true
}
```

`noUnusedParameters: false` потому что часто в обработчиках grammy есть неиспользуемый второй
параметр.

`exactOptionalPropertyTypes: false` для совместимости с popular npm-пакетами, которые часто не
строго отделяют `undefined` от `?`.

### 1.2 Nullability

- Используй `T | null` для отсутствия значения из БД.
- `T | undefined` для optional-параметров функций.
- Не смешивай.

```typescript
// good
function findMember(id: number): Promise<FamilyMember | null> { ... }

// good
function send(opts: { caption?: string }) { ... }

// bad
function findMember(id: number): Promise<FamilyMember | null | undefined> { ... }
```

### 1.3 Zod schemas

Используются на ВСЕХ границах:

- Input от Telegram (структура Update).
- Output Claude (tool_use input).
- Output API endpoints.
- Парсинг ENV переменных.
- БД ряды (опционально, но рекомендуется).

```typescript
// _shared/types.ts
import { z } from "npm:zod@3.23.8";

export const ParsedExpense = z.object({
  name: z.string().min(1).max(200),
  name_normalized_en: z.string().min(1).max(200),
  amount: z.number().positive(),
  currency: z.enum(["PLN", "EUR", "ALL", "USD"]),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().optional(),
});
export type ParsedExpense = z.infer<typeof ParsedExpense>;
```

Парсинг ENV в начале каждой функции:

```typescript
const env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(40),
  ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-"),
  ...
}).parse({
  TELEGRAM_BOT_TOKEN: Deno.env.get("TELEGRAM_BOT_TOKEN"),
  ANTHROPIC_API_KEY: Deno.env.get("ANTHROPIC_API_KEY"),
  ...
});
```

## 2. Структура Edge Function

Каждая Edge Function имеет одну точку входа `index.ts` и не больше 250-300 строк. Если функция
растёт - выноси утилиты в `_shared/`.

Шаблон:

```typescript
// supabase/functions/tg-webhook/index.ts
import { z } from "npm:zod@3.23.8";
import { adminClient } from "../_shared/supabase.ts";
import { authorize } from "../_shared/auth.ts";

const env = z.object({
  TELEGRAM_BOT_TOKEN: z.string(),
}).parse({
  TELEGRAM_BOT_TOKEN: Deno.env.get("TELEGRAM_BOT_TOKEN"),
});

Deno.serve(async (req: Request) => {
  // 1. Webhook secret check
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== env.TELEGRAM_BOT_TOKEN) {
    return new Response("forbidden", { status: 401 });
  }

  // 2. Parse
  const update = await req.json();

  // 3. Auth + idempotency
  const sb = adminClient();
  // ...

  // 4. Route
  // ...

  return new Response("ok", { status: 200 });
});
```

## 3. Импорты

- Сторонние: только через imports map в `deno.json` (`import { X } from "grammy"`).
- Внутренние: относительные пути (`import { ... } from "../_shared/auth.ts"`).
- Никаких URL-импортов в коде (`https://deno.land/x/...`).

## 4. Логирование

Structured JSON. Всё через `console.log(JSON.stringify({ ... }))`.

```typescript
function log(
  level: "info" | "warn" | "error",
  event: string,
  data: Record<string, unknown> = {},
) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  }));
}

// Usage
log("info", "expense_inserted", {
  expense_id: e.id,
  amount: e.amount_pln,
  family_member_id: e.family_member_id,
  source: e.source,
});
```

Не логируй секреты. Маскируй: `token.slice(0, 4) + "***" + token.slice(-4)`.

## 5. Ошибки

- Используй кастомные классы ошибок для разных типов:

```typescript
export class BudgetExceededError extends Error {
  constructor(public cost: number, public limit: number) {
    super(`Budget exceeded: $${cost} > $${limit}`);
    this.name = "BudgetExceededError";
  }
}
export class ExternalApiError extends Error {
  constructor(public service: string, public statusCode: number, message: string) {
    super(`${service} returned ${statusCode}: ${message}`);
    this.name = "ExternalApiError";
  }
}
```

- На верхнем уровне Edge Function: catch all, log, реплай юзеру дружелюбное сообщение, не падай в
  500 если можешь reply'нуть в Telegram.

## 6. Naming

- Файлы: `snake_case.ts` для `_shared/*` и `tests/*`. Папки функций: `kebab-case` (`tg-webhook`,
  `cron-recurring`).
- Функции: `camelCase`.
- Типы и классы: `PascalCase`.
- Константы: `SCREAMING_SNAKE_CASE` (только для true-const, не для просто значений).
- БД: `snake_case` (column, table). Совпадает с Postgres конвенцией.

## 7. Async

- Используй `async/await`, не голые промисы.
- Не глотай ошибки: `try { ... } catch { /* nothing */ }` запрещено.
- `Promise.all` для параллельных запросов где имеет смысл (несколько RPC к Supabase).

## 8. Telegram (grammy)

Не используй большие сцены grammy. У нас простой бот с одним webhook handler. Стиль:

```typescript
import { Bot, webhookCallback } from "grammy";
const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

bot.command("start", async (ctx) => {
  await ctx.reply("Привет, я FinBot.");
});

bot.on("message:text", async (ctx) => {
  // pipeline
});

bot.on("callback_query:data", async (ctx) => {
  // routing by ctx.callbackQuery.data
});

const handle = webhookCallback(bot, "std/http");

Deno.serve(async (req) => {
  // secret check
  return await handle(req);
});
```

## 9. Supabase

- Все запросы через service role key (`SUPABASE_SERVICE_ROLE_KEY`), RLS отключён.
- Не дави в одну функцию слишком много RPC: 5-10 запросов в одном webhook ок, 50+ это знак что нужно
  SQL-функция в `_shared/sql/`.
- Используй `select(...)` явный список колонок, не `select("*")` где можно (экономия трафика).
- Для bulk insert: `.insert([row1, row2, ...])` одним вызовом.

## 10. Тесты

См. `docs/04_TESTING.md`.

## 11. Коммиты

Conventional commits (precedent в SPEC §16):

- `chore: ...` мелочи, инфра.
- `feat: ...` фича.
- `feat(<scope>): ...` фича с областью.
- `fix: ...` багфикс.
- `docs: ...` документация.
- `test: ...` только тесты.

Точные сообщения для milestone-коммитов см. в SPEC §16 (`feat(db): schema with audit` и т.д.) и
`docs/02_PLAYBOOK.md`.

В теле коммита (опционально) - что сделано детальнее. Не пиши секреты.

## 12. Никаких em-dash

Жёсткое правило от пользователя. В коде, комментариях, README, коммитах, везде. Используй:

- Запятую `,`.
- Скобки `()`.
- Двоеточие `:`.
- Точку с запятой `;`.
- Дефис `-` (только короткий, не ` - `).

Включи в `deno.json` или ручной grep перед коммитом:

```bash
git diff --cached | grep -P '[\x{2014}]' && echo "em-dash found, fix" && exit 1
```

Лучше: pre-commit hook в `.git/hooks/pre-commit` (не коммитится, ставится сам Claude Code в M1 на
`chmod +x`).

## 13. Imports в webapp/

Webapp на vanilla JS + Chart.js через CDN. Никаких bundle. Никаких ESM импортов из `node_modules`.

```html
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<script src="./tg-webapp.js"></script>
<script src="./app.js"></script>
```

Пиннуй версию Chart.js, не используй `latest`.

## 14. Webapp без localStorage

`localStorage` и `sessionStorage` запрещены (SPEC §0 правило 9 и Telegram WebApp limits). Состояние
держим:

- В `window`-приклеенном объекте `window.app = { state: {}, ... }`.
- При необходимости долгого состояния, оно идёт на бэк (например, фильтры можно держать в URL hash).

## 15. CSS

- Использовать Telegram CSS variables: `--tg-theme-bg-color`, `--tg-theme-text-color`,
  `--tg-theme-button-color`, `--tg-theme-button-text-color`, `--tg-theme-hint-color`,
  `--tg-theme-link-color`.
- Свои переменные для отступов/шрифтов в `:root`.
- Mobile-first.
- Никаких внешних CSS-фреймворков.

---

Конец 03_CONVENTIONS.md.
