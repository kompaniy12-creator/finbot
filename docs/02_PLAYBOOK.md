# 02 PLAYBOOK, пошаговый план реализации M1...M18

Каждый milestone тут расписан в порядке: подготовка, файлы которые создаёшь, ключевые команды,
проверка acceptance criteria, коммит. Команды и acceptance criteria из SPEC §16 это base, тут
детализация и порядок.

После каждого milestone:

1. Локально гоняешь `deno task test && deno task fmt && deno task lint && deno task check`.
2. Если зелёные - коммитишь сообщением из SPEC §16.
3. После M16 - через feature branch и PR. До M16 - сразу в main.
4. Обновляешь `docs/STATE.md`.
5. Идёшь к следующему milestone.

## M1: Skeleton + Supabase setup

### Шаги

1. `cd $PROJECT_DIR && git init && git branch -m main`.
2. Создать структуру каталогов из SPEC §10 (все папки, можно пустыми).
3. `gh repo create $GITHUB_REPO --private --source=. --remote=origin` (репо в GitHub, без push
   пока).
4. Создать `.gitignore`:
   ```
   .env
   .env.local
   *.bak
   .DS_Store
   /coverage/
   /supabase/.temp/
   /supabase/.branches/
   /node_modules/
   /dist/
   /tmp/
   *.log
   /backups/
   ```
5. Создать `deno.json` точно по SPEC §11.2.
6. Создать `.env.example` точно по SPEC §11.1.
7. Создать `Makefile` точно по SPEC §13.5.
8. Создать `README.md` с заголовком и ссылкой на SPEC.
9. Создать `BACKLOG.md` с содержимым SPEC §22.
10. `supabase init` (создаёт `supabase/config.toml`).
11. `supabase login --token "$SUPABASE_ACCESS_TOKEN"`.
12. `supabase link --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"`.
13. Создать `supabase/functions/_shared/types.ts` с базовыми Zod-схемами:
    - `TelegramUpdate` (с `message`, `edited_message`, `callback_query`).
    - `FamilyMember`.
    - `Expense`, `Receipt`, `Category` (Postgres-shaped).
    - `ParsedExpense` (output Claude).
    - `ParsedReceipt`.
14. Создать `supabase/functions/_shared/supabase.ts`:
    ```typescript
    import { createClient } from "npm:@supabase/supabase-js@2.45.0";
    export function adminClient() {
      const url = Deno.env.get("SUPABASE_URL")!;
      const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      return createClient(url, key, { auth: { persistSession: false } });
    }
    ```
15. Создать `supabase/functions/tg-webhook/index.ts` минимальную реализацию с grammy:
    - `Deno.serve` напрямую.
    - Проверка query-параметра `secret == TELEGRAM_BOT_TOKEN`.
    - Команда `/start` -> reply "FinBot v1, авторизация ещё не настроена."
16. Тест `tests/skeleton.test.ts` (один умный тест на webhook secret check + один на /start mock).
17. Push secrets: `supabase secrets set --env-file .env`.
18. Локальная проверка: `supabase functions serve tg-webhook`, потом curl на localhost - должна
    вернуться 200/401.
19. **Не деплоим** функцию до M2 (схема ещё не залита).

### Acceptance

- [x] Структура из SPEC §10 на диске.
- [x] `deno task check` зелёный (типы).
- [x] `deno task test` зелёный.
- [x] `gh repo view` показывает приватный репо.
- [x] `supabase link` отрабатывает.

### Commit

`git add . && git commit -m "chore: initial skeleton"`. Push в main.

---

## M2: Database schema

### Шаги

1. Создать миграции `supabase/migrations/` строго по SPEC §4.1-§4.6, шесть файлов:
   - `0001_extensions.sql`.
   - `0002_tables.sql`.
   - `0003_indexes.sql`.
   - `0004_functions.sql`.
   - `0005_cron.sql` (но **все `cron.schedule(...)` закомментировать** до M14, чтобы не дёргать ещё
     не существующие Edge Functions). В этой миграции же добавить установку GUC:
     ```sql
     do $$
     begin
       perform set_config('app.functions_url', 'https://' || current_setting('app.supabase_project_ref', true) || '.supabase.co/functions/v1', false);
     end$$;
     ```
     Нет, GUC через `alter database` нельзя в миграции (Supabase managed). Решение: оставить
     настройку через `psql` команду в скрипте `scripts/configure_cron.sh`, который Claude Code
     запустит на M14.
   - `0006_security.sql`.
2. Создать `supabase/functions/_shared/seed.ts` для seed 17 категорий (SPEC §4.7):
   - Для каждой категории сгенерировать `embedding` через `Supabase.ai.Session("gte-small")` на
     английском описании.
   - Insert в `categories` (с `is_fallback=true` для "Other").
   - Дополнительно: insert family_members из `docs/STATE.md`.
