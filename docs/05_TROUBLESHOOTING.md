# 05 TROUBLESHOOTING, типичные ошибки и self-recovery

Этот документ описывает рутинные проблемы и как их решить **без обращения к пользователю**. Если
проблемы из этого списка нет, см. CLAUDE.md раздел "Когда останавливаться".

## Категории

- A. Supabase CLI.
- B. Edge Functions runtime.
- C. Postgres / миграции.
- D. Telegram.
- E. Anthropic / Groq.
- F. GitHub Actions.
- G. Deno / npm-imports.
- H. Webapp / GitHub Pages.
- I. Тесты.

---

## A. Supabase CLI

### A1. `supabase link` 401 unauthorized

Причина: SUPABASE_ACCESS_TOKEN неверный, истёк, или не имеет прав на этот проект.

Действия:

1. `curl -fsS "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" | jq`.
2. Если 401, ключ неверный. Останавливайся, проси пользователя дать новый.
3. Если 404, неверный project ref. То же самое.

### A2. `supabase db push` упал на дубле миграций

Причина: миграция применилась наполовину, или конфликт типов.

Действия:

1. `supabase migration list` - смотри, что применено.
2. Если упало на `create type`, оборачивай в
   `do $$ begin ... exception when duplicate_object then null; end$$;`.
3. Все `create table` уже идут с `if not exists`, проверь что не забыл.
4. Если не помогло и **бот ещё не в реальном использовании**: `supabase db reset --linked` ->
   повторный push.

### A3. `supabase functions deploy` "Function size exceeds limit" (20MB)

Причина: импортирован npm-пакет с большой нативной частью (`sharp`, `heic-convert`).

Действия:

1. Проверь, что `sharp` импортируешь через imports map (`import sharp from "sharp"`), не как полный
   package.
2. Если sharp всё равно слишком большой - альтернативы: `npm:@jsquash/jpeg`, `npm:photon` (WASM),
   либо `npm:imagescript`. Меняй везде где используется.
3. Heic-convert: если жирный, есть `npm:libheif-js` который меньше.

### A4. `supabase functions deploy` "ENV var not set"

Причина: `supabase secrets set --env-file .env` не запущено, или env-file сломан.

Действия:

1. `supabase secrets list` - смотри, что есть.
2. Если пусто или отсутствует ключевой VAR: `supabase secrets set --env-file .env`.
3. Передеплой: `supabase functions deploy`.

### A5. `Supabase.ai.Session("gte-small")` "not available"

Эта runtime-feature должна быть на всех Supabase Edge Functions, но если упало:

1. Логи: `supabase functions logs tg-webhook --tail` и смотри точную ошибку.
2. Если "Session is not a function": попробуй явный импорт `import { Session } from "@supabase/ai"`
   (если такой есть в версии runtime). Это не задокументировано официально, но иногда работает.
3. Fallback на API embeddings через `npm:@xenova/transformers`:
   ```typescript
   import { pipeline } from "npm:@xenova/transformers@2.17.2";
   const embedder = await pipeline("feature-extraction", "Supabase/gte-small");
   const result = await embedder(text, { pooling: "mean", normalize: true });
   ```
   Это медленнее (cold start добавит секунды), но работает.
4. **Если приходится переходить на xenova - запиши в STATE.md notes и иди дальше.** Это не блокер.

---

## B. Edge Functions runtime

### B1. Cold start > 5 секунд на простом запросе

Причина: тяжёлые импорты (`sharp`, `heic-convert`, `@anthropic-ai/sdk` с зависимостями).

Действия:

1. Не импортируй sharp/heic в функциях, где они не нужны (например, `api-stats/`).
2. Используй динамический `await import(...)` в ветке кода, которая редко срабатывает:
   ```typescript
   if (mime === "image/heic") {
     const heic = await import("heic-convert");
     // ...
   }
   ```

### B2. "Out of memory" в Edge Function

Лимит ~150 MB. Большие фото после decode могут превысить.

Действия:

1. Сжимай сразу после decode через sharp с `.resize(1920)` и `.jpeg({ quality: 85 })`.
2. Не держи raw buffer в памяти после upload в Storage.

### B3. Edge Function 502/504

Причина: timeout 150 сек, или внешний API завис.

Действия:

1. `supabase functions logs <fn> --tail`.
2. Оборачивай все внешние вызовы в `Promise.race` с timeout 60 сек.
3. При timeout - запиши в pending_retry, ответь пользователю "🐢 Обрабатываю...".

### B4. CORS блокирует webapp

Если в браузере консоль показывает CORS error при запросе к Edge Function от webapp:

1. Каждая `api-*` функция должна возвращать `Access-Control-Allow-Origin` заголовок.
2. Шаблон:
   ```typescript
   const corsHeaders = {
     "Access-Control-Allow-Origin": "https://web.telegram.org",
     "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
     "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Telegram-Init-Data",
     "Vary": "Origin",
   };
   if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
   ```
3. Для multiple origins (web.telegram.org + github.io), смотри `Origin` заголовок и эхо подходящий:
   ```typescript
   const allowed = ["https://web.telegram.org", `https://${GH_USER}.github.io`];
   const origin = req.headers.get("Origin");
   if (origin && allowed.includes(origin)) corsHeaders["Access-Control-Allow-Origin"] = origin;
   ```

---

## C. Postgres / миграции

### C1. `extension "vector" is not available`

Причина: pgvector не включён в проекте.

Действия:

1. Через CLI: `psql "$SUPABASE_DB_URL" -c "create extension if not exists vector"`.
2. Или Dashboard -> Database -> Extensions -> найти `vector`, нажать Enable.
3. Если в whitelist Supabase, должно сразу заработать.

### C2. `cron.schedule` "function does not exist"

Причина: pg_cron не включён.

Действия:

1. `psql ... -c "create extension if not exists pg_cron"`.
2. Затем `select cron.schedule(...)`.

### C3. `pgvector hnsw index failed`

Причина: версия pgvector < 0.5.

Действия:

1. `select extversion from pg_extension where extname = 'vector'`.
2. Если < 0.5, fallback на ivfflat:
   ```sql
   create index idx_expenses_embedding on expenses using ivfflat (embedding vector_cosine_ops) with (lists = 100);
   ```
3. Если получилось обновить pgvector через Supabase Dashboard - сделай это, и оставь hnsw.

### C4. `match_expenses` возвращает пусто всегда

Действия:

1. `select count(*) from expenses where embedding is not null` - есть ли данные?
2. Снизь threshold до 0.5 для отладки.
3. Проверь что embedder возвращает реально 384-длинный массив (он float32, не string).
4. Проверь что vector cast: `query_embedding::vector(384)`.

### C5. Audit trigger не пишет в expense_audit

Проверь:

1. `select * from pg_trigger where tgname = 'trg_expense_audit'`. Должна быть строка.
2. Если нет - миграция 0004 не применилась. `supabase db push`.
3. Если есть, но не пишет - проверь что в функции `log_expense_audit()` нет `return null`, должно
   быть `return new`.

---

## D. Telegram

### D1. `getMe` 401

TELEGRAM_BOT_TOKEN неверный. Останавливайся.

### D2. `setWebhook` ok, сообщения не приходят

Действия:

1. `curl https://api.telegram.org/bot$TOKEN/getWebhookInfo | jq`.
2. Смотри `last_error_message`, `last_error_date`, `pending_update_count`.
3. Самое частое: `Wrong response from the webhook` - твоя функция возвращает не 200. Смотри Supabase
   logs.
4. Если URL правильный и pending > 0 - функция падает. Логи.
5. После фикса: `setWebhook` повторно с `drop_pending_updates: true` чтобы выкинуть очередь
   сломанных.

### D3. `sendMessage` 400 "message text is empty"

В коде возможен путь, где `reply()` вызывается с пустой строкой. Защита:

```typescript
const text = computeReply();
await ctx.reply(text || "...");
```

### D4. `sendMessage` 403 "Forbidden: bot was blocked by the user"

Пользователь заблокировал бота. Просто залогируй, `family_members.active=false` для этого юзера
через update.

### D5. File download 400 "file is too big"

Telegram лимит 20 MB для bots. Voice/photo обычно ок. Для documents возможно. Реджектай заранее в
`update.message.document.file_size`.

### D6. Webhook отвечает 200, но через минуту Telegram повторяет тот же update

