# FinBot, ТЗ v6 (final, Supabase Edge Functions + GitHub Pages, без локального хостинга)

Семейный Telegram-бот для учёта расходов через голос, фото чеков и текст. Полностью serverless: бот
работает как Supabase Edge Function, Mini App дашборд хостится на GitHub Pages, deploy через GitHub
Actions. Никаких локальных машин, VPS или self-hosted runners.

---

## Версия и changelog

**v6 (текущая):** полный переход с Python+Mac Mini на TypeScript+Deno+Supabase Edge Functions.

Изменения v5 → v6:

### Архитектура

- **Mac Mini не используется вообще.** Удалены все упоминания launchd, Tailscale, SSH, self-hosted
  runner.
- **Бэкенд это Supabase Edge Functions** (Deno runtime). Один HTTP-вызов от Telegram, обработка,
  ответ.
- **Telegram через webhook**, не polling. URL
  `https://<project>.supabase.co/functions/v1/tg-webhook` регистрируется через `setWebhook` один раз
  при первом deploy.
- **Mini App дашборд на GitHub Pages**. Статический HTML/JS, API endpoints это отдельные Edge
  Functions.
- **Deploy через стандартный GitHub-hosted runner** (ubuntu-latest), команда
  `supabase functions deploy`.
- **Scheduled jobs через pg_cron** (встроен в Supabase Postgres), не через APScheduler.

### Стек

- **Язык: Python -> TypeScript** (Deno runtime).
- **Telegram framework: aiogram -> grammy** (популярный TS-фреймворк, штатно поддерживается
  Supabase).
- **Whisper: локальный mlx-whisper -> Groq API** (модель whisper-large-v3-turbo). Не локально и не
  OpenAI, выбрано из-за цены ($0.04/час vs $0.36/час) и скорости.
- **Embedder: sentence-transformers -> Supabase.ai.Session("gte-small")** встроенный, без внешних
  API.
- **Image processing: Pillow -> Web APIs + npm:sharp** для compress, npm:heic-convert для HEIC.
- **Local SQLite полностью удалена.** Idempotency, очередь, retry, всё через Postgres.
- **launchd, APScheduler, semaphores, Keychain, SQLCipher, Tailscale, ffmpeg -> не нужны**.

### Что осталось без изменений

- Логика категоризатора (kNN через pgvector + Claude fallback + feedback loop).
- Двухуровневый budget (per-user soft + global hard).
- Audit log таблица с триггером.
- High-amount confirmation flow.
- Timezone-aware date parsing.
- Anomaly detection.
- Все 17 категорий.
- Mini App виджеты.

### Multilingual embedding caveat

`Supabase.ai.Session("gte-small")` это англоязычная модель. Для русского/украинского/польского
качество ниже, чем у `paraphrase-multilingual-MiniLM-L12-v2` из v5. Решение: **двухуровневая
стратегия категоризатора**:

1. Сначала kNN через gte-small на названиях транслитерированных или переведённых на английский через
   Claude (Claude уже в pipeline всё равно для парсинга суммы).
2. Если kNN не уверен (similarity < 0.85), Claude fallback с топ-30 категорий.

На практике это работает: Claude и так нормализует "молоко" -> "milk" в structured output для
embedding, а категоризатор всё равно опирается на Claude для неуверенных случаев. Качество
эмпирически приемлемое для семейного бота. Если окажется недостаточным, в BACKLOG есть переход на
`@xenova/transformers` с multilingual моделью (на 1-2 секунды медленнее, но точнее).

---

## 0. Главное для Claude Code

Этот документ написан так, чтобы ты собрал проект полностью автономно. Пользователь делает 5
действий руками (раздел 12.1), отдаёт тебе токены через `supabase secrets set`, дальше всё ты.

**Правила работы:**

1. Иди по milestones строго по порядку (раздел 16). После каждого делай `git commit`.
2. Перед началом каждого milestone прочитай его acceptance criteria. Не переходи к следующему, пока
   все пункты не отмечены `[x]`.
3. Тесты пишутся параллельно с кодом, не в конце. Каждая Edge Function в `supabase/functions/` имеет
   тесты в `tests/`.
4. Если что-то противоречиво или неясно: остановись и спроси. Не додумывай.
5. TypeScript strict mode везде, Zod-схемы для границ между слоями, structured logging через
   `console.log` с JSON.
6. Никаких em-dash. Используй запятую, скобки, двоеточие или дефис (-).
7. Один коммит = один логический шаг.
8. Snapshot моделей Claude закрепляй в Supabase secrets, не в коде.
9. **Импорты только через `npm:` и `jsr:` префиксы с фиксированными версиями.** Не используй
   `https://deno.land/x/...` (deprecated в Supabase prompts).
10. **`Deno.serve` напрямую**, не `import { serve } from "std/http/server.ts"`.
11. **Утилиты в `supabase/functions/_shared/`**, импортируются через относительные пути. Никаких
    cross-dependencies между функциями.
12. **Файловая система: только `/tmp`** для временных файлов (Edge Functions ограничение).
13. **Coverage `supabase/functions/`: >= 80%**.

**Что НЕ делать без явной просьбы:**

- Не добавлять виджеты в Mini App кроме описанных в разделе 8.
- Не интегрировать банковские CSV, бюджеты на категории, сплиты (отложено, раздел 22).
- Не добавлять Vue/React/сборщики во фронтенд. Только vanilla JS + Chart.js.
- Не возвращать локальный Whisper, локальный embedder, SQLite, Mac Mini.
- Не использовать `localStorage`/`sessionStorage` в Mini App (см. ограничения Telegram WebApp).

---

## 1. Описание проекта

Семейный бот (2-5 человек) для записи трат в 3 клика, без подтверждений. Пользователь скидывает
голос, фото чека или текст. Бот парсит через Claude, кладёт в Supabase, показывает короткое
подтверждение.

**Принципы:**

- Минимум трения: автозапись без подтверждений (кроме high-amount, см. 6.6).
- Source of truth: Postgres в Supabase. Никаких локальных БД.
- Категории учатся через pgvector embeddings + история + feedback loop от пользовательских правок.
- Чеки: один Receipt + агрегированные Expense по категориям.
- Полностью serverless: запросы обрабатываются по требованию, инфраструктура не требует
  обслуживания.

---

## 2. Стек

### 2.1 Runtime и фреймворк

| Компонент        | Технология                                    | Версия                                   |
| ---------------- | --------------------------------------------- | ---------------------------------------- |
| Runtime          | Deno (Supabase Edge Functions)                | latest на платформе                      |
| Язык             | TypeScript                                    | strict mode                              |
| Telegram         | grammy                                        | npm:grammy@1.42.0                        |
| AI парсинг       | Anthropic SDK                                 | npm:@anthropic-ai/sdk@0.40.0             |
| STT (cloud)      | Groq SDK (whisper-large-v3-turbo)             | npm:groq-sdk@0.10.0                      |
| Embeddings       | Supabase.ai.Session("gte-small")              | встроенный, runtime native               |
| База             | Supabase Postgres 15 + pgvector + Storage     | hosted                                   |
| Validation       | Zod                                           | npm:zod@3.23.8                           |
| Supabase client  | @supabase/supabase-js                         | npm:@supabase/supabase-js@2.45.0         |
| Image processing | sharp (compress), heic-convert (HEIC -> JPEG) | npm:sharp@0.33.5, npm:heic-convert@2.1.0 |
| Test             | Deno.test (встроен)                           | runtime native                           |

### 2.2 Фронтенд Mini App

Vanilla HTML + JS + Chart.js 4.x. Telegram WebApp SDK. Тёмная/светлая тема. Хостится на GitHub
Pages.

