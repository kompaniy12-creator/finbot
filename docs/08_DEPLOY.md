# 08 DEPLOY, детали CI/CD и инфраструктуры

## 1. Высокоуровневая схема

```
[Локальная машина / Claude Code]
        |
        | git push
        v
[GitHub repo (private)]
        |
        +--> Test workflow (на push в любую ветку)
        |       deno fmt --check, lint, check, test
        |
        +--> Deploy workflow (на push в main)
                |
                +--> Apply migrations (supabase db push)
                +--> Deploy functions (supabase functions deploy)
                +--> Health check (curl api-health-public, expect 200)
                +--> Deploy webapp (peaceiris/actions-gh-pages -> gh-pages branch)
                |
                +--> При failure: auto-revert workflow (создаёт revert commit)
        |
        v
[GitHub Pages]                          [Supabase]
  https://<user>.github.io/<repo>/        Edge Functions
                                          Postgres + pgvector
                                          Storage (receipts bucket)
                                          pg_cron schedules
        ^                                        ^
        | загружает Mini App                     | webhook https://...supabase.co/functions/v1/tg-webhook
        |                                        |
[Семья в Telegram] ----------------------------> [Telegram]
```

## 2. Setup GitHub Secrets

Через `gh` CLI после M1 (создания репо):

```bash
gh secret set SUPABASE_ACCESS_TOKEN --body "$SUPABASE_ACCESS_TOKEN"
gh secret set SUPABASE_PROJECT_REF --body "$SUPABASE_PROJECT_REF"
gh secret set SUPABASE_DB_PASSWORD --body "$SUPABASE_DB_PASSWORD"

# Проверка
gh secret list
```

`GITHUB_TOKEN` для workflow доступен автоматически как `${{ secrets.GITHUB_TOKEN }}`
(предоставляется GitHub Actions runner), отдельно его ставить не нужно.

## 3. Setup Branch Protection

```bash
gh api -X PUT "/repos/$GITHUB_REPO/branches/main/protection" \
  --input - <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["test"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

`enforce_admins: false` критично, иначе ты (как admin репо) не сможешь мержить через
`gh pr merge --admin` если будет нужно.

## 4. Включение Actions write permissions

Auto-revert workflow требует `contents: write`. Через API:

```bash
gh api -X PUT "/repos/$GITHUB_REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=write \
  -F can_approve_pull_request_reviews=false
```

## 5. GitHub Pages

После первого deploy webapp/ в ветку gh-pages, нужно один раз включить Pages:

```bash
gh api -X POST "/repos/$GITHUB_REPO/pages" \
  --input - <<EOF
{
  "source": {
    "branch": "gh-pages",
    "path": "/"
  }
}
EOF
```

Если уже включено - 409, игнорируй.

После первого включения URL: `https://<github-username>.github.io/<repo-name>/`.

## 6. test.yml (полный)

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

      - name: Format check
        run: deno fmt --check

      - name: Lint
        run: deno lint

      - name: Type check
        run: deno check supabase/functions/**/*.ts

      - name: Test
        run: deno task test

      - name: Coverage
        run: |
          deno test --allow-all --coverage=cov tests/
          deno coverage cov --include="supabase/functions/" | tail -5
```

## 7. deploy.yml (полный, с auto-revert)

```yaml
name: Deploy

on:
  push:
    branches: [main]

permissions:
  contents: write
  pages: write
  id-token: write
  actions: write

concurrency:
  group: deploy-main
  cancel-in-progress: false

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
        run: |
          supabase link \
            --project-ref ${{ secrets.SUPABASE_PROJECT_REF }} \
            --password ${{ secrets.SUPABASE_DB_PASSWORD }}

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
          sleep 15
          STATUS=$(curl -s -o /tmp/health.json -w "%{http_code}" \
            "https://${{ secrets.SUPABASE_PROJECT_REF }}.supabase.co/functions/v1/api-health-public")
          echo "status=$STATUS" >> "$GITHUB_OUTPUT"
          if [ "$STATUS" != "200" ]; then
            echo "::error::Health check failed: $STATUS"
            cat /tmp/health.json || true
            exit 1
          fi
          echo "Health: $STATUS"

  deploy-webapp:
    runs-on: ubuntu-latest
    needs: deploy-functions
    steps:
      - uses: actions/checkout@v4

      - name: Inject API URL
        run: |
          sed -i "s|__SUPABASE_FUNCTIONS_URL__|https://${{ secrets.SUPABASE_PROJECT_REF }}.supabase.co/functions/v1|g" webapp/app.js

      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./webapp
          publish_branch: gh-pages

  auto-revert-on-failure:
    runs-on: ubuntu-latest
    needs: deploy-functions
    if: failure() && !contains(github.event.head_commit.message, '[no-auto-revert]')
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Revert last commit
        run: |
          git config user.name "FinBot CI"
          git config user.email "ci@finbot.local"
          MSG="Revert: deploy failed, auto-reverting last commit. [no-auto-revert]"
          git revert --no-edit HEAD
          # Amend the revert commit to include [no-auto-revert] marker
          git commit --amend -m "$MSG"
          git push origin main
