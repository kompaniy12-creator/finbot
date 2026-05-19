# FinBot v6

Семейный Telegram-бот для учёта расходов через голос, фото чеков и текст.
Полностью serverless: Supabase Edge Functions (Deno + TypeScript) + Postgres + Mini App дашборд на
GitHub Pages.

Источник правды по продукту: [SPEC.md](SPEC.md).

## Что умеет

- **Текст:** «кофе 12 zł и булочка 5 zł» -> 2 expense-строки, Claude парсит, gte-small embedding
  выбирает категорию (kNN с fallback на Claude), курс PLN из NBP/exchangerate.host.
- **Голос:** voice <= 5 мин -> Groq Whisper (auto-detect ru/uk/pl/en) -> тот же текстовый pipeline.
- **Фото чека:** JPEG/PNG -> Storage -> Claude Sonnet 4.6 Vision -> reconcile +/- 5% -> receipt +
  expenses сгруппированные по категориям. HEIC в v1 отклоняется с подсказкой.
- **Альбом фото:** буферизация + cron sweep каждые 2 минуты, до 5 фото на альбом.
- **High-amount > 200 PLN:** инлайн-кнопки Да/Изменить/Отмена, auto-confirm через 60 сек.
- **Edited messages:** archive audit + hard-delete + re-pipeline.
- **/start /help /categories /dashboard /history /undo /stats** + admin **/health /audit
  /health backup-confirm**.
- **Mini App дашборд:** KPI, donut по категориям, line по дням, top-5, поиск, CSV export.
- **Cron:** heartbeat (1m), auto-confirm (1m), retry-failed (5m), media-group-sweep (2m),
  rates-daily (05:00), recurring-daily (07:00), anomaly-daily (08:00), retention-daily (02:30),
  retraining-weekly (Sun 03:00), backup-weekly (Sat 03:00).

## Стек

- **Backend:** Supabase Edge Functions (Deno 2.7 runtime), TypeScript strict
- **Telegram:** grammy@1.42.0 webhook
- **AI:** Anthropic SDK 0.96 (Haiku 4.5 / Sonnet 4.6), Groq SDK 1.2 (Whisper),
  Supabase.ai gte-small embeddings
- **DB:** Postgres 17 + pgvector + pg_cron + pg_net
- **Frontend:** vanilla HTML/JS + Chart.js 4.4 на GitHub Pages
- **CI/CD:** GitHub Actions с auto-revert на failed health check
- **Backups:** weekly age-encrypted gzip JSON dump to GitHub Releases (12-week retention)

## Архитектура (ASCII)

```
                     +-------------------+
   Telegram -------> | Edge: tg-webhook  | --- writes ---> Postgres + Storage
   (user)            +-------------------+
                              |
                              +--> Anthropic API
                              +--> Groq API
                              +--> NBP / exchangerate.host
                              +--> Supabase.ai gte-small

   GitHub Pages
   (Mini App) ---HTTPS+initData---> Edge: api-{me|stats|transactions|...}
                                              |
                                              v
                                          Postgres

   pg_cron --(http_post)--> Edge: cron-{recurring|retention|anomaly|...}
                                              |
                                              v
                                          Postgres
                                              |
   cron-backup -age encrypt-> GitHub Releases (weekly)
```

## Quick start (для нового владельца)

1. Прочитать [QUICKSTART.md](QUICKSTART.md) и [SPEC.md](SPEC.md).
2. Создать собственный Supabase проект (или работать в shared-org mode, см. CLAUDE.local.md).
3. Подготовить ключи и положить в `.env`:
   ```bash
   cp .env.example .env  # отредактировать
   make validate-env
   ```
4. Деплой:
   ```bash
   make bootstrap        # установить deno, supabase, gh, age
   make secrets-push     # залить .env в Supabase secrets
   make deploy           # apply_migration.sh для всех миграций + functions deploy
   make webhook-set      # зарегистрировать Telegram webhook
   ```
5. В Telegram открыть бота, отправить `/start`, добавить остальных членов семьи (см. setup-once функцию).
6. После сохранения age private key в 1Password: отправить боту `/health backup-confirm` чтобы
   разблокировать weekly backups.

## GitHub Actions secrets (для CI/CD)

```bash
gh secret set SUPABASE_ACCESS_TOKEN  # sbp_...
gh secret set SUPABASE_PROJECT_REF   # короткий ref проекта Supabase
gh secret set CRON_SECRET            # тот же, что в .env
```