### 2.3 Инфраструктура

- **Backend:** Supabase Edge Functions (Deno).
- **Database:** Supabase Postgres + pgvector.
- **Storage:** Supabase Storage `receipts` bucket.
- **Scheduled jobs:** pg_cron в Postgres.
- **Mini App hosting:** GitHub Pages (бесплатно).
- **CI/CD:** GitHub Actions, ubuntu-latest runner.
- **Backups:** weekly `pg_dump` в GitHub Releases (шифрованный age).

---

## 3. Архитектура

```
GitHub (private repo)
  supabase/
    migrations/
    functions/
      tg-webhook/        (Telegram entry point)
      api-stats/         (Mini App API)
      api-transactions/
      cron-recurring/    (вызывается pg_cron через pg_net)
      cron-retention/
      cron-retraining/
      cron-heartbeat/
      cron-anomaly/
      cron-backup/
      _shared/           (utilities)
  webapp/                (статика для GitHub Pages)
    index.html, app.js, styles.css
  .github/workflows/
    test.yml             (на push)
    deploy.yml           (на merge в main)

       |  supabase functions deploy        |  peaceiris/actions-gh-pages
       v                                    v
Supabase                                   GitHub Pages
  Edge Functions (Deno)                      Mini App (HTML/JS)
  + Postgres + pgvector                      https://<user>.github.io/finbot/webapp
  + Storage
  + pg_cron

  webhook https://<project>.supabase.co/functions/v1/tg-webhook
       v
   Telegram

External APIs called from Edge Functions:
  - api.anthropic.com    (Claude Haiku 4.5 + Sonnet 4.6)
  - api.groq.com         (Whisper transcription)
  - api.nbp.pl           (PLN exchange rates)
  - api.exchangerate.host (ALL/other rates)
```

**Поток разработки:**

1. Серхий правит код где угодно (любой компьютер с git).
2. `deno test` локально опционально (через установленный Deno) или сразу push.
3. `git commit && git push origin feature/X`.
4. PR на GitHub запускает `test.yml`: ubuntu-latest, `deno fmt --check`, `deno lint`, `deno test`.
5. PR merge в main запускает `deploy.yml`: `supabase functions deploy` для всех функций,
   `peaceiris/actions-gh-pages` для webapp/.
6. Post-deploy: workflow вызывает `https://<project>.supabase.co/functions/v1/api-health-public`
   через curl. Если 200, deploy success. Если нет, auto-revert PR создаётся.

**Поток обработки сообщения:**

1. Семья пишет сообщение в Telegram.
2. Telegram POST -> `https://<project>.supabase.co/functions/v1/tg-webhook?secret=<bot_token>`.
3. Edge Function стартует cold (~200-500ms первый раз, потом warm), парсит update.
4. Auth: проверка `from.id` в whitelist (таблица `family_members`).
5. Idempotency: insert в `message_log` с `ON CONFLICT DO NOTHING`. Если конфликт, выйти.
6. Маршрутизация: текст | голос | фото | callback | команда.
7. Обработка (см. раздел 6).
8. Запись в Postgres.
9. Reply через grammy -> Telegram.
10. Edge Function завершается.

**Никаких background процессов в функции.** Если задача длинная (например, генерация PDF отчёта в
будущем), использовать `EdgeRuntime.waitUntil(promise)`.

---

## 4. Схема Supabase

Миграции в `supabase/migrations/`, идемпотентные. Применяются автоматически через `supabase db push`
в deploy workflow.

### 4.1 Расширения

```sql
-- 0001_extensions.sql
create extension if not exists "uuid-ossp";
create extension if not exists "vector";
create extension if not exists "pg_trgm";
create extension if not exists "pg_cron";
create extension if not exists "pg_net";
```

### 4.2 Таблицы

```sql
-- 0002_tables.sql

create table if not exists family_members (
  id uuid primary key default uuid_generate_v4(),
  telegram_id bigint unique not null,
  username text,
  name text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists categories (
  id uuid primary key default uuid_generate_v4(),
  name text unique not null,
  description text,
  examples text,
  parent_id uuid references categories(id) on delete set null,
  usage_count integer not null default 0,
  is_fallback boolean not null default false,
  embedding vector(384),
  centroid_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists receipts (
  id uuid primary key default uuid_generate_v4(),
  merchant text,
  receipt_date date not null,
  currency text not null check (currency in ('PLN', 'EUR', 'ALL', 'USD')),
  total numeric(12, 2) not null,
  total_pln numeric(12, 2) not null,
  photo_path text,
  photo_purged_at timestamptz,
  raw_ocr jsonb,
  items jsonb,
  family_member_id uuid not null references family_members(id),
  telegram_message_id bigint,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists expenses (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  name_normalized text,
  expense_date date not null,
  amount numeric(12, 2) not null,
  currency text not null check (currency in ('PLN', 'EUR', 'ALL', 'USD')),
  amount_pln numeric(12, 2) not null,
  category_id uuid not null references categories(id),
  family_member_id uuid not null references family_members(id),
  source text not null check (source in ('voice', 'photo', 'text')),
  description text,
  receipt_id uuid references receipts(id) on delete set null,
  confidence numeric(3, 2) not null default 1.0,
  needs_review boolean not null default false,
  needs_confirmation boolean not null default false,
  archived boolean not null default false,
  corrected_by_user boolean not null default false,
  embedding vector(384),
  telegram_message_id bigint,
  line_index integer not null default 0,
  created_at timestamptz not null default now(),
  constraint expenses_idempotency unique nulls not distinct
    (telegram_message_id, family_member_id, line_index)
);

create table if not exists message_log (
  telegram_message_id bigint not null,
  family_member_id uuid not null references family_members(id),
  status text not null check (status in ('processing', 'done', 'error', 'awaiting_confirmation')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (telegram_message_id, family_member_id)
);

create table if not exists expense_audit (
  id uuid primary key default uuid_generate_v4(),
  expense_id uuid not null references expenses(id) on delete cascade,
  action text not null check (action in ('insert', 'update', 'archive', 'recategorize')),
  before_state jsonb,
  after_state jsonb,
  actor_telegram_id bigint,
  source text,
  created_at timestamptz not null default now()
);

create table if not exists exchange_rates (
  rate_date date not null,
  currency text not null,
  rate_pln numeric(12, 6) not null,
  source text not null,
  is_fallback boolean not null default false,
  fallback_from_date date,
  fetched_at timestamptz not null default now(),
  primary key (rate_date, currency)
);

create table if not exists recurring_expenses (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  amount numeric(12, 2) not null,
  currency text not null,
  category_id uuid not null references categories(id),
  family_member_id uuid not null references family_members(id),
  day_of_month integer not null check (day_of_month between 1 and 31),
  active boolean not null default true,
  last_charged_date date,
  created_at timestamptz not null default now()
);

create table if not exists anthropic_usage (
  id bigserial primary key,
  date date not null,
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd numeric(10, 6) not null,
  family_member_id uuid references family_members(id),
  created_at timestamptz not null default now()
);

create table if not exists media_group_buffer (
  media_group_id text not null,
  telegram_message_id bigint not null,
  family_member_id uuid not null references family_members(id),
  file_id text not null,
  received_at timestamptz not null default now(),
  primary key (media_group_id, telegram_message_id)
);

create table if not exists pending_retry (
  id bigserial primary key,
  telegram_message_id bigint not null,
  family_member_id uuid not null references family_members(id),
  payload jsonb not null,
  payload_type text not null check (payload_type in ('text', 'voice', 'photo')),
  attempt_count integer not null default 0,
  last_error text,
  next_retry_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists system_health (
  id integer primary key default 1,
  last_seen timestamptz not null default now(),
  bot_version text,
  backup_key_confirmed boolean not null default false,
  constraint single_row check (id = 1)
);
insert into system_health (id) values (1) on conflict do nothing;
```