3. Создать миграцию `0007_seed.sql` которая вызывает функцию `seed_initial_data()` (либо seed делать
   через Edge Function `cron-seed` одноразово, но проще через SQL).

   На практике seed через SQL для категорий: 16 строк insert на нормальные категории + 1 на "Other".
   Embeddings генерируем потом через Edge Function `cron-seed` (вызывается один раз вручную) либо
   инлайн в первом инвоке `tg-webhook` при первом сообщении (lazy seed).

   Чище: создать одноразовую функцию `setup-once/index.ts` которая вызывается curl'ом, и она:
   - Проверяет, что категорий нет.
   - Создаёт 17 категорий с embedding через Supabase.ai.
   - Создаёт family_members.
   - Возвращает 200 с отчётом.

   Этот вариант лучше, его и реализуй.

4. `supabase db push` локально, потом смотришь логи. Если ошибка - чинишь миграцию (важно:
   идемпотентные `if not exists`).
5. Тест `tests/audit_trigger.test.ts`: insert expense -> select из expense_audit, проверка что
   строка появилась.
6. Деплой `setup-once` функции, вызов её curl'ом:
   ```bash
   curl -fsS -X POST "https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/setup-once" \
     -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
     -H "x-setup-secret: $CRON_SECRET"
   ```
7. Проверка: `psql $SUPABASE_DB_URL -c "select count(*) from categories"` должно вернуть 17.
   `select count(*) from family_members` должно вернуть число членов семьи.

### Acceptance

- [x] Все 6 миграций применены.
- [x] 17 категорий с непустыми embeddings.
- [x] family_members с одним admin.
- [x] Audit trigger пишет на insert/update expenses.
- [x] cron schedules **закомментированы**, бот не задеплоен ещё значит cron не должен дёргать пустые
      URL.
- [x] Storage bucket `receipts` создан.

### Commit

`git add . && git commit -m "feat(db): schema with audit"`. Push в main.

---

## M3: Idempotency + retry queue

### Шаги

1. В `tg-webhook/index.ts` добавить функцию `dedupe(messageId, familyMemberId)`:
   - `insert into message_log (...) values (...) on conflict do nothing returning *`.
   - Если returning пустой - сообщение уже видели, выходим.
2. Создать `supabase/functions/cron-retry-failed/index.ts`:
   - Cron-auth check (Bearer CRON_SECRET).
   - `select * from pending_retry where attempt_count < 5 and next_retry_at <= now() limit 50`.
   - Для каждой записи: попытка повторной обработки в зависимости от `payload_type`
     (text/voice/photo).
   - При успехе: delete из pending_retry.
   - При ошибке:
     `update pending_retry set attempt_count += 1, next_retry_at = now() + interval, last_error = ...`.
   - Backoff: 1м, 5м, 15м, 60м, 300м (массив).
3. `_shared/retry.ts` с функцией `enqueueRetry(payload, type, error)`.
4. Тесты:
   - `tests/idempotency.test.ts`: те же телеграм-update'ы дважды -> ожидание одной строки в
     expenses.
   - `tests/idempotency_edited.test.ts`: длинный текст -> короткий edit -> длинный re-edit.
     Hard-delete семантика + audit log правильно отрабатывает.
   - `tests/retry_queue.test.ts`: эмуляция fail -> enqueue -> retry -> success.

### Acceptance

- [x] Дубликат update'а не создаёт второй expense.
- [x] Edited message работает корректно (см. SPEC §6.5).
- [x] pending_retry exponential backoff правильный.

### Commit

`feat(reliability): idempotency and retry queue`.

---

## M4: Auth + базовые команды

### Шаги

1. Создать `_shared/auth.ts`:
   ```typescript
   export async function authorize(
     telegramId: number,
     sb: SupabaseClient,
   ): Promise<FamilyMember | null> {
     const { data } = await sb.from("family_members")
       .select("*").eq("telegram_id", telegramId).eq("active", true).single();
     return data ?? null;
   }
   ```
2. В `tg-webhook/index.ts`: после dedupe -> `authorize()`. Если null -> отправить notify админу
   через `bot.api.sendMessage(adminId, ...)`, юзеру вежливый отказ.
3. Создать handlers:
   - `/start`: приветствие, ссылка на /help.
   - `/help`: список команд.
   - `/categories`: 17 категорий списком.
   - `/dashboard`: ссылка на Mini App (URL из env).
   - `/health` (admin only): краткий статус (last_seen, версия, число expenses за сегодня).
   - `/audit <expense_id>` (admin only): последние 5 записей из expense_audit.
