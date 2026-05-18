# 10 GLOSSARY, терминология и разрешение спорных мест

## 1. Глоссарий

### Backend термины

- **Edge Function**: serverless TypeScript функция в Supabase, написана для Deno runtime. Один HTTP
  endpoint, выполняется по запросу.
- **pg_cron**: расширение Postgres, выполняет SQL команды по расписанию.
- **pg_net**: расширение Postgres, позволяет делать HTTP запросы из SQL (используется чтобы pg_cron
  мог дёргать Edge Functions).
- **pgvector**: расширение Postgres для vector embeddings. Используется для kNN-поиска похожих трат.
- **Storage bucket**: блочное хранилище Supabase, аналог S3. У нас bucket `receipts` для фото чеков.
- **RLS (Row Level Security)**: Postgres feature для разграничения доступа. У нас **отключено**
  (single-tenant family bot), фильтрация по `family_member_id` происходит на уровне Edge Function.
- **service_role key**: ключ Supabase с полным доступом, обходит RLS. У нас используется в Edge
  Functions через `SUPABASE_SERVICE_ROLE_KEY` (автоматически инжектируется в env).
- **anon key**: ключ Supabase для публичного доступа. В нашем проекте используется минимально
  (только для setup-once и api-health-public, если вообще).
- **GUC**: Grand Unified Configuration в Postgres. У нас используется `app.functions_url` и
  `app.cron_secret` для pg_cron.

### Telegram термины

- **Update**: входящее событие от Telegram (message, edited_message, callback_query, и т.д.).
  Структура задокументирована в Telegram Bot API.
- **Webhook**: HTTPS endpoint, на который Telegram POST'ит update'ы. У нас
  `https://<project>.supabase.co/functions/v1/tg-webhook`.
- **initData**: строка, которую Telegram WebApp передаёт в Mini App. Содержит данные пользователя +
  HMAC-подпись. Бот проверяет подпись на сервере.
- **Mini App**: HTML/JS приложение, которое открывается внутри Telegram через WebApp кнопку.
- **Media group**: альбом из нескольких фото/видео, отправленных одновременно. Каждое фото это
  отдельный update с одинаковым `media_group_id`.
- **Callback query**: нажатие на inline кнопку. Содержит `data` поле с произвольной строкой, которую
  установил бот.

### AI термины

- **Tool use**: feature Claude API, гарантирующая структурированный output. Передаёшь JSON schema,
  Claude вызывает "tool" с аргументами по schema.
- **Prompt caching**: feature Claude API для экономии токенов на повторяющейся статической части
  prompt. Кэш живёт 5 минут.
- **Whisper**: STT (speech-to-text) модель от OpenAI. У нас через Groq API
  (`whisper-large-v3-turbo`, дешевле и быстрее).
- **Embedding**: вектор фиксированной длины (у нас 384), представляющий смысл текста. Получаем через
  `Supabase.ai.Session("gte-small")`.
- **kNN**: k-nearest neighbors поиск. У нас: для нового expense находим k=5 похожих по cosine
  similarity, берём топ-1 если similarity > 0.85.
- **Centroid**: средний вектор для группы. У нас для категорий: среднее embedding всех expenses в
  этой категории, помеченных пользователем (corrected_by_user=true).

### Бизнес-термины

- **Family member**: пользователь FinBot, член семьи. Идентифицируется по `telegram_id`.
- **Family**: вся группа family_members с RLS-эквивалентом фильтрации по
  `family_member_id IN (select id from family_members)`. У нас single family на инстанс.
- **Expense**: одна запись о трате. Может быть частью Receipt.
- **Receipt**: один чек из магазина, агрегирует много expense (по позициям).
- **Recurring expense**: периодическая трата (подписка, аренда), создаётся через `cron-recurring`.
- **Audit log**: история изменений expenses. Пишется через trigger.

### Технические артефакты

- **Webhook secret в URL**: `?secret=<bot_token>`. Защита что webhook дёргают только Telegram (никто
  кроме нас не знает токен).
- **CRON_SECRET**: bearer-токен для cron-функций. Защита от внешних вызовов cron endpoints.
- **age public/private**: пара ключей для шифрования бэкапов. Public в `BACKUP_ENCRYPTION_KEY`
  (можно в репо), private только в 1Password.