### 4.3 Индексы

```sql
-- 0003_indexes.sql
create index if not exists idx_family_telegram_id on family_members(telegram_id);
create index if not exists idx_categories_usage on categories(usage_count desc);
create index if not exists idx_receipts_date on receipts(receipt_date desc);
create index if not exists idx_receipts_family on receipts(family_member_id);
create index if not exists idx_receipts_purge on receipts(created_at) where photo_purged_at is null;
create index if not exists idx_expenses_date on expenses(expense_date desc);
create index if not exists idx_expenses_category on expenses(category_id);
create index if not exists idx_expenses_family on expenses(family_member_id);
create index if not exists idx_expenses_msg on expenses(telegram_message_id);
create index if not exists idx_expenses_review on expenses(needs_review) where needs_review = true;
create index if not exists idx_expenses_confirm on expenses(needs_confirmation) where needs_confirmation = true;
create index if not exists idx_expenses_corrected on expenses(corrected_by_user) where corrected_by_user = true;
create index if not exists idx_audit_expense on expense_audit(expense_id);
create index if not exists idx_audit_created on expense_audit(created_at desc);
create index if not exists idx_usage_date on anthropic_usage(date);
create index if not exists idx_usage_user_date on anthropic_usage(family_member_id, date);
create index if not exists idx_mgb_received on media_group_buffer(received_at);
create index if not exists idx_pending_retry_next on pending_retry(next_retry_at);
create index if not exists idx_categories_embedding on categories using hnsw (embedding vector_cosine_ops);
create index if not exists idx_expenses_embedding on expenses using hnsw (embedding vector_cosine_ops);
```

### 4.4 Функции

```sql
-- 0004_functions.sql

create or replace function match_expenses(
  query_embedding vector(384),
  family_id uuid,
  match_threshold float default 0.7,
  match_count int default 5
)
returns table (id uuid, name text, category_id uuid, similarity float)
language sql stable
as $$
  select
    e.id, e.name, e.category_id,
    1 - (e.embedding <=> query_embedding) as similarity
  from expenses e
  join categories c on c.id = e.category_id
  where e.archived = false
    and e.embedding is not null
    and e.family_member_id in (
      select fm.id from family_members fm
      where fm.id = family_id or fm.role = 'admin'
    )
    and c.is_fallback = false
    and 1 - (e.embedding <=> query_embedding) > match_threshold
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function log_expense_audit() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into expense_audit (expense_id, action, after_state, source)
    values (new.id, 'insert', to_jsonb(new), new.source);
  elsif tg_op = 'UPDATE' then
    if old.archived = false and new.archived = true then
      insert into expense_audit (expense_id, action, before_state, after_state)
      values (new.id, 'archive', to_jsonb(old), to_jsonb(new));
    elsif old.category_id is distinct from new.category_id then
      insert into expense_audit (expense_id, action, before_state, after_state)
      values (new.id, 'recategorize', to_jsonb(old), to_jsonb(new));
    else
      insert into expense_audit (expense_id, action, before_state, after_state)
      values (new.id, 'update', to_jsonb(old), to_jsonb(new));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_expense_audit on expenses;
create trigger trg_expense_audit
  after insert or update on expenses
  for each row execute function log_expense_audit();
```

### 4.5 pg_cron schedules

```sql
-- 0005_cron.sql

-- Configuration: app.functions_url and app.cron_secret set via:
-- alter database postgres set app.functions_url = 'https://<project>.supabase.co/functions/v1';
-- alter database postgres set app.cron_secret = '<random-string>';
-- These are set via migration during first deploy using CRON_SECRET env var.

-- Recurring expenses: ежедневно 07:00 UTC
select cron.schedule(
  'recurring-daily',
  '0 7 * * *',
  $$
  select net.http_post(
    url := current_setting('app.functions_url') || '/cron-recurring',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule('retention-daily', '30 2 * * *', $$
  select net.http_post(
    url := current_setting('app.functions_url') || '/cron-retention',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret')),
    body := '{}'::jsonb
  );
$$);

select cron.schedule('retraining-weekly', '0 3 * * 0', $$
  select net.http_post(
    url := current_setting('app.functions_url') || '/cron-retraining',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret')),
    body := '{}'::jsonb
  );
$$);

select cron.schedule('heartbeat-minutely', '* * * * *', $$
  update system_health set last_seen = now() where id = 1;
$$);

select cron.schedule('anomaly-daily', '0 8 * * *', $$
  select net.http_post(
    url := current_setting('app.functions_url') || '/cron-anomaly',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret')),
    body := '{}'::jsonb
  );
$$);

select cron.schedule('backup-weekly', '0 3 * * 6', $$
  select net.http_post(
    url := current_setting('app.functions_url') || '/cron-backup',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret')),
    body := '{}'::jsonb
  );
$$);

select cron.schedule('media-group-sweep', '*/2 * * * *', $$
  select net.http_post(
    url := current_setting('app.functions_url') || '/cron-media-group-sweep',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret')),
    body := '{}'::jsonb
  );
$$);

select cron.schedule('rates-daily', '0 5 * * *', $$
  select net.http_post(
    url := current_setting('app.functions_url') || '/cron-rates',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret')),
    body := '{}'::jsonb
  );
$$);

select cron.schedule('auto-confirm-minutely', '* * * * *', $$
  select net.http_post(
    url := current_setting('app.functions_url') || '/cron-auto-confirm',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret')),
    body := '{}'::jsonb
  );
$$);

select cron.schedule('retry-failed-5min', '*/5 * * * *', $$
  select net.http_post(
    url := current_setting('app.functions_url') || '/cron-retry-failed',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret')),
    body := '{}'::jsonb
  );
$$);
```

### 4.6 Security

RLS остаётся выключенным (single-tenant family bot). Фильтрация по `family_member_id` обязательна в
каждом API endpoint.

```sql
-- 0006_security.sql
alter table family_members disable row level security;
alter table categories disable row level security;
alter table expenses disable row level security;
alter table receipts disable row level security;
alter table exchange_rates disable row level security;
alter table recurring_expenses disable row level security;
alter table expense_audit disable row level security;
alter table system_health disable row level security;
alter table message_log disable row level security;
alter table pending_retry disable row level security;
alter table anthropic_usage disable row level security;
alter table media_group_buffer disable row level security;

-- Storage bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;
```

### 4.7 Seed категорий

17 категорий, embedding генерируется в seed-функции через `Supabase.ai.Session("gte-small")` на
английских описаниях. Категории:

1. Groceries (Продукты)
2. Cafes and restaurants (Кафе и рестораны)
3. Transport (Транспорт)
4. Fuel (Топливо)
5. Housing (Жильё)
6. Connectivity (Связь и интернет)
7. Health (Здоровье и аптеки)
8. Clothing (Одежда и обувь)
9. Home goods (Дом и быт)
10. Children (Дети)
11. Entertainment (Развлечения)
12. Subscriptions (Подписки и сервисы)
13. Gifts (Подарки)
14. Education (Образование)
15. Travel (Путешествия)
16. Taxes and fees (Налоги и сборы)
17. Other (Прочее, is_fallback=true)

---

## 5. Idempotency и retry (без локальной БД)

Всё через Postgres:

- **Idempotency:** `insert into message_log (...) on conflict do nothing returning *`. Если
  returning пусто, сообщение уже обработано, выходим.