4. Тесты:
   - `tests/auth.test.ts`: чужой telegram_id -> отказ + notify mock.
   - `tests/commands.test.ts`: каждая команда возвращает что-то осмысленное.

### Acceptance

- [x] Whitelist работает.
- [x] Все 6 команд отрабатывают.
- [x] Unauthorized отправляет alert админу.

### Commit

`feat(auth): authorization and base commands`.

---

## M5: Claude + budget tracking

### Шаги

1. `_shared/claude.ts`:
   - Функция `callClaude(opts: { model, system, tools, messages, familyMemberId })`.
   - Pre-check budget: запросить
     `select coalesce(sum(cost_usd),0) from anthropic_usage where date = current_date and family_member_id = $1`
     (per-user) и без фильтра (global).
   - Если per-user > soft cap: продолжаем, но логируем warning.
   - Если global > hard cap: бросаем `BudgetExceededError`.
   - Вызов Anthropic SDK с tool_use + temperature=0 + prompt_caching на статической части.
   - После вызова: посчитать стоимость из `usage` поля ответа, insert в anthropic_usage.
2. `_shared/budget.ts`:
   - `getCosts(familyMemberId)` -> { user, global }.
   - `enforceBudget()` -> throws or returns.
3. Тесты:
   - `tests/budget_per_user.test.ts`: симуляция: один user превысил per-user, другой ок.
   - `tests/budget_global.test.ts`: global hit -> hard stop.
   - `tests/claude_cost_calc.test.ts`: фикстура ответа Claude -> правильная сумма в долларах.

### Цены моделей (для расчёта стоимости)

Цены меняются. На момент написания SPEC (Jan 2026):

- Claude Haiku 4.5: input $0.80/MTok, output $4.00/MTok, cache write $1.00/MTok, cache read
  $0.08/MTok.
- Claude Sonnet 4.6: input $3.00/MTok, output $15.00/MTok, cache write $3.75/MTok, cache read
  $0.30/MTok.

Положи цены в `_shared/claude.ts` как константы. **Если** Anthropic поменяет цены **и** ты узнаешь
об этом из ошибки или сравнения с биллингом, **обнови константы**, но автономно не лезь в api
прайсинга, просто работай с тем что есть.

### Acceptance

- [x] Тесты budget зелёные.
- [x] Cost трекинг работает.
- [x] Prompt caching активен (видно в response usage).

### Commit

`feat(ai): claude with two-tier budget`.

---

## M6: Embedder + categorizer + retraining

### Шаги

1. `_shared/embedder.ts`:
   ```typescript
   // @ts-ignore Supabase.ai is runtime global
   const session = new Supabase.ai.Session("gte-small");
   export async function embed(text: string): Promise<number[]> {
     return await session.run(text, { mean_pool: true, normalize: true });
   }
   ```
2. `_shared/categorizer.ts`:
   - Pipeline:
     - Claude парсит и нормализует на английский (`name_normalized_en`).
     - `embed(name_normalized_en)`.
     - RPC `match_expenses(emb, family_id, 0.85, 5)`.
     - Если есть хит с similarity > 0.85 - используем топ-1 category_id.
     - Иначе: Claude fallback с топ-30 категориями + топ-5 похожими expenses.
     - Если Claude предлагает новую категорию (не из топ-30, новый name): insert с embedding на
       английском описании.
3. `cron-retraining/index.ts`:
   - Cron-auth check.
   - Для каждой `category_id` в expenses where corrected_by_user=true:
     - Если >= 3 corrected examples за всё время: пересчитать `categories.embedding` как
       mean(embeddings).
     - Update `centroid_updated_at`.
4. Тесты:
   - `tests/categorizer_knn.test.ts`: фикстуры с "кофе", "espresso", "молоко" -> ожидаемые
     категории.
   - `tests/categorizer_fallback.test.ts`: неизвестный товар -> Claude fallback вызывается.
   - `tests/categorizer_new.test.ts`: Claude возвращает новую категорию -> она инсертится.
   - `tests/retraining.test.ts`: симуляция 3 corrected expenses -> embedding меняется.

### Acceptance

- [x] kNN работает на ru/uk/pl (через английскую нормализацию).
- [x] Fallback на Claude работает.
- [x] Новые категории создаются.
- [x] Retraining меняет centroid.

### Commit

`feat(ai): categorizer with multilingual workaround`.

---

## M7: Текст + currency

### Шаги

1. `_shared/dates.ts`:
   - `nowWarsaw(): Date`, `parseDate(text, refDateWarsaw): Date | null`.
   - Парсит относительные ("вчера", "позавчера", "в субботу"), абсолютные (DD.MM, DD.MM.YYYY),
     польские/украинские варианты.
   - Использует `Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" })` для tz-aware
     форматирования.