Причина: Telegram считает update'ы потерянными если бот не ответил 200 в пределах timeout (~60 сек).

Решение: всегда отвечай 200 быстро. Если обработка длинная - сначала reply Telegram'у 200, потом
обрабатывай. Но Edge Function не может ответить и продолжить работу - используй
`EdgeRuntime.waitUntil(asyncWork)`:

```typescript
EdgeRuntime.waitUntil((async () => {
  await heavyProcessing();
})());
return new Response("ok", { status: 200 });
```

---

## E. Anthropic / Groq

### E1. Anthropic 429 rate limit

Действия:

1. `Retry-After` header даёт сколько ждать.
2. Записать payload в pending_retry с `next_retry_at = now() + interval`.
3. Reply пользователю: "🐢 Загружено, секунду...".

### E2. Anthropic 401

Ключ неверный. Останавливайся.

### E3. Anthropic 400 "model not found"

Действия:

1. Список доступных моделей:
   ```bash
   curl https://api.anthropic.com/v1/models \
     -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "anthropic-version: 2023-06-01" | jq '.data[].id'
   ```
2. Найди подходящий снапшот, обнови `CLAUDE_MODEL_FAST` и `CLAUDE_MODEL_VISION` в `.env`.
3. `supabase secrets set --env-file .env`.
4. Передеплой.

### E4. Anthropic ответ без `tool_use`

Иногда Claude игнорирует tool и пишет текстом. Действия:

1. `temperature=0` обязательно.
2. Усиль prompt: "You MUST call the provided tool. Do not respond with plain text or explanations.".
3. В коде: если ответ без tool_use, попробуй извлечь JSON из текстового блока (он часто там есть).
4. Логируй такие случаи в `anthropic_misformat_log` (опциональная таблица) для анализа.

### E5. Anthropic prompt caching не активируется

Проверь:

1. `cache_control: { type: "ephemeral" }` стоит на правильных блоках (статическая часть system или
   tools).
2. Минимум 1024 токенов в cached блоке (для Haiku 4.5 / Sonnet 4.6 минимум).
3. В response `usage.cache_creation_input_tokens > 0` на первом вызове, потом
   `cache_read_input_tokens > 0`.
4. Если все три условия выполнены, но не работает - возможно баг на стороне Anthropic, продолжай без
   caching (просто дороже).

### E6. Groq 429

Аналогично E1.

### E7. Groq 413 "request too large"

Voice > 25 MB. У Telegram свой лимит < 5 MB для voice, не должно случиться. Если случилось - reject
в коде.

### E8. Groq `detected_language` не в whitelist

Reply пользователю: "Не понял язык: <lang>. Поддерживаются: ru, uk, pl, en.". Не записывай.

---

## F. GitHub Actions

### F1. Workflow не стартует на push

Действия:

1. `gh workflow list`.
2. Проверь файл расположен в `.github/workflows/test.yml`.
3. Синтаксис YAML: `python -c "import yaml; yaml.safe_load(open('.github/workflows/test.yml'))"`.

### F2. Deploy workflow fails на `supabase link`

Действия:

1. `gh secret list` - проверь что `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`,
   `SUPABASE_DB_PASSWORD` есть.
2. Если нет - `gh secret set <NAME> --body "<value>"`.

### F3. Auto-revert PR не создаётся

Действия:

1. `permissions:` блок в `deploy.yml`:
   ```yaml
   permissions:
     contents: write
     pages: write
     id-token: write
     actions: write
   ```
2. Включить write через API:
   ```bash
   gh api -X PUT "/repos/$GITHUB_REPO/actions/permissions/workflow" \
     -f default_workflow_permissions=write \
     -F can_approve_pull_request_reviews=false
   ```

### F4. GitHub Pages не включён

`peaceiris/actions-gh-pages` сам создаёт ветку `gh-pages` и пушит туда, но Pages должен быть включён
в settings:

```bash
gh api -X POST "/repos/$GITHUB_REPO/pages" \
  -f source[branch]=gh-pages -f source[path]=/ || echo "already enabled or no permission"
```

Если не работает через API - открыть Settings -> Pages в UI и выбрать source=gh-pages branch. **Это
можно сделать через `gh` CLI**, не требуется участие пользователя.

### F5. Branch protection блокирует Claude Code от мержа в main

Действия:

1. `gh api -X PUT "/repos/$GITHUB_REPO/branches/main/protection" -f enforce_admins=false ...`.
2. Если ты owner репо и `enforce_admins=false`, ты можешь обходить protection через admin-флаг при
   мерже PR.

---

## G. Deno / npm-imports

### G1. `deno cache` падает на npm-пакете

Причина: npm-пакет несовместим с Deno (native deps, ESM-CJS interop).

Действия:

1. Проверь `--node-modules-dir` flag.
2. Альтернативный пакет с чистым ESM.
3. Для нативных модулей (`sharp`): Supabase Edge Functions поддерживают их через свой bundler,
   локально может не работать. Запускай `supabase functions serve` вместо чистого `deno run`.

### G2. `deno test` падает с "Module not found"

Импорт в коде использует имя из map, а тест использует относительный путь, либо наоборот.
Стандартизуй: в коде через map, в тестах относительные пути работают, имена из map тоже.

### G3. TypeScript: `cannot find name "Supabase"`

`Supabase.ai.Session` это runtime-global Edge Functions. Локально его нет. Добавь декларацию типов:

```typescript
// supabase/functions/_shared/types_global.d.ts
declare const Supabase: {
  ai: {
    Session: new (model: string) => {
      run(input: string, opts?: { mean_pool?: boolean; normalize?: boolean }): Promise<number[]>;
    };
  };
};
```

И в коде `// @ts-ignore` или просто оставить - типы подхватятся.

---

## H. Webapp / GitHub Pages

### H1. Mini App белый экран

Действия:

1. Открой в Chrome DevTools (через Telegram WebApp debug, или просто открой URL без Telegram - там
   должна быть заглушка).
2. Console errors.
3. Самое частое: запрос на api-* идёт без header `Authorization`, и сервер возвращает 401, fetch
   fail.
4. Проверь, что Telegram SDK загрузился (script tag первый), затем `app.js`.

### H2. Mini App "не загружается" в Telegram

В мобильном Telegram сложно отладить. Действия:

1. Открой через WebApp tester: https://t.me/telegram_webapp_bot или Telegram Web (web.telegram.org).
2. Через DevTools Network проверь, что initData приходит и совпадает с computed HMAC.

### H3. Chart.js не рендерится

Действия:

1. Версия Chart.js через CDN с фиксированным числом (см. `docs/03_CONVENTIONS.md` раздел 13).
2. Canvas element должен быть в DOM до вызова `new Chart(...)`.
3. Размер canvas: установи в CSS, иначе Chart.js не рисует.

---

## I. Тесты

### I1. Coverage < 80% после M18

Действия:

1. `deno coverage cov --detailed` показывает какие строки не покрыты.
2. Добавь тесты на эти ветки (особенно error paths, рекомендую edge cases).
3. Если код реально dead - удали.

### I2. Тест пассит локально, фейлит в CI

Причины:

1. Зависимости от ENV переменных (тест читает Deno.env, в CI её нет).
2. Тайминги (тест зависит от `Date.now()`, моки fake-time нужны).
3. Сеть (тест случайно дёргает реальный API).

Действия:

1. Перед каждым тестом восстанови env через `Deno.env.set` или используй DI.
2. Используй `@std/testing/time` для контроля времени:
   ```typescript
   import { FakeTime } from "jsr:@std/testing/time";
   const t = new FakeTime("2026-02-29T12:00:00Z");
   // ... тест
   t.restore();
   ```
3. `--check` опция Deno test или mock fetch явно.

### I3. Flaky тест (раз пассит, раз фейлит)

Чаще всего race condition или зависимость от порядка.

Действия:

1. `--shuffle` опция Deno test - помогает найти dependency между тестами.
2. Тесты не должны делить state. Каждый тест создаёт свой mockSupabase().
3. Если правда random/timing - используй
   `Deno.test({ name, sanitizeOps: false, sanitizeResources: false, fn })` (не идеально, но как
   костыль).

---

## Что НЕ описано тут

Если что-то совсем новое, не из списка, и `docs/10_GLOSSARY.md` тоже не помог - см. CLAUDE.md "Когда
останавливаться". Кратко: 3 попытки решить -> stop & ask.

---

Конец 05_TROUBLESHOOTING.md.