- **Retry:** Edge Functions не поддерживают долгие background-задачи (макс 150 секунд на запрос).
  Если внешний API упал, функция отвечает Telegram'у "временно недоступно", запись попадает в
  `pending_retry`. Cron `cron-retry-failed` каждые 5 минут пробует записи где `attempt < 5` и
  `next_retry_at <= now()`. Exponential backoff: 1, 5, 15, 60, 300 минут.

---

## 6. Поток данных

### 6.1 Текст

```
auth -> idempotency insert -> typing action -> budget check (global + per-user)
-> Claude parse (с current_date_warsaw в system prompt)
-> name_normalized (English) для embedding
-> embedding через Supabase.ai
-> kNN категоризатор (threshold 0.85) или Claude fallback
-> currency convert
-> high-amount check (если > 200 PLN, needs_confirmation=true)
-> insert into expenses (ON CONFLICT)
-> reply с inline keyboard
```

### 6.2 Голос

1. **Duration pre-check:** `update.message.voice.duration > WHISPER_MAX_VOICE_DURATION_SEC` ->
   reject без скачивания.
2. Download ogg через `getFile` + fetch.
3. POST в Groq API: `whisper-large-v3-turbo`, `language=auto` или из whitelist.
4. Результат: текст + detected_language.
5. Если detected_language не в whitelist (ru/uk/pl/en) -> reply "не понял язык".
6. Дальше как текст.

Прогресс-сообщения: "🎙 Распознаю..." -> "🤖 Думаю..." -> финал. Edit одного и того же сообщения
через `editMessageText`.

### 6.3 Фото чеков

1. Download через `getFile` + fetch (max 5MB ограничение Telegram, в bucket тоже 5MB).
2. Если HEIC, конверсия через `npm:heic-convert` (JPEG output).
3. Compress через `npm:sharp` (max 1920px, quality 85).
4. Upload в Supabase Storage bucket `receipts`.
5. Получить signed URL для Claude Vision (через Supabase Storage signed URLs, TTL 5 минут).
6. POST в Anthropic Sonnet 4.6 с image_url типом.
7. Parse JSON: merchant, total, items[].
8. Aggregate items по категориям (для каждой позиции embedding + категоризатор).
9. Reconciliation +-5% (sum items vs total).
10. Insert receipt + insert expenses.
11. Reply: сводка по категориям + кнопка "📋 Подробно".

### 6.4 Media groups

Edge Functions stateless, поэтому используем БД-буфер:

1. Первое фото с `media_group_id`: insert в `media_group_buffer`, **не отвечать пользователю
   немедленно**, ответ "📸 Принимаю альбом, секунду..." сразу же.
2. Каждое следующее фото с тем же `media_group_id`: дописать в `media_group_buffer`.
3. Cron `media-group-sweep` каждые 2 минуты: группы старше 30 секунд -> обработать.
4. Для обработки: каждое фото из группы -> independent flow как 6.3, но в одной транзакции.
5. Reply: одно сводное сообщение по всем чекам альбома.

Лимит 5 фото на альбом (если больше, оставшиеся silently игнорируются + лог).

### 6.5 Edited messages

1. Найти все `expenses` где `telegram_message_id = X AND family_member_id = Y`.
2. Update set `archived = true`, **затем** hard delete. Audit trigger через update зафиксирует
   archive.
3. Прогнать pipeline заново с `line_index` начиная с 0.
4. Reply: "♻️ Запись обновлена".

### 6.6 High-amount confirmation

При `amount_pln > HIGH_AMOUNT_THRESHOLD_PLN` (default 200):

1. Insert с `needs_confirmation=true`.
2. Reply: "💸 Зафиксировал 250 PLN на 'набор продуктов'. Подтвердить? [✅ Да] [✏️ Изменить] [❌
   Отмена]".
3. **Auto-confirm через cron:** функция `cron-auto-confirm` каждую минуту, обновляет
   `needs_confirmation=false` для записей старше `CONFIRMATION_TIMEOUT_SEC=60`.
4. При "Отмена" через callback: `archived=true`.

### 6.7 Unsupported

Стикеры, GIF, voice > 5 мин, документы -> friendly reply.

### 6.8 Команды

`/start`, `/help`, `/dashboard`, `/history`, `/undo`, `/stats`, `/categories`, `/recurring`,
`/add_member` (admin), `/health` (admin), `/budget` (admin), `/audit <id>` (admin).

Inline keyboard:

- `↩️ Отменить` (10 мин окно).
- `✏️ Категория` (топ-5 + "Другая" с пагинацией). При выборе ставит `corrected_by_user=true`.

---

## 7. AI

### 7.1 Модели

- **Claude Haiku 4.5** для текста и голоса (`CLAUDE_MODEL_FAST` в secrets).
- **Claude Sonnet 4.6** для чеков (`CLAUDE_MODEL_VISION`).
- **Groq whisper-large-v3-turbo** для STT.
- **Supabase.ai gte-small** для embeddings.

### 7.2 Tool use

Claude вызовы с tool use для гарантированной структуры. `temperature=0`. Prompt caching на
статической части (категории + инструкции).

### 7.3 Категоризатор

Pipeline:

1. Claude парсит text/voice -> `{name, name_normalized_en, amount, currency, date}`.
   `name_normalized_en` это короткое английское описание для лучшего качества gte-small (например,
   "молоко 2%" -> "milk 2 percent").
2. Embedding через `Supabase.ai.Session("gte-small")` на `name_normalized_en`.
3. `match_expenses(embedding, family_id, 0.85, 5)` через RPC.
4. Если есть результат с similarity > 0.85: использовать category_id из топ-1.
5. Иначе Claude fallback: топ-30 категорий + топ-5 похожих expenses. Claude возвращает category_id
   (существующий) или новую категорию.
6. Новая категория: insert, embedding на английском описании.

### 7.4 Retraining

Cron `cron-retraining` (воскресенье 03:00):

1. Для каждой категории найти expenses где `corrected_by_user=true`.
2. Если >= 3 примера, пересчитать `categories.embedding` как среднее embedding этих expenses.
3. Update `centroid_updated_at`.

### 7.5 Budget cap

- **Per-user soft cap:** `ANTHROPIC_DAILY_BUDGET_USD_PER_USER` (default 0.30). Превышение: warning,
  обработка продолжается до global.
- **Global hard cap:** `ANTHROPIC_DAILY_BUDGET_USD` (default 1.00). Превышение: hard stop, "🚫
  Дневной бюджет исчерпан".

Tracking в `anthropic_usage`. Проверка перед каждым Claude-вызовом:
`select sum(cost_usd) from anthropic_usage where date = current_date`.

### 7.6 Промпты

`supabase/functions/_shared/prompts/parse_expense.ts` и `parse_receipt.ts` экспортируют функции,
возвращающие system + tool schemas. `current_date_warsaw` подставляется как параметр.

---

## 8. Mini App дашборд

Hosted on GitHub Pages: `https://<username>.github.io/finbot/webapp/`.

Endpoints (отдельные Edge Functions):

- `GET /functions/v1/api-me`, текущий пользователь.
- `GET /functions/v1/api-stats?period=month|week|day`, KPI.
- `GET /functions/v1/api-transactions?limit=N&offset=M&search=...`, список.
- `GET /functions/v1/api-categories`, категории.
- `GET /functions/v1/api-family`, члены семьи.
- `GET /functions/v1/api-export`, CSV.
- `GET /functions/v1/api-health`, admin.
- `GET /functions/v1/api-health-public`, public для UptimeRobot, 200/503 без деталей.

**Authorization:** все API endpoints проверяют Telegram WebApp initData через HMAC-SHA256. Bot token
используется как secret. `family_member_id` извлекается из verified initData, query-параметр
игнорируется.