- **High-amount threshold**: 200 PLN. Выше этого - требуется подтверждение или auto-confirm через 60
  сек.
- **Undo window**: 10 минут после insert, можно отменить через кнопку.

## 2. Спорные места в SPEC и их разрешение

### 2.1 "Pg_cron schedule в 0005_cron.sql закомментировать до M14"

Источник: SPEC §16 M2.

**Раскрытие:** В M2 миграция `0005_cron.sql` создаётся, но все `select cron.schedule(...)` обёрнуты
в SQL комментарии (`/* ... */` или `--`). В M14 создаётся **новая** миграция
`0008_cron_activate.sql`, которая:

1. Unschedules всех джобов (на случай если применяется повторно).
2. Schedules заново.

Старую миграцию **не редактируем**, только добавляем новую.

### 2.2 "Heartbeat через SQL без Edge Function"

Источник: SPEC §16 M14, "cron-heartbeat (через SQL без Edge Function вызова, для простоты)".

**Раскрытие:** В `0005_cron.sql` (или `0008_cron_activate.sql`) heartbeat это просто:

```sql
select cron.schedule('heartbeat-minutely', '* * * * *', $$
  update system_health set last_seen = now() where id = 1;
$$);
```

Без HTTP-вызова Edge Function. Это эффективнее: одна строка SQL вместо HTTP roundtrip.

Соответственно, **Edge Function `cron-heartbeat` НЕ создаётся**.

### 2.3 "Установка app.functions_url через миграцию"

Источник: SPEC §4.5 комментарий "These are set via migration during first deploy using CRON_SECRET
env var".

