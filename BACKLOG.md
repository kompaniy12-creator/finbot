# BACKLOG, фичи отложенные на v2+

Из SPEC §22 (v6).

## Дашборд

- Прогноз трат на месяц на основе истории.
- Сравнение периодов (этот месяц vs прошлый, год vs год).
- Средний чек на категорию.

## Финансовые фичи

- Бюджеты на категории + алерты при приближении/превышении.
- Сплиты (одна трата делится между членами семьи).
- Возвраты товара (отрицательная сумма со ссылкой на оригинал).
- Импорт банковских CSV (mBank, ING, PKO).
- Excel экспорт с pivot-таблицами.

## Архитектура

- RLS на Supabase для multi-tenancy (если делать публичную SaaS-версию).
- Параллельные пайплайны для семей > 5 человек.
- Mirror git push в GitLab для DR.

## Voice/Vision

- Voice > 5 мин с разбиением (Groq long-form transcription).
- Pre-confirm категории при confidence 0.5-0.7 (вместо авто-выбора).

## Поиск и UX

- Полнотекстовый поиск по описаниям через pg_trgm.
- Тэги в дополнение к категориям (#дача, #командировка).
- Telegram inline mode.

## AI / ML

- Multilingual embedder (свой контейнер с `paraphrase-multilingual-MiniLM-L12-v2`, либо API Voyage).
- LLM Llama/Mistral через Supabase.ai когда выйдет из beta (вместо Anthropic, для удешевления).

## Observability

- Sentry/PostHog для error tracking.

## Не делать никогда

- Возврат к Mac Mini / VPS / self-hosted runner. Архитектура serverless закреплена.
- Возврат к Python + aiogram. Стек TypeScript + grammy финален.
- Локальный Whisper / локальный embedder / SQLite. Только cloud + Postgres.