**CORS:** разрешён `Origin: https://web.telegram.org` и `https://<username>.github.io`.

**Rate limit:** через Supabase Edge Functions встроенный rate limit или таблица `rate_limit` с
проверкой по telegram_id.

Виджеты: KPI (3 карточки), donut по категориям, line по дням, horizontal bar топ-5, stacked bar по
членам семьи, список транзакций с поиском, экспорт CSV.

**Frontend access gating:** `webapp/index.html` сразу проверяет `Telegram.WebApp.initData`. Без него
показывается заглушка "Открой через Telegram".

---

## 9. Безопасность и retention

### 9.1 Authorization

- Whitelist `family_members` с `active=true`. Чужие сообщения -> отказ + алерт админу.
- HMAC initData для Mini App (TTL 24 часа).
- Webhook secret в URL: `?secret=<bot_token>`. Telegram должен передавать токен, иначе 405.
- Cron Edge Functions проверяют `Authorization: Bearer <CRON_SECRET>`.

### 9.2 Secrets

Все секреты в Supabase secrets (`supabase secrets set --env-file .env`). Не в коде, не в
репозитории.

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_TELEGRAM_ID`
- `ANTHROPIC_API_KEY`
- `GROQ_API_KEY`
- `CLAUDE_MODEL_FAST`, `CLAUDE_MODEL_VISION`
- `BACKUP_ENCRYPTION_KEY` (age public)
- `GITHUB_TOKEN` (для backup upload)
- `GITHUB_REPO`
- `CRON_SECRET`
- бюджеты, лимиты, threshold

GitHub Actions secrets (в репо settings):

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_PROJECT_REF`
- `SUPABASE_DB_PASSWORD`

### 9.3 Retention

`cron-retention` daily 02:30: удаляет фото из Storage где `created_at < now() - 90 days`, сетит
`photo_purged_at`.

### 9.4 Backups

`cron-backup` weekly суббота 03:00:

1. Проверка `system_health.backup_key_confirmed`. Если false, отказ с лог-инструкцией.
2. Экспорт всех таблиц в JSON через `select json_agg(t) from <table> t` (большие таблицы пачками).
3. Архивирование в JSON.gz через CompressionStream API.
4. Шифрование через `npm:age-encryption` с публичным ключом из `BACKUP_ENCRYPTION_KEY`.
5. POST в GitHub REST API: создать release `backup-YYYY-MM-DD`, upload encrypted asset.
6. Удалить releases старше 12 недель.
7. Запустить integrity check (см. 15.3).

### 9.5 Restore

Скрипт `scripts/restore.ts` (локально):

1. `gh release download <tag>`.
2. Decrypt через age с приватным ключом из 1Password.
3. Распаковать JSON.
4. Подключиться через `psql $SUPABASE_DB_URL`.
5. Подтверждение перед каждой таблицей.
6. Truncate + insert.

---

## 10. Структура проекта

```
finbot/
├── .github/
│   └── workflows/
│       ├── test.yml
│       └── deploy.yml
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 0001_extensions.sql
│   │   ├── 0002_tables.sql
│   │   ├── 0003_indexes.sql
│   │   ├── 0004_functions.sql
│   │   ├── 0005_cron.sql
│   │   └── 0006_security.sql
│   └── functions/
│       ├── _shared/
│       │   ├── auth.ts
│       │   ├── supabase.ts
│       │   ├── telegram.ts
│       │   ├── claude.ts
│       │   ├── groq.ts
│       │   ├── embedder.ts
│       │   ├── categorizer.ts
│       │   ├── currency.ts
│       │   ├── image.ts
│       │   ├── prompts/
│       │   │   ├── parse_expense.ts
│       │   │   └── parse_receipt.ts
│       │   ├── seed.ts
│       │   ├── dates.ts
│       │   ├── audit.ts
│       │   ├── budget.ts
│       │   ├── webapp_auth.ts
│       │   ├── cron_auth.ts
│       │   └── types.ts
│       ├── tg-webhook/index.ts
│       ├── api-stats/index.ts
│       ├── api-transactions/index.ts
│       ├── api-categories/index.ts
│       ├── api-family/index.ts
│       ├── api-export/index.ts
│       ├── api-me/index.ts
│       ├── api-health/index.ts
│       ├── api-health-public/index.ts
│       ├── cron-recurring/index.ts
│       ├── cron-retention/index.ts
│       ├── cron-retraining/index.ts
│       ├── cron-heartbeat/index.ts
│       ├── cron-anomaly/index.ts
│       ├── cron-backup/index.ts
│       ├── cron-auto-confirm/index.ts
│       ├── cron-retry-failed/index.ts
│       ├── cron-media-group-sweep/index.ts
│       └── cron-rates/index.ts
├── webapp/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── tg-webapp.js
├── scripts/
│   ├── setup_telegram_webhook.ts
│   ├── set_secrets.sh
│   ├── seed_categories.sql
│   └── restore.ts
├── tests/
│   ├── tg-webhook.test.ts
│   ├── categorizer.test.ts
│   ├── currency.test.ts
│   ├── currency_holidays.test.ts
│   ├── recurring_eom.test.ts
│   ├── idempotency.test.ts
│   ├── idempotency_edited.test.ts
│   ├── media_group_recovery.test.ts
│   ├── high_amount.test.ts
│   ├── webapp_auth.test.ts
│   ├── webapp_cross_user.test.ts
│   ├── audit_log.test.ts
│   ├── budget_per_user.test.ts
│   ├── parse_dates_tz.test.ts
│   ├── image.test.ts
│   └── fixtures/
├── deno.json
├── .env.example
├── .gitignore
├── README.md
├── BACKLOG.md
├── SPEC.md
└── Makefile
```

---

## 11. Конфигурация

### 11.1 `.env.example`

Файл используется для bootstrap, потом значения переезжают в Supabase secrets через
`supabase secrets set --env-file .env`.

```bash
# === Telegram ===
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_TELEGRAM_ID=

# === Anthropic ===
ANTHROPIC_API_KEY=
CLAUDE_MODEL_FAST=claude-haiku-4-5-20251001
CLAUDE_MODEL_VISION=claude-sonnet-4-6
ANTHROPIC_DAILY_BUDGET_USD=1.00
ANTHROPIC_DAILY_BUDGET_USD_PER_USER=0.30

# === Groq ===
GROQ_API_KEY=
GROQ_MODEL=whisper-large-v3-turbo
WHISPER_LANGUAGES_WHITELIST=ru,uk,pl,en
WHISPER_MAX_VOICE_DURATION_SEC=300

# === Image ===
IMAGE_MAX_DIMENSION=1920
IMAGE_JPEG_QUALITY=85
PHOTO_RETENTION_DAYS=90

# === Misc ===
DEFAULT_CURRENCY=PLN
DEFAULT_TIMEZONE=Europe/Warsaw
HIGH_AMOUNT_THRESHOLD_PLN=200
CONFIRMATION_TIMEOUT_SEC=60
UNDO_WINDOW_MINUTES=10

# === Cron ===
CRON_SECRET=

# === GitHub (для backup) ===
GITHUB_TOKEN=
GITHUB_REPO=
BACKUP_ENCRYPTION_KEY=
```

`SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` автоматически инжектируются Supabase в Edge Functions,
не нужно прописывать вручную.

### 11.2 `deno.json`