**Раскрытие:** Это нельзя сделать через стандартную Supabase миграцию (миграции применяются в
transaction'е, а `alter database` требует superuser). Решение:

- В M14 создаётся `scripts/configure_cron.sh`:
  ```bash
  psql "$SUPABASE_DB_URL" -c "alter database postgres set app.functions_url = 'https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1'"
  psql "$SUPABASE_DB_URL" -c "alter database postgres set app.cron_secret = '${CRON_SECRET}'"
  ```
- Скрипт запускается **один раз** на M14 (в playbook прописано).
- В deploy workflow (M16) скрипт можно вызывать после `supabase db push`, чтобы новые проекты
  автоматически получали GUC. Опционально.

### 2.4 "name_normalized_en" что это

Источник: SPEC §6.1, §6.3, §7.3.

**Раскрытие:** Это короткое английское описание, которое Claude генерирует **одновременно с
парсингом** трат. Используется как input для embedder (gte-small лучше работает на английском).
Пример:

- Текст пользователя: "купил молоко 2.5% за 4 zł"
- `name`: "молоко 2.5%" (русский, для отображения)
- `name_normalized_en`: "milk dairy" (английский, для embedding)

Claude получает обе строки одной tool_use вызовом, экономия токенов и одна точка отказа.

### 2.5 "Reconciliation +/- 5%"

Источник: SPEC §6.3.

**Раскрытие:** `abs(sum(items.amount) - total) / total <= 0.05`. Если не выполнено - помечаем
**все** expenses из этого receipt как `needs_review=true`. Reply пользователю с предупреждением.
Запись всё равно создаётся, не блокируем.

### 2.6 "Корректировка категории ставит corrected_by_user=true"

Источник: SPEC §6.8.

**Раскрытие:** Только при **ручной** смене категории через callback `cat_set:<id>:<cat_id>`. Не при
первой записи. Это сигнал для retraining: пользователь поправил, значит модель ошиблась.

При undo, archive, edit - `corrected_by_user` не трогаем.

### 2.7 "Edited message hard-delete"

Источник: SPEC §6.5.

**Раскрытие:** Шаги:

1. `update expenses set archived = true where telegram_message_id = X and family_member_id = Y`
   (audit trigger зафиксирует archive).
2. **Затем** `delete from expenses where telegram_message_id = X and family_member_id = Y` (hard
   delete, audit trigger уже отработал на update).
3. Прогнать pipeline для нового текста с line_index=0.

Audit trail остаётся: запись об archive есть, дальше delete (без audit, т.к. trigger только на
insert/update).

Альтернативно: пометить archived=true и не делать hard-delete. Но тогда нарушится unique constraint
`(telegram_message_id, family_member_id, line_index)`. Поэтому hard-delete.

### 2.8 "High-amount threshold 200 PLN"

Источник: SPEC §6.6.

**Раскрытие:** Сравниваем `amount_pln` (уже после конверсии в PLN), не `amount`. Так чтобы 250 EUR
(= ~1000 PLN) тоже триггерил confirmation.

### 2.9 "Media group лимит 5 фото"

Источник: SPEC §6.4.

**Раскрытие:** Если в media_group_buffer для одного `media_group_id` накопилось > 5 строк - sweep
обрабатывает первые 5 (по telegram_message_id ASC), остальные delete + log warning. Пользователю -
сводный reply (без упоминания пропущенных).

### 2.10 "Multilingual embedding caveat"

Источник: SPEC раздел "Multilingual embedding caveat".

**Раскрытие:** gte-small это англоязычная модель. Чтобы работало на ru/uk/pl/en mixed, делаем
`name_normalized_en` пайплайн: Claude нормализует на английский, embed на английском. kNN всё равно
работает на похожих английских описаниях. Качество приемлемое.

Если эмпирически окажется недостаточным - переход на `@xenova/transformers` с multilingual моделью
(см. SPEC §22 backlog), но **не в v1**.

### 2.11 "Cron-cron-семантика"

`cron-X` Edge Functions защищены `Authorization: Bearer ${CRON_SECRET}`. Внешний вызов без этого
header - 401.

pg_cron шлёт запрос с этим header через pg_net, читая `app.cron_secret` GUC.

CRON_SECRET генерируется один раз (M1 или M2), кладётся:

1. В Supabase secrets (для Edge Functions).
2. В GUC `app.cron_secret` (для pg_cron).

Изменить CRON_SECRET после установки - значит синхронно обновить оба места.

### 2.12 "RLS отключён, фильтрация в Edge Functions"

Источник: SPEC §4.6.

**Раскрытие:** Все Edge Functions используют service_role key и обходят RLS. Безопасность данных
обеспечивается:

1. В webhook: проверка `family_member_id` принадлежит whitelist.
2. В API endpoints: `family_member_id` извлекается из verified Telegram initData, query-параметр
   игнорируется.
3. Запросы в БД делают `where family_member_id = $1` явно.

RLS в v2 (см. backlog) для multi-tenancy.

### 2.13 "Edge Function size limit 20MB"

Источник: docs Supabase.

**Раскрытие:** Это размер задеплоенной функции (бандл). Если упирается:

1. Не импортируй `sharp`, `heic-convert` в функциях, где не нужны (например, `api-*`).
2. Используй dynamic `await import(...)`.
3. Альтернативные пакеты (`@jsquash/jpeg`, `imagescript`).

### 2.14 "Edge Function timeout 150 сек"

Источник: docs Supabase.

**Раскрытие:** Если обработка дольше - реструктурируй. Используй `EdgeRuntime.waitUntil(promise)`
для background задач после ответа:

```typescript
EdgeRuntime.waitUntil(async () => {
  // тяжёлая работа после reply
}());
return new Response("ok", { status: 200 });
```

Но: не используй waitUntil для критичных операций. Если функция упадёт - background умрёт без следа.

## 3. Имена и пути

- Имена БД-таблиц: `snake_case`.
- Имена столбцов: `snake_case`.
- Имена индексов: `idx_<table>_<columns>`.
- Имена триггеров: `trg_<table>_<event>`.
- Имена cron jobs: `<task>-<frequency>` (например, `recurring-daily`).
- Имена Edge Functions: `kebab-case`, prefix `cron-` для scheduled, `api-` для Mini App, `tg-` для
  Telegram.
- Имена тестовых файлов: `<feature>.test.ts`.
- Имена фикстур: говорящие, `receipt_jpeg_lidl.jpg`, `voice_ru_kofe.ogg`.

## 4. Аббревиатуры

- **STT**: speech-to-text.
- **OCR**: optical character recognition.
- **kNN**: k-nearest neighbors.
- **DR**: disaster recovery.
- **RTO**: recovery time objective.
- **RPO**: recovery point objective.
- **TTL**: time-to-live.
- **TZ**: timezone.
- **EOM**: end-of-month.
- **HMAC**: hash-based message authentication code.

---

Конец 10_GLOSSARY.md.