2. `_shared/currency.ts`:
   - Cache в БД через `exchange_rates` table.
   - `getRate(from: Currency, date: Date): Promise<number>`.
   - PLN это base, всегда 1.0.
   - EUR/USD: NBP API (`https://api.nbp.pl/api/exchangerates/rates/A/EUR/...`).
   - ALL: exchangerate.host.
   - Fallback на последний рабочий день если запрос вернул 404 (выходные, праздники).
   - При успехе: insert в exchange_rates с правильным source + is_fallback.
3. Text handler в `tg-webhook/index.ts`:
   - `dedupe` -> `authorize` -> typing action -> `budget check`.
   - `claudeParse(text)` -> { name, name_normalized_en, amount, currency, date }.
   - `embedAndCategorize(...)`.
   - `convertCurrency(amount, currency, date) -> amount_pln`.
   - High-amount check: если `amount_pln > 200`, поставить `needs_confirmation=true`.
   - Insert в `expenses` через
     `ON CONFLICT (telegram_message_id, family_member_id, line_index) DO NOTHING`.
   - Reply с inline keyboard: ↩️ Отменить, ✏️ Категория.
4. Callbacks:
   - `undo:<expense_id>`: проверка временного окна 10 минут + family_member_id == owner; archive.
   - `cat_menu:<expense_id>`: показать топ-5 категорий + "Другая".
   - `cat_all:<expense_id>`: пагинация по всем 17.
   - `cat_set:<expense_id>:<category_id>`: обновить + `corrected_by_user=true`.
5. Команды `/history`, `/undo`, `/stats` (timezone-aware).
6. `cron-rates/index.ts` daily 05:00 (но schedule всё ещё закомментирован, добавим в M14):
   - Получить курсы EUR, USD, ALL для today (Warsaw).
   - Insert в exchange_rates.
7. Тесты:
   - `tests/currency.test.ts`: курсы, конвертация.
   - `tests/currency_holidays.test.ts`: запрос на праздник -> fallback на предыдущий рабочий день.
   - `tests/parse_dates_tz.test.ts`: "вчера" в 23:00 Warsaw -> правильная дата.
   - `tests/text_pipeline.test.ts`: e2e тест pipeline на моках.

### Acceptance

- [x] Текстовая трата фиксируется.
- [x] Курсы PLN, EUR, USD, ALL работают.
- [x] Праздники обрабатываются.
- [x] Callbacks работают.

### Commit

`feat(text): full text pipeline`.

---

## M8: Голос через Groq

### Шаги

1. `_shared/groq.ts`:
   - `transcribe(oggBuffer: ArrayBuffer, language: string|"auto"): Promise<{text, detected_language}>`.
   - POST в Groq `whisper-large-v3-turbo` с multipart form.
2. Voice handler в `tg-webhook/index.ts`:
   - **Duration pre-check:** если `voice.duration > 300` сек, reject без download.
   - `getFile` Telegram API -> file_path.
   - `fetch` ogg.
   - Прогресс "🎙 Распознаю..." (edit message).
   - `groq.transcribe(buffer, "auto")`.
   - Если `detected_language` не в whitelist -> friendly reject.
   - Прогресс "🤖 Думаю..." (edit message).
   - Дальше как текст (см. M7 pipeline).
3. Фикстуры в `tests/fixtures/`:
   - `voice_ru.ogg`, `voice_uk.ogg`. Используй короткие записи (TTS-сгенерированные или скачай
     sample).
   - `groq_responses.json` с ожидаемыми ответами для моков.
4. Тесты:
   - `tests/voice.test.ts`: ru/uk фикстуры через моки.
   - `tests/voice_duration.test.ts`: 6-минутное rejected до download.
   - `tests/voice_language.test.ts`: китайский -> reject.

### Acceptance

- [x] Voice ru/uk создаёт запись < 10 сек (на моках).
- [x] Voice > 5 мин rejected до download.
- [x] Unsupported language -> reject.

### Commit

`feat(voice): groq whisper integration`.

---

## M9: Фото чеков + HEIC + Vision

### Шаги

1. `_shared/image.ts`:
   - `convertHeicIfNeeded(buffer, mime): Promise<{ buffer, mime }>`.
   - `compress(buffer): Promise<Buffer>` через sharp до 1920px max, q85.