```json
{
  "tasks": {
    "test": "deno test --allow-all tests/",
    "fmt": "deno fmt",
    "lint": "deno lint",
    "check": "deno check supabase/functions/**/*.ts"
  },
  "lint": { "rules": { "tags": ["recommended"] } },
  "fmt": { "lineWidth": 100, "indentWidth": 2, "singleQuote": true },
  "imports": {
    "@anthropic/sdk": "npm:@anthropic-ai/sdk@0.40.0",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.45.0",
    "grammy": "npm:grammy@1.42.0",
    "groq": "npm:groq-sdk@0.10.0",
    "zod": "npm:zod@3.23.8",
    "sharp": "npm:sharp@0.33.5",
    "heic-convert": "npm:heic-convert@2.1.0",
    "age": "npm:age-encryption@0.1.4"
  }
}
```

---

## 12. Setup

### 12.1 Что делает пользователь руками (5 шагов, ~20 минут)

1. **Telegram bot:** @BotFather -> `/newbot` -> токен. `/setcommands` (см. 12.4).
2. **Anthropic:** console.anthropic.com -> API Keys.
3. **Groq:** console.groq.com -> API Keys (бесплатный tier хватает).
4. **Supabase:** supabase.com -> New project (Frankfurt). Project ref, DB password.
5. **GitHub:**
   - Создать приватный репозиторий `finbot`.
   - Сгенерировать `age-keygen`, публичный ключ сохранить, **приватный обязательно в password
     manager**.
   - PAT с `repo` scope для backup upload.
   - В Settings -> Secrets -> Actions: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`,
     `SUPABASE_DB_PASSWORD`.
   - В Settings -> Pages: включить deploy с ветки `gh-pages`.

### 12.2 First-time setup

Локально нужны Deno и Supabase CLI:

```bash
# macOS
brew install deno supabase/tap/supabase
```

```bash
git clone git@github.com:USERNAME/finbot.git
cd finbot
cp .env.example .env
# отредактировать .env

# Линковка
supabase login
supabase link --project-ref <project-ref>

# Push secrets
supabase secrets set --env-file .env

# Migrations
supabase db push

# Deploy функций
supabase functions deploy

# Регистрация webhook
deno run --allow-net --allow-env scripts/setup_telegram_webhook.ts

# Webapp на GitHub Pages: первый merge в main задеплоит автоматически
```

### 12.3 setup_telegram_webhook.ts

```typescript
import { z } from "npm:zod@3.23.8";

const env = z.object({
  TELEGRAM_BOT_TOKEN: z.string(),
  SUPABASE_PROJECT_REF: z.string(),
}).parse({
  TELEGRAM_BOT_TOKEN: Deno.env.get("TELEGRAM_BOT_TOKEN"),
  SUPABASE_PROJECT_REF: Deno.env.get("SUPABASE_PROJECT_REF"),
});

const url =
  `https://${env.SUPABASE_PROJECT_REF}.supabase.co/functions/v1/tg-webhook?secret=${env.TELEGRAM_BOT_TOKEN}`;

const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url,
    allowed_updates: ["message", "edited_message", "callback_query"],
    drop_pending_updates: true,
  }),
});

console.log(await res.json());
```

### 12.4 BotFather commands

```
start - Начать
help - Справка
dashboard - Открыть дашборд
history - Последние траты
stats - Сводка за месяц
categories - Список категорий
undo - Отменить последнюю запись
recurring - Регулярные траты
```

### 12.5 Mini App в BotFather

`/newapp` -> бот -> "FinBot" -> описание -> URL `https://<username>.github.io/finbot/webapp/`.
`/setmenubutton` -> "📊 Дашборд".

---

## 13. Working on the code

### 13.1 Принципы

- Никаких pushes в main напрямую, только через PR.
- PR мержится только если зелёные тесты.
- Никаких секретов в коде.

### 13.2 Branching

```
main                  <- production
├── feature/whisper-uk
├── fix/heic-rotation
└── chore/update-deps
```

### 13.3 Цикл разработки

```bash
git checkout -b feature/whisper-uk
# правишь supabase/functions/tg-webhook/index.ts
deno task test
deno task fmt
deno task lint
git add . && git commit -m "feat(whisper): add ukrainian language"
git push -u origin feature/whisper-uk
# PR на GitHub -> зелёные Actions -> squash merge -> auto-deploy
```

### 13.4 Локальная разработка с эмулятором (опционально)

```bash
supabase start
supabase functions serve
# curl http://localhost:54321/functions/v1/tg-webhook?secret=...
```

### 13.5 Makefile

```makefile
.PHONY: test fmt lint deploy logs secrets-push webhook-set

test:
	deno task test

fmt:
	deno task fmt

lint:
	deno task lint

deploy:
	supabase functions deploy
	supabase db push

secrets-push:
	supabase secrets set --env-file .env

webhook-set:
	deno run --allow-net --allow-env scripts/setup_telegram_webhook.ts

logs:
	supabase functions logs tg-webhook --tail
```

---

## 14. CI/CD

### 14.1 Tests workflow

`.github/workflows/test.yml`:

```yaml
name: Test
on:
  push:
    branches: ["**"]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v1
        with:
          deno-version: v1.x
      - run: deno fmt --check
      - run: deno lint
      - run: deno check supabase/functions/**/*.ts
      - run: deno task test
```

### 14.2 Deploy workflow

`.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  push:
    branches: [main]

permissions:
  contents: write
  pages: write
  id-token: write

jobs:
  deploy-functions:
    runs-on: ubuntu-latest
    outputs:
      health_status: ${{ steps.health.outputs.status }}
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Link project
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
        run: supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}

      - name: Apply migrations
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
        run: supabase db push --include-all

      - name: Deploy functions
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
        run: supabase functions deploy --no-verify-jwt

      - name: Health check
        id: health
        run: |
          sleep 10
          STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
            https://${{ secrets.SUPABASE_PROJECT_REF }}.supabase.co/functions/v1/api-health-public)
          echo "status=$STATUS" >> $GITHUB_OUTPUT
          if [ "$STATUS" != "200" ]; then
            echo "::error::Health check failed: $STATUS"
            exit 1
          fi

  auto-revert-on-failure:
    runs-on: ubuntu-latest
    needs: deploy-functions
    if: failure() && !contains(github.event.head_commit.message, '[no-auto-revert]')
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
      - name: Revert last commit
        run: |
          git config user.name "FinBot CI"
          git config user.email "ci@finbot.local"
          git revert --no-edit HEAD
          git commit --amend -m "$(git log -1 --pretty=%B)

[no-auto-revert]"
          git push origin main

  deploy-webapp:
    runs-on: ubuntu-latest
    needs: deploy-functions
    steps:
      - uses: actions/checkout@v4
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./webapp
          publish_branch: gh-pages
```

### 14.3 Rollback стратегии

- **Auto-revert PR:** при failed health check, workflow создаёт revert commit с маркером
  `[no-auto-revert]` чтобы предотвратить infinite loop.
- **Ручной revert:** `git revert <sha> && git push`.
- **Restore из backup:** для случаев когда повредились данные.

### 14.4 Backup workflow

Backup это `cron-backup` Edge Function, вызывается pg_cron каждую субботу 03:00 UTC. Не GitHub
Actions workflow.

---

## 15. Disaster recovery

### 15.1 Сценарии

| Сценарий                      | RTO      | Действия                                                                                |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------- |
| Bug в новой функции           | < 5 мин  | Health check fail -> auto-revert PR -> redeploy предыдущей версии                       |
| Один Edge Function упал       | < 2 мин  | Supabase auto-restart на следующем запросе                                              |
| Supabase project заблокирован | < 2 часа | Новый Supabase, `supabase link`, restore через скрипт, обновить webhook                 |
| Telegram bot заблокирован     | редко    | Новый бот через BotFather, обновить secrets, перевыставить webhook                      |
| GitHub репо удалён            | < 5 мин  | Локальные клоны = бэкап кода. Mirror в GitLab опционально                               |
| Backup encryption key потерян | критично | Безвозвратно для GitHub backups. Поэтому safety gate из 9.4                             |
| pg_cron не выполняет задачи   | < 30 мин | Проверить через Dashboard -> Database -> Cron. `select cron.unschedule + cron.schedule` |

