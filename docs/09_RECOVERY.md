# 09 RECOVERY, disaster recovery

## 1. Матрица сценариев

| Сценарий                                    | RTO      | Action                                                                                                        |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| Bug в новой функции, health check fail      | < 5 мин  | Auto-revert workflow создаёт revert commit + redeploy                                                         |
| Один Edge Function упал runtime error       | < 2 мин  | Supabase auto-restart на следующем запросе. Если повторяется - rollback через CI                              |
| Supabase project заблокирован/удалён        | < 2 часа | Новый Supabase project + restore из последнего backup + setWebhook + redeploy                                 |
| Telegram bot токен скомпрометирован         | < 30 мин | Новый bot через BotFather + replace TELEGRAM_BOT_TOKEN в secrets + setWebhook + setMyCommands                 |
| GitHub repo удалён                          | < 30 мин | Локальный клон (всегда есть на разработческой машине) + push в новый repo + mirror в GitLab если был          |
| Backup encryption key потерян               | критично | Бэкапы безвозвратны, см. раздел "Safety gate"                                                                 |
| pg_cron не выполняет задачи                 | < 30 мин | Re-schedule: unschedule + schedule снова. Проверка GUC `app.functions_url`                                    |
| Storage bucket недоступен                   | < 1 час  | Re-create через миграцию или CLI, восстановить из backup если фото критичны                                   |
| webhook отвалился (Telegram перестал слать) | < 10 мин | `getWebhookInfo` -> найти ошибку -> исправить URL/secret -> `setWebhook` снова с `drop_pending_updates: true` |

## 2. Auto-revert (M16)

Триггер: deploy workflow упал на step "Health check".

Шаги (выполняются автоматически):

1. Job `auto-revert-on-failure` стартует с
   `if: failure() && !contains(github.event.head_commit.message, '[no-auto-revert]')`.
2. Checkout с `fetch-depth: 2`.
3. `git revert HEAD --no-edit`.
4. Amend commit message с пометкой `[no-auto-revert]` чтобы не зациклиться.
5. `git push origin main`.
6. Push триггерит deploy.yml снова, но уже с предыдущей версией кода.
7. Health check проходит, всё ок.

**Проверка инвариантов:**

- Если revert тоже сломает health (например, корень проблемы в БД, а не в коде): второй deploy
  упадёт с тем же health fail. `[no-auto-revert]` метка предотвратит **третий** ревёрт (т.е. ревёрт
  ревёрта). Дальше Claude Code (или Серхий) должен вручную разбираться.

## 3. Backup структура

`cron-backup` (M15) каждую субботу в 03:00 UTC экспортирует все таблицы в JSON, gzip, шифрует через
age, заливает в GitHub Releases как asset.

Asset name: `finbot-backup-YYYY-MM-DD.json.gz.age`.

Release tag: `backup-YYYY-MM-DD`.

Содержимое:

```json
{
  "version": 1,
  "exported_at": "2026-05-18T03:00:00Z",
  "schema_version": 8,
  "tables": {
    "family_members": [...],
    "categories": [...],
    "expenses": [...],
    "receipts": [...],
    "expense_audit": [...],
    "exchange_rates": [...],
    "recurring_expenses": [...],
    "anthropic_usage": [...],
    "message_log": [],
    "pending_retry": [],
    "media_group_buffer": []
  }
}
```

`message_log`, `pending_retry`, `media_group_buffer` экспортируются пустыми (это runtime state, не
данные).

`anthropic_usage` экспортируется только последние 90 дней (для аудита costs).

## 4. Restore (scripts/restore.ts)

Локальный скрипт, не Edge Function. Запускается на разработческой машине пользователя или Claude
Code, требует доступ к private age key.

### 4.1 Usage

```bash
# Подготовка
export SUPABASE_PROJECT_REF=...
export SUPABASE_DB_URL="postgresql://postgres:<password>@db.<project_ref>.supabase.co:5432/postgres"

# Запуск
deno run --allow-all scripts/restore.ts --tag=backup-2026-05-18
```

### 4.2 Логика

1. Запрос `gh release download <tag>` -> файл `.json.gz.age` в `/tmp/restore/`.
2. Запрос у пользователя age private key (через stdin, не через env): "Paste age private key (one
   line):". Прочитать `AGE-SECRET-KEY-...`.
3. Decrypt через age:
   ```typescript
   import { decrypt } from "npm:age-encryption@0.1.4";
   const decrypted = await decrypt({ identity: privateKey, data: encryptedBytes });
   ```
4. Decompress gzip через `DecompressionStream("gzip")`.
5. JSON parse.
6. Schema version check. Если несовместима с текущим SPEC - предупредить.
7. Для каждой таблицы в порядке зависимостей (family_members -> categories -> receipts -> expenses
   -> expense_audit -> ...):
   - `prompt("Truncate <table> and restore N rows? [y/N]: ")`.
   - Если y: `truncate table <name> cascade; insert into <name> ... values (...), (...), ...`.
   - Если n: skip.
8. После всех таблиц: `select setval(...)` для всех serial столбцов (если есть).
9. Прогон базовых sanity checks: count categories == 17, count family_members > 0, count expenses
   > 0.

### 4.3 Безопасность restore

- Скрипт **никогда** не берёт private key из env или config. Только stdin. Это защита от утечки.
- Скрипт **не сохраняет** private key никуда. После использования - в памяти.
- Для каждой таблицы отдельное подтверждение, чтобы случайно не снести что-то.

## 5. Safety gate для backup