2. Photo handler:
   - `getFile` -> download.
   - HEIC check (`update.message.photo` обычно JPEG, но `update.message.document` может быть HEIC
     если пришло как файл).
   - Compress.
   - Upload в Storage `receipts/{family_member_id}/{date}/{uuid}.jpg`.
   - Создать signed URL TTL 300 секунд.
   - Claude Vision (Sonnet 4.6) с tool use схемой `parse_receipt` (см. `docs/06_PROMPTS.md`).
   - Парс JSON: `{ merchant, total, items: [{ name, amount, qty? }] }`.
   - **Reconciliation +-5%:** `abs(sum(items.amount) - total) / total <= 0.05`. Если нет: ставим
     `needs_review=true` на ВСЕ позиции этого receipt.
   - Aggregate items по категориям (каждая позиция -> embed -> categorize).
   - Insert receipt + insert expenses (с одним `receipt_id`).
   - Reply: сводка по категориям + callback "📋 Подробно".
3. Callback "📋 Подробно": показывает все items receipt.
4. Тесты: 4 фикстуры JPEG/HEIC в `tests/fixtures/receipts/`.

### Acceptance

- [x] JPEG обрабатывается.
- [x] HEIC обрабатывается.
- [x] Reconciliation +-5%.
- [x] Receipt + Expenses в БД.

### Commit

`feat(receipts): photo with vision`.

---

## M10: Media groups

### Шаги

1. Media group handler:
   - Если `update.message.media_group_id` есть:
     - Insert в
       `media_group_buffer (media_group_id, telegram_message_id, family_member_id, file_id, received_at)`.
     - Reply один раз на первое фото в группе: "📸 Принимаю альбом, секунду...".
     - На следующие фото в этой же группе - не отвечать вообще.
2. `cron-media-group-sweep/index.ts`:
   - Cron-auth.
   - `select media_group_id, count(*), min(received_at) from media_group_buffer where received_at < now() - interval '30 seconds' group by media_group_id`.
   - Для каждой группы:
     - `select * from media_group_buffer where media_group_id = $1 order by telegram_message_id`.
     - Лимит 5: если > 5, обрабатываем первые 5, логируем warning о пропуске.
     - Каждое фото -> independent flow как M9 (но в одной транзакции).
     - Одно сводное reply.
     - Delete из buffer.
3. Тест `tests/media_group_recovery.test.ts`:
   - Симуляция: 3 фото с одинаковым `media_group_id` -> sweep подбирает все 3 -> один
     receipt-комбайн или 3 отдельных receipt (по SPEC §6.4 каждое фото это отдельный receipt,
     агрегация только items внутри одного receipt).

### Acceptance

- [x] Альбом обрабатывается через cron sweep.
- [x] 6+ фото: первые 5 ок, остальные silently игнорируются + log warning.

### Commit

`feat(media_group): album processing via cron sweep`.

---

## M11: Edited + high-amount confirmation

### Шаги

1. Edited message handler (`update.edited_message`):
   - `select * from expenses where telegram_message_id = $1 and family_member_id = $2`.
   - Update `archived = true` для каждой (audit trigger зафиксирует).
   - **Затем** `delete from expenses where telegram_message_id = $1 and family_member_id = $2` (hard
     delete).
   - Прогнать pipeline заново с `line_index` начиная с 0.
   - Reply "♻️ Запись обновлена".
2. High-amount flow:
   - При insert: если `amount_pln > 200`, ставим `needs_confirmation=true`.
   - Reply: "💸 Зафиксировал 250 PLN на 'набор продуктов'. Подтвердить? [✅ Да] [✏️ Изменить] [❌
     Отмена]".
   - Callbacks:
     - `conf_yes:<id>`: `needs_confirmation=false`.
     - `conf_no:<id>`: `archived=true`.
     - `conf_edit:<id>`: открыть категорий меню.
3. `cron-auto-confirm/index.ts`:
   - Cron-auth.
   - `update expenses set needs_confirmation=false where needs_confirmation=true and created_at < now() - interval '60 seconds'`.
4. Тесты:
   - `tests/idempotency_edited.test.ts`: edit длинный -> короткий -> длинный.
   - `tests/high_amount.test.ts`: > 200 PLN -> needs_confirmation, через 60 сек auto-confirm.

### Acceptance

- [x] Edited работает (см. SPEC §6.5).
- [x] High-amount confirmation работает.
- [x] Auto-confirm через 60 сек.

### Commit

`feat(edge): edited and high-amount confirmation`.

---

## M12: Mini App API endpoints

### Шаги

1. `_shared/webapp_auth.ts`:
   - `validateInitData(initDataString: string): Promise<FamilyMember | null>`.
   - Парсит query string, проверяет HMAC-SHA256 с `secret = sha256(bot_token + "WebAppData")` (см.
     Telegram docs).
   - TTL 24 часа на `auth_date`.
   - Возвращает FamilyMember из БД по `user.id`.