### 15.2 External monitoring (опционально)

UptimeRobot (free) на `https://<project>.supabase.co/functions/v1/api-health-public` каждые 5 минут.
Email-алерт если 3 проверки подряд fail.

`api-health-public` возвращает 200 если `system_health.last_seen` свежее 5 минут, иначе 503.

### 15.3 Backup integrity check

После каждого upload в GitHub Release функция `cron-backup` дополнительно:

1. Скачивает только что загруженный asset через GitHub API.
2. Decrypt + decompress.
3. Парсит JSON, проверяет что expenses count > 0.
4. Лог результата.
5. При неудаче алерт админу в Telegram через bot API.

---

## 16. Milestones

### M1: Skeleton + Supabase setup

- [ ] `git init`, `deno.json`, `.gitignore`, `Makefile`, `README.md`.
- [ ] Структура папок из раздела 10.
- [ ] `supabase init` + `supabase link --project-ref`.
- [ ] `_shared/types.ts` с базовыми Zod схемами.
- [ ] `_shared/supabase.ts` с admin client factory.
- [ ] Базовая Edge Function `tg-webhook/index.ts`: отвечает на `/start` через grammy.
- [ ] Локальный `supabase functions serve` работает.
- [ ] Commit: `chore: initial skeleton`.

### M2: Database schema

- [ ] Все 6 миграций.
- [ ] `_shared/seed.ts` с 17 категориями + embeddings.
- [ ] Audit trigger.
- [ ] pg_cron schedules в 0005_cron.sql (закомментированы до M14 чтобы не дёргать ненастроенные
      функции).
- [ ] Storage bucket.
- [ ] `supabase db push` отрабатывает чисто.
- [ ] Тест: audit trigger пишет на insert/update.
- [ ] Commit: `feat(db): schema with audit`.

### M3: Idempotency + retry queue

- [ ] `message_log` insert с ON CONFLICT.
- [ ] `pending_retry` таблица.
- [ ] `cron-retry-failed` функция с exponential backoff.
- [ ] Тест: повторный telegram_message_id отклоняется.
- [ ] Тест: edited message (длинный -> короткий -> длинный) корректно перезаписывается.
- [ ] Commit: `feat(reliability): idempotency and retry queue`.

### M4: Auth + базовые команды

- [ ] `_shared/auth.ts`: whitelist через family_members.
- [ ] Команды `/start`, `/help`, `/categories`, `/dashboard`, `/health`, `/audit`.
- [ ] Unauthorized -> alert админу.
- [ ] Тест: чужой telegram_id отвергается.
- [ ] Commit: `feat(auth): authorization and base commands`.

### M5: Claude + budget tracking

- [ ] `_shared/claude.ts`: tool use, prompt caching.
- [ ] `_shared/budget.ts`: per-user soft + global hard.
- [ ] Cost calculation из usage response.
- [ ] Insert в anthropic_usage с family_member_id.
- [ ] Тест: симуляция превышения per-user и global.
- [ ] Commit: `feat(ai): claude with two-tier budget`.

### M6: Embedder + categorizer + retraining

- [ ] `_shared/embedder.ts`: `Supabase.ai.Session("gte-small")`.
- [ ] `_shared/categorizer.ts`: kNN + Claude fallback.
- [ ] `name_normalized_en` пайплайн (Claude нормализует на английский).
- [ ] `cron-retraining`: пересчёт centroid для категорий с >=3 user-confirmed.
- [ ] Тесты.
- [ ] Commit: `feat(ai): categorizer with multilingual workaround`.

### M7: Текст + currency

- [ ] `_shared/dates.ts`: timezone-aware (Europe/Warsaw).
- [ ] `_shared/currency.ts`: NBP + exchangerate.host, fallback к последнему рабочему дню.
- [ ] Text handler в tg-webhook.
- [ ] Callbacks: undo, cat_menu, cat_all, recategorize ставит `corrected_by_user=true`.
- [ ] `/history`, `/undo`, `/stats` (tz-aware).
- [ ] `cron-rates` daily 05:00.
- [ ] Тесты: currency_holidays, parse_dates_tz.
- [ ] Commit: `feat(text): full text pipeline`.

### M8: Голос через Groq

- [ ] `_shared/groq.ts`: Whisper transcribe.
- [ ] Voice handler: duration pre-check, download, send to Groq, language whitelist.
- [ ] Progress messages.
- [ ] Тест: рус/укр фикстуры (моки Groq).
- [ ] Тест: 6-минутное голосовое rejected до download.
- [ ] Commit: `feat(voice): groq whisper integration`.

### M9: Фото чеков + HEIC + Vision

- [ ] `_shared/image.ts`: heic-convert + sharp compress.
- [ ] Photo handler: download, process, upload to Storage, signed URL, Claude Sonnet Vision.
- [ ] Aggregate по категориям.
- [ ] Reconciliation +-5%.
- [ ] Callback "📋 Подробно".
- [ ] Тесты на 4 фикстурах.
- [ ] Commit: `feat(receipts): photo with vision`.

### M10: Media groups

- [ ] Media group buffer flow.
- [ ] `cron-media-group-sweep` каждые 2 минуты.
- [ ] Лимит 5 фото.
- [ ] Тест: процесс не успел добить альбом -> sweep подбирает.
- [ ] Commit: `feat(media_group): album processing via cron sweep`.

### M11: Edited + high-amount confirmation

- [ ] Edited message handler: hard-delete + reinsert.
- [ ] High-amount flow: needs_confirmation, callback.
- [ ] `cron-auto-confirm` каждую минуту.
- [ ] Тесты: edited edge cases, high_amount.
- [ ] Commit: `feat(edge): edited and high-amount confirmation`.

### M12: Mini App API endpoints

- [ ] `_shared/webapp_auth.ts`: HMAC initData validator.
- [ ] Все endpoints: api-me, api-stats, api-transactions, api-categories, api-family, api-export,
      api-health, api-health-public.
- [ ] CORS на web.telegram.org и github.io.
- [ ] family_member_id из verified initData, не из query.
- [ ] Тест: cross-user попытка -> 403.
- [ ] Commit: `feat(api): mini app endpoints with auth`.

### M13: Mini App frontend на GitHub Pages

- [ ] webapp/index.html, app.js, styles.css.
- [ ] Access gating (initData check).
- [ ] Все виджеты.
- [ ] Тёмная/светлая тема.
- [ ] CSV экспорт.
- [ ] Workflow deploy-webapp работает.
- [ ] Commit: `feat(webapp): mini app frontend`.

### M14: Cron jobs activated

- [ ] cron-recurring: end-of-month logic с 4 кейсами теста.
- [ ] cron-retention.
- [ ] cron-heartbeat (через SQL без Edge Function вызова, для простоты).
- [ ] cron-anomaly.
- [ ] cron-retraining.
- [ ] cron-auto-confirm, cron-retry-failed, cron-media-group-sweep, cron-rates.
- [ ] Раскомментировать schedules в 0005_cron.sql.
- [ ] Установить `app.functions_url` и `app.cron_secret` через миграцию.
- [ ] Тесты на каждый cron job.
- [ ] Commit: `feat(cron): all scheduled jobs active`.

### M15: Backup + restore + safety gate