```

### Инъекция URL в webapp/app.js

В исходном `webapp/app.js` используй placeholder:

```javascript
const FUNCTIONS_URL = "__SUPABASE_FUNCTIONS_URL__";
```

Workflow заменяет на реальный URL. Это позволяет не хранить URL в репо и поддерживает разные
environments если потребуется.

Альтернатива - читать из `<meta name="supabase-functions-url" content="...">` в `index.html`, тогда
`sed` правит HTML. Любой вариант ок, главное - один источник правды.

## 8. Post-deploy verification

После `gh pr merge` Claude Code делает:

```bash
# Дождаться завершения workflow
gh run watch

# Проверить статус последнего deploy
gh run list --workflow=deploy.yml --limit=1

# Если failure: посмотреть логи
gh run view --log-failed
```

Если deploy зелёный, дополнительно:

```bash
# Webhook отвечает
curl -fsS "https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/tg-webhook?secret=${TELEGRAM_BOT_TOKEN}" \
  -X POST -H "Content-Type: application/json" \
  -d '{"update_id":1,"message":{"message_id":1,"date":1700000000,"chat":{"id":1,"type":"private"},"from":{"id":1,"is_bot":false,"first_name":"Test"},"text":"/start"}}' \
  -o /dev/null -w "%{http_code}\n"
# Должно быть 200 (бот может вернуть 200 даже если юзер unauthorized, главное что endpoint живой)

# Public health
curl -fsS "https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/api-health-public" -o - -w "\nHTTP %{http_code}\n"

# Webapp accessible
curl -fsS "https://${GITHUB_USERNAME}.github.io/${REPO_NAME}/" -I | head -1
# HTTP/2 200
```

## 9. Migrations особенности

### 9.1 Идемпотентность

Все миграции должны быть идемпотентны (можно применить дважды без эффекта):

```sql
create table if not exists ...
create index if not exists ...

-- Для функций - всегда create or replace
create or replace function ...

-- Для триггеров - drop + create
drop trigger if exists trg_X on table;
create trigger trg_X ...

-- Для cron jobs - unschedule + schedule
do $$
begin
  perform cron.unschedule('jobname');
exception when others then null;
end$$;
select cron.schedule('jobname', ...);
```

### 9.2 Порядок

Supabase применяет миграции по имени файла лексикографически. Префикс `0001_`, `0002_` обеспечивает
порядок.

Новая миграция всегда с большим номером, например `0008_cron_activate.sql` после
`0007_seed_init.sql`. **Никогда не редактируй уже применённые миграции**, всегда новая.

### 9.3 Большие изменения данных

Не делай в миграции `update expenses set ...` на миллионы строк. Это блокирует БД. Для миграций
данных - отдельный одноразовый Edge Function (как `setup-once` в M2).

## 10. Логи

```bash
# Конкретная функция, tail
supabase functions logs tg-webhook --tail

# Все функции, history
supabase functions logs --since=1h

# Конкретный invocation (по request_id из заголовка ответа)
supabase functions logs tg-webhook --request-id=<id>
```

Structured JSON логи Claude Code пишет через `console.log(JSON.stringify({...}))`. В Supabase
Dashboard -> Logs Explorer можно фильтровать по полям.

## 11. Manual deploy (когда CI сломан)

Если очень нужно задеплоить вручную (например, чинишь сам CI):

```bash
make secrets-push
make deploy
make webhook-set  # только если webhook URL изменился
```

И push webapp вручную:

```bash
git subtree push --prefix webapp origin gh-pages
```

Делай это только в режиме починки. Нормальный flow - через PR в main.

## 12. Откат

### 12.1 Через UI

GitHub UI -> Pull Requests -> закрытый PR -> Revert. Создаст новую PR с реверт-коммитом. Замержить.

### 12.2 Через CLI

```bash
git log --oneline | head -5  # найти SHA для отката
git revert <SHA> --no-edit
git push origin main
```

### 12.3 Восстановление БД

См. `docs/09_RECOVERY.md` раздел про `scripts/restore.ts`.

## 13. Стоимость

В рамках Free tier для маленькой семьи (2-5 человек, ~100 трат/мес):

- Supabase Free: 500k Edge Function calls/мес, 500MB DB, 1GB Storage. Хватает с большим запасом.
- GitHub Free: private repo, 2000 Actions minutes/мес. Deploy один раз на push, ~2 минуты. С
  запасом.
- GitHub Pages: бесплатно для public и для private repo до 1GB.
- Anthropic: ~$2-5/мес.
- Groq: ~$0.50/мес (на whisper-large-v3-turbo: $0.04/час, активного аудио ~10 часов/мес).
- Telegram: бесплатно.
- UptimeRobot Free (опционально): бесплатно.

**Итого: $2.50 - 5.50 в месяц.**

---

Конец 08_DEPLOY.md.