`cron-backup` проверяет `system_health.backup_key_confirmed` перед записью первого бэкапа. Если
false - early return + log warning + (опционально) alert админу.

Почему: чтобы предотвратить ситуацию когда автоматические бэкапы начались, age private key потерян,
и через 3 месяца обнаруживается что вся история нерасшифровываема.

Workflow:

1. После M15 Claude Code в финальном отчёте напомнит Серхию выполнить `/health backup-confirm` в
   Telegram.
2. Серхий проверяет что age-secret-key.txt физически лежит в 1Password (или другом trusted PW
   manager).
3. Шлёт боту `/health backup-confirm`.
4. Бот: `update system_health set backup_key_confirmed = true`.
5. Со следующей субботы бэкапы пишутся.

**До подтверждения** бэкапы не пишутся, и в логах есть запись об этом каждую субботу.

## 6. Восстановление Supabase project

Сценарий: Supabase проект заблокирован/удалён (нарушение TOS, забыли продлить, etc.).

1. Создать новый Supabase project (Frankfurt, тот же план).
2. Новые `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`.
3. Обновить GitHub secrets:
   ```bash
   gh secret set SUPABASE_PROJECT_REF --body "<new_ref>"
   gh secret set SUPABASE_DB_PASSWORD --body "<new_password>"
   ```
4. Локально:
   ```bash
   supabase link --project-ref <new_ref>
   supabase secrets set --env-file .env  # перенести бот-секреты
   supabase db push  # применить миграции
   ```
5. Запустить `scripts/restore.ts --tag=<latest backup>`.
6. Webhook:
   ```bash
   deno run --allow-net --allow-env scripts/setup_telegram_webhook.ts
   ```
   Скрипт прочитает `TELEGRAM_BOT_TOKEN` и новый `SUPABASE_PROJECT_REF` из env и зарегистрирует
   новый webhook URL.
7. Mini App URL: обновить в BotFather (`/setmenubutton`), если изменился (но GitHub Pages URL не
   изменится, так что обычно не нужно).
8. Sanity check: `/start` боту, `/dashboard`, проверить что данные на месте.

## 7. Восстановление Telegram bot

1. BotFather -> `/newbot` -> новый бот, новый токен.
2. `/setcommands` (см. SPEC §12.4 commands list).
3. `/setmenubutton` -> Mini App URL (тот же если webapp не переехала).
4. Локально:
   ```bash
   sed -i.bak "s|TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=<new_token>|" .env
   supabase secrets set --env-file .env
   ```
5. Запустить `setup_telegram_webhook.ts` (новый URL содержит новый токен в query).
6. **Family members:** их `telegram_id` те же (это ID пользователей, не ID бота), они должны просто
   добавить нового бота в свой чат-лист и `/start`.

## 8. GitHub repo удалён

Маловероятно (приватный, в руках пользователя), но runbook:

1. Локальный клон у Серхия на машине - source of truth.
2. `gh repo create finbot --private --source=. --remote=origin --push`.
3. Обновить GitHub secrets (они привязаны к репо).
4. Включить branch protection (`docs/08_DEPLOY.md` раздел 3).
5. Включить Pages.
6. Push - workflows должны заработать.
7. `cron-backup` upload location нужно обновить если `GITHUB_REPO` в Supabase secrets изменился:
   `supabase secrets set GITHUB_REPO=<user>/<new_repo>`.

## 9. pg_cron не работает

Симптом: `system_health.last_seen` не обновляется > 5 минут (если у тебя UptimeRobot настроен,
прилетит алерт).

Чек:

1. `psql "$SUPABASE_DB_URL" -c "select jobname, schedule, active, last_run_started_at from cron.job left join cron.job_run_details on jobid = cron.job.jobid"`.
2. Если `last_run_started_at` старый или null:
   - `select cron.unschedule(jobname)` для всех.
   - `select cron.schedule(...)` снова из миграции 0008.
3. Если `app.functions_url` не установлен:
   ```bash
   psql -c "alter database postgres set app.functions_url = 'https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1'"
   psql -c "alter database postgres set app.cron_secret = '${CRON_SECRET}'"
   ```
4. После обновления GUC: убедиться что новые джобы их подхватят (могут требовать reconnect).

## 10. Полная пересборка с нуля (последний резерв)

Если что-то совсем плохо и быстрее пересобрать:

1. Backup в надёжном месте уже есть.
2. New Supabase project.
3. Локально:
   ```bash
   git pull origin main
   cp .env.example .env
   # заполнить .env с новыми Supabase + старыми Telegram/Anthropic/Groq/GitHub секретами
   supabase link --project-ref <new>
   supabase secrets set --env-file .env
   supabase db push
   supabase functions deploy
   deno run --allow-all scripts/setup_telegram_webhook.ts
   deno run --allow-all scripts/restore.ts --tag=<latest>
   ```
4. Sanity.

RTO ~ 1-2 часа.

## 11. Тестирование DR (M17)

Без живых данных пройти каждый сценарий хотя бы один раз:

- [ ] Симуляция backup -> restore локально на тестовую БД.
- [ ] Симуляция revert через CLI и через UI.
- [ ] Симуляция полной пересборки в новый Supabase project (опционально, требует второй project;
      можно описать в runbook без реального прогона).

## 12. Логирование DR событий

При любом DR-событии (auto-revert сработал, restore выполнен, и т.д.) - запись в `expense_audit` с
`action='system_event'` (отдельная категория, добавь в check constraint если нужно), либо в
отдельную таблицу `system_events` (создай миграцию если решишь). Для v1 достаточно логов Supabase
Functions.

---

Конец 09_RECOVERY.md.