2. `_shared/cors.ts`:
   - Заголовки для `https://web.telegram.org` и `https://${GITHUB_USERNAME}.github.io`.
   - OPTIONS preflight.
3. Endpoints (каждый в `supabase/functions/api-<name>/index.ts`):
   - `api-me`: возвращает текущего user + family_members список (имена только).
   - `api-stats?period=month|week|day`: KPI (sum, count, top category, vs prev period).
   - `api-transactions?limit=N&offset=M&search=...`: список с пагинацией.
   - `api-categories`: 17 категорий + usage_count.
   - `api-family`: members.
   - `api-export?period=...`: CSV (Content-Type: text/csv).
   - `api-health` (admin only): расширенный health.
   - `api-health-public`: 200/503 без деталей, проверка `system_health.last_seen` свежее 5 минут.
4. **Все endpoints (кроме api-health-public)** проверяют initData через `validateInitData` и
   используют `family_member_id` оттуда. Query-параметры идентификации игнорируются.
5. Тесты:
   - `tests/webapp_auth.test.ts`: правильный HMAC -> ok, неправильный -> 401, старый auth_date
     -> 401.
   - `tests/webapp_cross_user.test.ts`: попытка получить чужие данные через query-параметр ->
     403/игнор.
   - Тесты на каждый endpoint с моком БД.

### Acceptance

- [x] Все 8 endpoints работают.
- [x] HMAC валидация работает.
- [x] CORS на github.io и web.telegram.org.
- [x] Cross-user 403.

### Commit

`feat(api): mini app endpoints with auth`.

---

## M13: Mini App frontend на GitHub Pages

### Шаги

1. `webapp/index.html`:
   - Telegram WebApp SDK script (`https://telegram.org/js/telegram-web-app.js`).
   - Access gating: если `Telegram.WebApp.initData` пустой -> div "Открой через Telegram".
   - Иначе: основное приложение.
   - Тёмная/светлая тема через `Telegram.WebApp.colorScheme`.
2. `webapp/styles.css`: vanilla, использует CSS variables Telegram WebApp
   (`var(--tg-theme-bg-color)`, ...).
3. `webapp/app.js`:
   - `const SUPABASE_URL = "..."` (из build-time подстановки или просто hardcoded после deploy).
   - `fetchAPI(path)`: добавляет `Authorization: tma <initData>` header.
   - Виджеты: KPI карточки, donut (Chart.js), line по дням, horizontal bar топ-5, stacked bar по
     членам, список транзакций, поиск, CSV export.
4. `webapp/tg-webapp.js`: тонкая обёртка над `window.Telegram.WebApp`.
5. **No localStorage / sessionStorage** (SPEC §0 запрет). Состояние держим в JS-объекте в памяти.
6. Перед deploy: создать workflow `.github/workflows/deploy.yml` (но это в M16 точно делается; тут
   просто webapp/ файлы).
7. Включить GitHub Pages через API:
   ```bash
   gh api -X POST "/repos/$GITHUB_REPO/pages" -f source[branch]=gh-pages -f source[path]=/
   ```
   (Может выдать 409 если уже включено - ок).
8. Сделать ручной первый deploy webapp/ в ветку gh-pages чтобы проверить:
   ```bash
   git subtree push --prefix webapp origin gh-pages
   ```
9. Проверить, что https://<username>.github.io/<repo>/ открывается.

### Acceptance

- [x] index.html открывается с github.io.
- [x] Без initData видна заглушка.
- [x] Все виджеты рендерятся (с моковыми данными на dev можно отладить).
- [x] CSV экспорт работает.

### Commit

`feat(webapp): mini app frontend`.

---

## M14: Cron jobs activated

### Шаги

1. Создать все cron Edge Functions, если ещё не созданы:
   - `cron-recurring`.
   - `cron-retention`.
   - `cron-anomaly`.
   - `cron-retraining` (уже из M6).
   - `cron-auto-confirm` (уже из M11).
   - `cron-retry-failed` (уже из M3).
   - `cron-media-group-sweep` (уже из M10).
   - `cron-rates` (уже из M7).
   - **`cron-heartbeat` не нужен**: heartbeat это просто `update system_health` напрямую через
     pg_cron, без Edge Function (SPEC §16 M14).
2. `cron-recurring/index.ts`:
   - End-of-month logic: если `day_of_month=31` и в текущем месяце нет 31, использовать последний
     день месяца.
   - `select * from recurring_expenses where active = true and (last_charged_date is null or last_charged_date < <effective_date>)`.
   - Для каждой: insert в expenses с `expense_date = effective_date`.