## Disaster recovery

| Сценарий | Действия |
|---|---|
| **Bug в новой функции** | `deploy.yml` health-check fail -> auto-revert PR создаётся автоматически (помечен `[no-auto-revert]` чтобы не зациклиться). |
| **Edge Function упал** | Supabase auto-restart. Cron `cron-retry-failed` каждые 5 мин подберёт зависшие сообщения из `pending_retry`. |
| **Supabase project заблокирован / удалён** | 1) Создать новый Supabase project. 2) Обновить `SUPABASE_PROJECT_REF` в `.env` и GitHub Actions secrets. 3) `make deploy` (миграции через apply_migration.sh, функции через --project-ref). 4) Скачать последний `backup-YYYY-MM-DD` release с GitHub, расшифровать `AGE_PRIVATE_KEY=... deno run --allow-net --allow-env --allow-read scripts/restore.ts`. 5) `make webhook-set`. |
| **Telegram бот заблокирован** | `/newbot` в BotFather, обновить `TELEGRAM_BOT_TOKEN` в `.env` + Supabase secrets + GitHub secrets, `make webhook-set`. |
| **GitHub репо удалён** | Локальный клон + последний backup = достаточно. Создать новый репо, `git remote add`, `git push --all`, re-set secrets. |
| **Age private key потерян** | Backups в GitHub Releases становятся НЕДЕШИФРУЕМЫМИ. Поэтому safety gate из §9.4: cron-backup пишет только после `/health backup-confirm` (после того как пользователь сохранил приватный ключ). |
| **pg_cron не выполняет задачи** | Supabase Dashboard -> Database -> Cron. Или через Management API: `SELECT jobname, schedule, active FROM cron.job`. Если jobs отсутствуют, `bash scripts/apply_migration.sh supabase/migrations/0008_cron_activate.sql`. |

## Backup safety gate

`cron-backup` запускается раз в неделю (суббота 03:00), но **не пишет ничего** пока
`system_health.backup_key_confirmed = false`. Это страховка: пользователь должен сначала
сохранить `AGE-SECRET-KEY-...` в password manager, и подтвердить это в боте командой
`/health backup-confirm`. После этого backup идёт нормально.

## Development

```bash
deno task test       # юнит-тесты
deno task fmt        # форматирование
deno task lint       # lint
deno task check      # type-check Edge Functions
make coverage        # coverage отчёт
```

Интеграционные тесты (бьют живой Supabase):
```bash
set -a && source .env && set +a
RUN_INTEGRATION=1 deno task test
```

## Документация

- [SPEC.md](SPEC.md) - источник правды по продукту (v6 final).
- [CLAUDE.md](CLAUDE.md), [CLAUDE.local.md](CLAUDE.local.md) - operational contract для
  Claude Code (v1.2 shared-org mode).
- [BACKLOG.md](BACKLOG.md) - фичи на v2.
- [docs/](docs/) - playbook, runbook'и, troubleshooting, prompts, checklists, deploy, recovery.

## Limitations / known issues (v1.0.0)

- **HEIC чеки:** не поддерживаются. Пользователь iOS должен переключить «Камера -> Форматы ->
  Совместимый» или экспортировать как JPEG. v1.1 добавит конверсию через `magick-wasm`.
- **GitHub Pages для private repo:** требует GitHub Pro. Mini App URL не работает на free
  плане. Workaround: сделать repo public (Mini App код безопасен - вся auth через Telegram
  initData HMAC + Supabase API + SUPABASE_URL+ANON_KEY в коде это публичные) ИЛИ поднять на
  Netlify/Cloudflare Pages.
- **ALL currency:** exchangerate.host v2 требует API ключ. Курсы для ALL не подхватываются.
  Workaround: вручную добавить курс в `exchange_rates` или сменить провайдера.
- **Shared-org mode:** проект работает в общей Supabase БД с `Twoja Decyzja` prod tables.
  Все DDL операции защищены blacklist (см. `scripts/apply_migration.sh`).
- **DB password:** не сбрасывался, чтобы не сломать другие приложения. Все SQL операции идут
  через Management API query endpoint. `supabase link --password` не используется ни локально,
  ни в CI.

## Версия

v1.0.0 - 2026-05-19.