- [ ] cron-backup: weekly суббота 03:00.
- [ ] Safety gate: проверка `system_health.backup_key_confirmed`.
- [ ] `/health backup-confirm` команда для подтверждения.
- [ ] Backup integrity check после каждого upload.
- [ ] `scripts/restore.ts`.
- [ ] Тест: симуляция backup -> integrity check.
- [ ] Commit: `feat(backup): weekly to github releases with safety gate`.

### M16: CI/CD

- [ ] `.github/workflows/test.yml`.
- [ ] `.github/workflows/deploy.yml` с health check + auto-revert on failure.
- [ ] Документация в README по setup GitHub Secrets.
- [ ] **Тест:** сломанная feature-ветка -> tests fail -> PR не мержится.
- [ ] **Тест:** мерж рабочей фичи -> deploy -> health OK.
- [ ] **Тест:** мерж кода ломающего health-public -> auto-revert PR создан -> откат.
- [ ] **Тест:** infinite loop невозможен (метка `[no-auto-revert]` в revert commit).
- [ ] Commit: `feat(ci): test and deploy with auto-revert`.

### M17: DR testing

- [ ] Симуляция: backup -> restore локально через `restore.ts`.
- [ ] Симуляция: revert через GitHub UI.
- [ ] Симуляция: новый Supabase project + restore.
- [ ] README Troubleshooting секция.
- [ ] Commit: `feat(dr): disaster recovery tested`.

### M18: Docs и финал

- [ ] README с инструкциями (включая 5 ручных шагов).
- [ ] BACKLOG.md из раздела 22.
- [ ] Coverage `supabase/functions/` >= 80%.
- [ ] Tag `v1.0.0`.
- [ ] Commit: `docs: readme, backlog, troubleshooting`.

---

## 17. Зависимости

Все через `deno.json` imports map (см. 11.2). Никаких `package.json`, никаких `requirements.txt`.

---

## 18. Тестирование

### 18.1 Подход

- Unit tests через `Deno.test` с моками внешних API (Anthropic, Groq, Telegram, GitHub).
- Integration tests с локальным supabase emulator (опционально, с `RUN_INTEGRATION=1`).
- E2E с реальным Telegram (только локально, не в CI, с `RUN_E2E=1`).

### 18.2 Покрытие

- `supabase/functions/`: >= 80%.
- `_shared/`: >= 90%.
- `webapp/` фронтенд: ручное тестирование.

### 18.3 Фикстуры

`tests/fixtures/`:

- 4 чека JPEG/HEIC.
- 2 voice ogg (ru/uk).
- `parsed_responses.json` для моков Claude.
- `groq_responses.json` для моков Groq.

### 18.4 Обязательные тесты edge cases

- idempotency_edited.
- currency_holidays.
- recurring_eom (4 кейса).
- webapp_cross_user.
- media_group_recovery.
- parse_dates_tz.
- high_amount.

---

## 19. Чеклист самопроверки перед v1.0.0

### Setup

- [ ] `supabase link` + `db push` + `functions deploy` чисто.
- [ ] Webhook зарегистрирован.
- [ ] Mini App открывается с github.io URL.

### Функциональность

- [ ] Голосовое ru/uk создаёт запись < 10 сек.
- [ ] Voice > 5 мин rejected до download.
- [ ] Фото JPEG/HEIC обрабатывается.
- [ ] Альбом обрабатывается через sweep.
- [ ] `/undo` архивирует.
- [ ] Повтор не создаёт дубль.
- [ ] Edited корректно работает.
- [ ] Manual recategorization ставит `corrected_by_user=true`.
- [ ] При сбое внешнего API запись в `pending_retry`, потом подбирается.
- [ ] Mini App работает.
- [ ] Cross-user попытка -> 403.
- [ ] CSV экспорт работает.
- [ ] Per-user/global budget работают.
- [ ] Recurring 31 числа в феврале -> 28/29.
- [ ] High-amount auto-confirm через 60 сек.

### CI/CD

- [ ] Push в feature -> test.yml зелёный.
- [ ] PR в main блокируется при красных.
- [ ] Merge -> deploy -> health 200.
- [ ] Сломанный health -> auto-revert PR создан.
- [ ] Auto-revert не зацикливается.

### Backups и DR

- [ ] Weekly backup в субботу 03:00.
- [ ] Safety gate блокирует без подтверждения.
- [ ] Backup encrypted.
- [ ] Restore локально работает.
- [ ] Integrity check после backup.

### Operations

- [ ] Heartbeat каждую минуту.
- [ ] `/api-health-public` 200.
- [ ] Фото > 90 дней удаляются.
- [ ] Audit log пишется.
- [ ] Retraining в воскресенье 03:00.

---

## 20. Бюджет

| Сервис                    | План                                                                | Стоимость  |
| ------------------------- | ------------------------------------------------------------------- | ---------- |
| Telegram Bot API          | ,                                                                   | бесплатно  |
| Supabase                  | Free (500k Edge Function calls/мес, 500MB БД, 1GB Storage, pg_cron) | бесплатно  |
| Anthropic API             | pay-as-you-go                                                       | $2-5/мес   |
| Groq API                  | pay-as-you-go (whisper-large-v3-turbo)                              | ~$0.50/мес |
| GitHub Pages              | ,                                                                   | бесплатно  |
| GitHub Actions            | Free private repo (2000 мин/мес)                                    | бесплатно  |
| UptimeRobot (опционально) | Free                                                                | бесплатно  |

**Итого: $2.50-5.50/мес.** Mac Mini, VPS, домашний интернет не нужны.

---

## 21. Инструкция для Claude Code

Дословно:

```
Прочитай SPEC.md полностью. Иди по milestones M1...M18 строго по порядку.

После каждого milestone:
1. Проверь acceptance criteria.
2. `deno task test` зелёный.
3. git commit с сообщением из спецификации.
4. Только тогда следующий milestone.

Если что-то неясно, остановись и спроси. Особенно проверь:
- M3 idempotency_edited: hard-delete семантика правильно работает с audit trigger.
- M6 categorizer multilingual: убедись что pipeline name_normalized_en действительно улучшает kNN для русского/украинского.
- M10 media_group: ВСЯ обработка через cron sweep, не через локальный таймер (Edge Functions stateless).
- M14 recurring_eom: проверь 4 кейса.
- M16 auto-revert: тест что infinite loop невозможен через метку [no-auto-revert].

Стек строго из раздела 2. Не возвращай Python/Mac Mini/локальный Whisper. Не используй em-dash.

В конце:
- Push в main, проверь что deploy зелёный.
- Финальный отчёт с coverage, открытыми TODO, готовностью к первому setup_telegram_webhook.ts вызову.
```

---

## 22. Backlog (не делать в v1)

В `BACKLOG.md`:

- Виджеты дашборда: прогноз, сравнение периодов, средний чек.
- Бюджеты на категории + алерты.
- Сплиты.
- Возвраты товара.
- Импорт банковских CSV.
- Excel экспорт с pivot.
- RLS на Supabase для multi-tenancy.
- Voice > 5 мин с разбиением (Groq long-form).
- Полнотекстовый поиск pg_trgm.
- Тэги в дополнение к категориям.
- Параллельные пайплайны для семей > 5.
- Pre-confirm категории при confidence 0.5-0.7.
- Telegram inline mode.
- Multilingual embedder (свой контейнер с paraphrase-multilingual-MiniLM-L12-v2 через self-hosted
  Supabase, или замена на API Voyage).
- Mirror git push в GitLab для DR.
- Sentry/PostHog для error tracking.
- LLM Llama/Mistral через Supabase.ai (когда выйдет из beta).

---

Конец SPEC.md (v6)