3. `cron-retention/index.ts`:
   - `select id, photo_path from receipts where created_at < now() - interval '90 days' and photo_purged_at is null`.
   - Для каждой: `supabase.storage.from('receipts').remove([photo_path])`.
   - Update `photo_purged_at = now()`.
4. `cron-anomaly/index.ts`:
   - Daily anomaly check: сегодняшние траты vs 7-day avg.
   - Если > 3x от среднего за день: notify админу.
5. Раскомментировать `cron.schedule(...)` в `0005_cron.sql`. Поскольку миграции применяются
   последовательно, чтобы не пересоздавать схему, добавь **новую** миграцию `0008_cron_activate.sql`
   которая:
   - Сначала `select cron.unschedule(name)` для каждого имени (чтобы не было дубля если applied
     повторно).
   - Потом `select cron.schedule(...)`.
6. Установить GUC через скрипт:
   ```bash
   # scripts/configure_cron.sh
   psql "$SUPABASE_DB_URL" -c "alter database postgres set app.functions_url = 'https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1';"
   psql "$SUPABASE_DB_URL" -c "alter database postgres set app.cron_secret = '${CRON_SECRET}';"
   ```
7. Deploy всех cron-функций.
8. Запустить скрипт `configure_cron.sh`.
9. Применить миграцию 0008.
10. Verify: `select jobname, schedule, active from cron.job` через psql.
11. Тесты:
    - `tests/recurring_eom.test.ts`: 4 кейса (31 января, 31 февраля -> 28 или 29, 30 февраля,
      регулярный 15-й).
    - `tests/retention.test.ts`: фото старше 90 дней удаляется.
    - `tests/anomaly.test.ts`: 3x от avg триггерит alert.

### Acceptance

- [x] Все cron jobs активны.
- [x] 4 кейса recurring eom протестированы.
- [x] Heartbeat пишет в system_health каждую минуту.
- [x] Retention работает.

### Commit

`feat(cron): all scheduled jobs active`.

---

## M15: Backup + restore + safety gate

### Шаги

1. `cron-backup/index.ts`:
   - Cron-auth.
   - `select backup_key_confirmed from system_health where id=1`. Если false: log + early return.
   - Export всех таблиц в JSON. Большие (`expenses`, `expense_audit`) пачками по 1000 строк через
     offset (или через cursor).
   - Собрать в один JSON-объект `{ table_name: [rows...] }`.
   - Gzip через `CompressionStream("gzip")`.
   - Encrypt через `npm:age-encryption@0.1.4` с `BACKUP_ENCRYPTION_KEY`.
   - Через GitHub REST API:
     - `POST /repos/$GITHUB_REPO/releases` с tag `backup-YYYY-MM-DD`.
     - `POST .../releases/<id>/assets` upload зашифрованного файла.
   - Удалить releases > 12 недель:
     - `GET /repos/$GITHUB_REPO/releases?per_page=100`.
     - Для каждого с `tag_name` начинающимся с `backup-` и старше 84 дней: DELETE.
   - **Integrity check:** скачать только что загруженный asset, decrypt+decompress, проверить что
     `expenses.length > 0`. Если нет: notify админу.
2. Команда `/health backup-confirm` (admin only) в `tg-webhook`:
   - `update system_health set backup_key_confirmed = true where id=1`.
   - Reply "✅ Подтверждено. Backups активны.".
3. `scripts/restore.ts`:
   - `gh release download <tag> --dir /tmp/restore`.
   - Запросить age private key у пользователя (через `Deno.stdin`, не из env).
   - Decrypt через age cli или через npm:age-encryption.
   - Распаковать JSON.
   - Подключиться к Postgres через `psql $SUPABASE_DB_URL` или прямо через `npm:postgres`.
   - Для каждой таблицы: `confirm "Truncate <table> and restore N rows? [y/N]"`. Если y: truncate +
     bulk insert.
4. Тесты:
   - `tests/backup_safety_gate.test.ts`: backup_key_confirmed=false -> функция не пишет.
   - `tests/backup_integrity.test.ts`: симуляция полного цикла (моки github API), integrity check
     проходит.

### Acceptance

- [x] cron-backup работает.
- [x] Safety gate блокирует без подтверждения.
- [x] `/health backup-confirm` ставит флаг.
- [x] Backup encrypted age.
- [x] Integrity check после upload.
- [x] `scripts/restore.ts` собран.

### Commit

`feat(backup): weekly to github releases with safety gate`.

---

## M16: CI/CD

### Шаги

1. Создать `.github/workflows/test.yml` точно по SPEC §14.1.
2. Создать `.github/workflows/deploy.yml` точно по SPEC §14.2 (с auto-revert на failure +
   `[no-auto-revert]` метка).
