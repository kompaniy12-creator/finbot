# FinBot v6

Семейный Telegram-бот для учёта расходов через голос, фото чеков и текст.

Полностью serverless: Supabase Edge Functions (Deno + TypeScript) + Postgres + Mini App дашборд на
GitHub Pages. Подробное ТЗ в [SPEC.md](SPEC.md).

## Стек

- **Backend:** Supabase Edge Functions (Deno runtime), TypeScript strict
- **Telegram:** grammy webhook
- **AI:** Anthropic Claude Haiku 4.5 / Sonnet 4.6 (vision), Groq Whisper, Supabase.ai gte-small
  embeddings
- **DB:** Postgres + pgvector + pg_cron
- **Frontend:** vanilla HTML/JS + Chart.js на GitHub Pages
- **CI/CD:** GitHub Actions с auto-revert на failed health check

## Quick start

См. [QUICKSTART.md](QUICKSTART.md). После настройки ключей `cd finbot && make help`.

## Документация

- [SPEC.md](SPEC.md)  -  источник правды
- [CLAUDE.md](CLAUDE.md), [CLAUDE.local.md](CLAUDE.local.md)  -  operational contract для Claude Code
- [BACKLOG.md](BACKLOG.md)  -  фичи на v2
- [docs/](docs/)  -  playbook, runbook'и, troubleshooting

## Развёртывание

Подробно в `docs/08_DEPLOY.md`. Если коротко:

```bash
make bootstrap        # установить deno, supabase, gh, age
make validate-env     # проверить .env
make secrets-push     # залить секреты в Supabase
make deploy           # миграции + Edge Functions
make webhook-set      # зарегистрировать Telegram webhook
```

## Mini App

`https://kompaniy12-creator.github.io/finbot/webapp/`  -  открывается через Telegram бота, кнопка "📊
Дашборд".

## Версия

v1.0.0 (в процессе сборки)