3. Через `gh secret set`:
   - `SUPABASE_ACCESS_TOKEN`.
   - `SUPABASE_PROJECT_REF`.
   - `SUPABASE_DB_PASSWORD`. (Полученные из BOOTSTRAP).
4. Включить branch protection main:
   ```bash
   gh api -X PUT "/repos/$GITHUB_REPO/branches/main/protection" \
     -f required_status_checks[strict]=true \
     -f required_status_checks[contexts][]=test \
     -f enforce_admins=false \
     -f required_pull_request_reviews=null \
     -f restrictions=null
   ```
   (`enforce_admins=false` чтобы Claude Code мог обходить если нужно через admin override).
5. Тест 1: создать намеренно сломанную feature ветку (например, syntax error в `.ts`),
   `gh pr create`, проверить что Actions падают, PR не мержится. После проверки удалить ветку.
6. Тест 2: создать рабочую фичу-косметику (например, обновление README),
   `gh pr create --fill --squash`, дождаться зелёных Actions,
   `gh pr merge --squash --delete-branch`. Проверить что deploy.yml прошёл, health 200.
7. Тест 3: создать намеренно сломанный код, который проходит deno test но ломает api-health-public
   (например, изменить return code на 500). Замержить, deploy.yml падает на health check,
   auto-revert PR должен создать revert commit. Проверить, что main вернулся к предыдущему
   состоянию. После теста удалить тестовые коммиты из git log если нужно.
8. Тест 4: auto-revert не должен зацикливаться. Проверить, что revert commit содержит
   `[no-auto-revert]`, и `deploy.yml` сразу же на этом коммите не запустит цикл.
9. Документация в README: setup GitHub Secrets + branch protection (для случая если кто-то будет
   настраивать с нуля).

### Acceptance

- [x] Push в feature -> test.yml green.
- [x] PR блокируется при красных.
- [x] Merge -> deploy -> health 200.
- [x] Сломанный health -> auto-revert PR.
- [x] Infinite loop невозможен.

### Commit

`feat(ci): test and deploy with auto-revert`.

---

## M17: DR testing

### Шаги

1. Симуляция backup -> restore:
   - Запустить `cron-backup` вручную:
     `curl -X POST .../cron-backup -H "Authorization: Bearer $CRON_SECRET"`.
   - Скачать release: `gh release download backup-<date>`.
   - Запустить `deno run scripts/restore.ts` на тестовую БД (если есть второй Supabase project для
     тестов; если нет - на ту же БД с осторожностью, после `db dump` для безопасности).
   - Проверить, что данные восстановились.
2. Симуляция revert через GitHub UI:
   - Создать тестовый коммит, замержить, потом через UI нажать revert.
   - Проверить, что deploy откатывает.
3. Симуляция нового Supabase project:
   - В реальности не делать (это требует ручных действий и денег). Вместо этого: detailed runbook в
     `README.md` Troubleshooting секция, шаги от "создать новый project" до "restore + setWebhook +
     redeploy".
4. Документировать в README раздел "Disaster Recovery", шаги для каждого сценария из SPEC §15.1.

### Acceptance

- [x] Backup -> restore работает локально.
- [x] Revert через UI работает.
- [x] DR runbook в README.

### Commit

`feat(dr): disaster recovery tested`.

---

## M18: Docs и финал

### Шаги

1. README.md:
   - Бейджи (build status, deploy status).
   - Краткое описание.
   - Ссылка на SPEC.md.
   - Quickstart (5 ручных шагов из SPEC §12.1).
   - Architecture diagram (ASCII или Mermaid).
   - Setup GitHub Secrets.
   - Troubleshooting секция (DR сценарии).
   - Лицензия (опционально).
2. BACKLOG.md проверить, что соответствует SPEC §22.
3. Проверить coverage:
   ```bash
   deno test --allow-all --coverage=cov tests/
   deno coverage cov --include="supabase/functions/" | tail -1
   deno coverage cov --include="supabase/functions/_shared/" | tail -1
   ```
   Цели: `supabase/functions/` >= 80%, `_shared/` >= 90%.
4. Если coverage не дотягивает - добавить тестов.
5. Финальный e2e чек по SPEC §19 (запусти каждый пункт):
   - Голосовое создаёт запись < 10 сек (на моках).
   - Воркфлоу для каждого пункта пройди по чек-листу.
6. `git tag v1.0.0 && git push origin v1.0.0`.
7. Финальный отчёт пользователю (см. CLAUDE.md раздел 7).

### Commit

`docs: readme, backlog, troubleshooting`. Затем `git tag v1.0.0`.

---

Конец 02_PLAYBOOK.md.
