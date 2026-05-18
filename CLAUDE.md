# CLAUDE.md, инструкции для Claude Code (главный файл)

Ты, Claude Code, реализуешь проект FinBot v6 от начала до конца **полностью автономно**.
Пользователь (Серхий) запустил сессию, передал тебе ключи в первом сообщении и ушёл. Он вернётся
только когда ты пришлёшь финальный отчёт о готовности v1.0.0, или когда ты доложил по чёткому
правилу из раздела "Когда останавливаться и спрашивать" ниже.

Этот документ это твой OPERATIONAL CONTRACT. Источник правды по содержанию продукта это `SPEC.md`
(его передаёт пользователь, он же лежит рядом). Документы в `docs/` это твои runbooks: bootstrap,
playbook, conventions, testing, troubleshooting, prompts, checklists, deploy, state, glossary.

## 0. Первое, что ты делаешь в сессии

1. Прочитай этот файл целиком (CLAUDE.md).
2. Прочитай `SPEC.md` целиком, один раз. Это база.
3. Прочитай `docs/00_AUTONOMY.md` (контракт автономии).
4. Прочитай `docs/01_BOOTSTRAP.md` (что собирать у пользователя в первом ответе).
5. Прочитай `docs/02_PLAYBOOK.md` (детальные шаги M1...M18).
6. Прочитай `docs/13_AGENTS.md` (когда использовать каких субагентов).
7. Прочитай `docs/14_HOOKS_AUTOMATION.md` (как тебя защищают hooks).
8. Прочитай `docs/STATE.md` если он существует (восстановление после перезапуска сессии).
9. Остальные документы (`docs/03` до `docs/12`, `docs/15`) читай по мере необходимости, ссылки на
   них есть в playbook.
10. **Если** `docs/STATE.md` **существует и говорит, что работа уже начата**: переходи в режим
    resume (раздел "Resume protocol" ниже).
11. **Если нет**: переходи в режим bootstrap. Запроси у пользователя все ключи одним списком (см.
    `docs/01_BOOTSTRAP.md`), сохрани их в `.env`, проверь валидность через
    `bash scripts/validate_env.sh`, дальше иди по playbook.

## 1. Базовые правила поведения

### 1.1 Автономия

- Не спрашивай разрешения на bash-команды, файлы, git-операции, supabase CLI, gh CLI, curl.
  Пользователь дал явное согласие в `docs/00_AUTONOMY.md`. Действуй.
- Не уточняй "продолжать?" на каждом шаге. Просто продолжай, пока не упрёшься в правило из раздела
  "Когда останавливаться".
- Если что-то непонятно в спецификации, **сначала перечитай нужный раздел SPEC.md**, потом
  `docs/06_PROMPTS.md` или `docs/10_GLOSSARY.md`. Только если правда нет ответа в документах -
  остановись и спроси одним конкретным вопросом.
- Не выдумывай решения по архитектуре или стеку. Стек жёстко зафиксирован в SPEC §2 и SPEC §11.2.

### 1.2 Стиль кода и текста

- TypeScript strict mode везде.
- Zod-схемы для границ (input/output API, парсинг Claude, парсинг внешних API).
- Structured logging через `console.log(JSON.stringify({ ... }))`.
- **Никаких em-dash (U+2014).** В любом тексте, коде, комментариях, коммит-сообщениях, документах.
  Используй запятую, скобки, двоеточие, точку с запятой, или короткий дефис "-".
- Импорты только через `npm:` и `jsr:` с фиксированными версиями (см. `deno.json` в SPEC §11.2).
  Никаких `https://deno.land/x/...`.
- `Deno.serve(...)` напрямую. Не `import { serve } from "std/http/server.ts"`.
- Утилиты только в `supabase/functions/_shared/`, импортируются по относительному пути. Никаких
  cross-dependencies между функциями.
- Файловая система Edge Functions: только `/tmp` для временных файлов.
- Coverage `supabase/functions/` должен быть **>= 80%**, `_shared/` >= 90%.

### 1.3 Git и коммиты

- После каждого milestone один коммит с conventional commit message, точно как в SPEC §16.
- Один коммит = один логический шаг. Тесты идут в том же коммите, что и код, который они проверяют.
- Никаких force push в main. Работаешь на ветках `feature/m<N>-<short-name>`, мерж в main делаешь
  сам через GitHub CLI (`gh pr create --fill --squash` после прохождения CI), но **только если CI
  зелёный**.
- Если ты ещё не настроил CI (до M16), коммитишь напрямую в main. После M16 - через feature
  branches.

### 1.4 Тесты

- Тесты пишутся **параллельно** с кодом, не в конце. После каждой реализованной функции пишешь её
  тест.
- Локально гоняешь `deno task test` после каждого изменения, прежде чем коммитить.
- Если тест красный - чинишь, не мержишь.
- Моки внешних API в `tests/fixtures/`. Никогда не дёргаешь реальные Anthropic/Groq/Telegram в
  Deno.test (если только не выставлен `RUN_E2E=1`).

### 1.5 Безопасность

- Никогда не коммить `.env`, любые ключи, токены, age-private. `.gitignore` обновляй сразу.
- Все секреты идут в Supabase secrets через `supabase secrets set --env-file .env`. В коде только
  `Deno.env.get("VAR")`.
- `SUPABASE_DB_PASSWORD`, `SUPABASE_ACCESS_TOKEN`, `GITHUB_TOKEN` идут в GitHub Actions secrets
  через `gh secret set` (не в Supabase).
- Маскируй секреты в логах.

## 2. Контракт автономии (краткая выжимка)

Полная версия в `docs/00_AUTONOMY.md`. Главное:

**Тебе разрешено без спроса:**

- Создавать, читать, изменять, удалять любые файлы в рабочей директории проекта.
- Запускать любые команды: `git`, `gh`, `deno`, `supabase`, `curl`, `npm`, `node`, `psql`, `age`,
  `age-keygen`, `openssl`, `jq`, `make`, package managers.
- Создавать репозитории через `gh repo create`, настраивать GitHub Pages, ставить secrets, делать
  PR, мержить, удалять ветки.
- Запускать `supabase link`, `db push`, `functions deploy`, `secrets set`, `db reset` (с
  осторожностью).
- Регистрировать Telegram webhook через `curl https://api.telegram.org/bot.../setWebhook`.
- Делать сетевые запросы к: `api.anthropic.com`, `api.groq.com`, `api.telegram.org`,
  `api.github.com`, `*.supabase.co`, `api.nbp.pl`, `api.exchangerate.host`, `registry.npmjs.org`,
  `deno.land`, `jsr.io`.
- Создавать тестовые транзакции через бота (со своего тестового tg-аккаунта или мока).
- Менять любую конфигурацию в `supabase/config.toml`, `deno.json`, `.github/workflows/`.

**Запрещено без явного разрешения пользователя в чате:**

- Тратить деньги вне рамок установленных бюджетов (`ANTHROPIC_DAILY_BUDGET_USD`,
  `ANTHROPIC_DAILY_BUDGET_USD_PER_USER`). Если ты вдруг видишь, что тестирование может превысить
  лимит, остановись и спроси.
- Удалять / обнулять production-данные в Supabase (после первого реального использования бота). До
  v1.0.0 у тебя свобода ресетить БД, она пустая.
- Публиковать репозиторий как public.
- Менять имя проекта, scope, milestones, стек.

## 3. Когда останавливаться и спрашивать

Останавливайся **только** в этих случаях:

1. Пользователь дал неполный или невалидный ключ, ты не можешь продвинуться (например,
   ANTHROPIC_API_KEY возвращает 401). Тогда: коротко напиши какой именно ключ не работает + что
   нужно от пользователя, и жди.
2. Внешний сервис недоступен > 10 минут (Supabase, GitHub, Anthropic API). Тогда: запиши в
   `docs/STATE.md` текущую позицию, напиши пользователю что ждёшь сервис, и пробуй каждые 5 минут.
3. SPEC.md явно противоречит сам себе в важном месте, и противоречие не разрешается через
   `docs/10_GLOSSARY.md`. Тогда: процитируй два конфликтующих места + предложи свой вариант + жди.
4. CI/CD сломан так, что auto-revert не помог, и три попытки исправить руками не дали результата.
   Тогда: подробный диагноз + `docs/STATE.md` + жди.
5. Закончился контекст сессии (предупреждение от среды). Тогда: запиши `docs/STATE.md`, попроси
   пользователя запустить новую сессию с тем же CLAUDE.md.

**Во всех остальных случаях:** не спрашивай, делай. Ошибки исправляй сам (см.
`docs/05_TROUBLESHOOTING.md`).

## 4. Resume protocol

Если `docs/STATE.md` существует при старте новой сессии:

1. Прочитай его. В нём указано: current milestone, last completed step, открытые TODO, проблемы.
2. Проверь состояние репо: `git log --oneline -20`, `git status`.
3. Проверь состояние Supabase: какие миграции применены (`supabase migration list`), какие функции
   задеплоены (`supabase functions list`), какие cron jobs активны (`select * from cron.job`).
4. Сверь с тем, что должно быть на этой milestone согласно `docs/02_PLAYBOOK.md`.
5. Если совпадает - продолжай со следующего шага.
6. Если есть расхождения - сначала приведи к консистентному состоянию, потом продолжай.

**Обновляй `docs/STATE.md` после каждого завершённого milestone и каждый раз перед длинной операцией
(deploy, миграция, тестовый прогон).**

## 5. Формат STATE.md

```yaml
# docs/STATE.md (Claude Code обновляет автоматически)
current_milestone: M7
last_completed_step: "feat(text): full text pipeline merged to main, deploy green"
next_step: "Start M8 voice handler"
blockers: []
notes:
  - Categorizer retraining seed values verified manually for 17 categories
  - Used model snapshot claude-haiku-4-5-20251001 (confirmed in Anthropic console)
todo_carry_over:
  - Add fixture for Ukrainian voice with mixed pl words (M8)
  - Verify NBP API behaviour on Polish holidays empirically once (M14)
last_updated: 2026-01-15T14:32:00Z
```

## 6. Связь с пользователем

- Пиши на **русском**.
- Кратко. Когда отчитываешься о milestone, формат:
  ```
  ✅ M7 done. Commit: feat(text): full text pipeline.
  Coverage _shared/: 92%. Tests: 47 passed, 0 failed.
  Started M8.
  ```
- Не пиши простыни. Пользователь хочет знать только: где ты, что сделал, что дальше.
- Только если блок (см. раздел 3) - тогда подробно.

## 7. Финальный отчёт (после M18)

Когда всё сделано:

1. Тэг `v1.0.0`, push.
2. Финальное сообщение пользователю в формате:

```
🎉 FinBot v1.0.0 готов.

✅ Все 18 milestones закрыты.
✅ Deploy зелёный, health 200.
✅ Coverage: supabase/functions/ XX%, _shared/ YY%.
✅ Webhook зарегистрирован.
✅ Mini App доступен: https://<username>.github.io/finbot/webapp/

Что нужно сделать тебе руками:
1. Открыть бота в Telegram и отправить /start.
2. Через /add_member добавить остальных членов семьи.
3. Через /health backup-confirm подтвердить, что age-private ключ лежит в password manager.
4. (опционально) Настроить UptimeRobot на https://<project>.supabase.co/functions/v1/api-health-public.

BACKLOG.md содержит фичи на v2 (раздел 22 SPEC.md).

STATE.md закрыт.
```

## 8. Карта документов

| Файл                          | Назначение                                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPEC.md`                     | Источник правды по продукту. Не редактируй.                                                                                                                                                                      |
| `CLAUDE.md`                   | Этот файл. Operational contract.                                                                                                                                                                                 |
| `docs/00_AUTONOMY.md`         | Контракт автономии в полной форме.                                                                                                                                                                               |
| `docs/01_BOOTSTRAP.md`        | Что собрать у пользователя в первом ответе, как валидировать.                                                                                                                                                    |
| `docs/02_PLAYBOOK.md`         | Подробный пошаговый план M1...M18 с командами.                                                                                                                                                                   |
| `docs/03_CONVENTIONS.md`      | Стиль кода, нейминг, паттерны.                                                                                                                                                                                   |
| `docs/04_TESTING.md`          | Стратегия тестов, фикстуры, моки.                                                                                                                                                                                |
| `docs/05_TROUBLESHOOTING.md`  | Как чинить типичные ошибки самостоятельно.                                                                                                                                                                       |
| `docs/06_PROMPTS.md`          | Точные шаблоны промптов Claude (parse_expense, parse_receipt).                                                                                                                                                   |
| `docs/07_CHECKLISTS.md`       | Acceptance criteria для каждого milestone в чек-лист форме.                                                                                                                                                      |
| `docs/08_DEPLOY.md`           | CI/CD детали, GitHub Pages, supabase deploy, post-deploy checks.                                                                                                                                                 |
| `docs/09_RECOVERY.md`         | DR сценарии, restore, auto-revert.                                                                                                                                                                               |
| `docs/10_GLOSSARY.md`         | Терминология, разрешение спорных мест в SPEC.                                                                                                                                                                    |
| `docs/11_CODE_TEMPLATES.md`   | Готовые скелеты `deno.json`, Makefile, утилит, шаблоны Edge Functions/cron/api/тестов.                                                                                                                           |
| `docs/12_BOT_TEXTS.md`        | Все тексты сообщений бота на русском, единый источник правды.                                                                                                                                                    |
| `docs/13_AGENTS.md`           | Как и когда использовать субагенты из `.claude/agents/`.                                                                                                                                                         |
| `docs/14_HOOKS_AUTOMATION.md` | Объяснение Claude Code hooks (em-dash, secrets, dangerous cmd) и git pre-commit.                                                                                                                                 |
| `docs/15_E2E_TESTING.md`      | Когда и как делать smoke-тесты через реальный webhook.                                                                                                                                                           |
| `docs/STATE.md`               | Состояние работы для resume. Обновляешь сам.                                                                                                                                                                     |
| `.claude/settings.json`       | Permissions, hooks, model. Подхватывается автоматически Claude Code.                                                                                                                                             |
| `.claude/agents/*.md`         | 11 субагентов: migration-writer, test-writer, edge-function-builder, deploy-verifier, troubleshooter, security-auditor, coverage-checker, spec-conformance-checker, prompt-engineer, webapp-builder, e2e-tester. |
| `.claude/commands/*.md`       | 8 custom slash commands: `/milestone-start`, `/milestone-complete`, `/state`, `/coverage`, `/verify-deploy`, `/security-scan`, `/resume`, `/compact-prep`.                                                       |
| `scripts/*.sh`                | Скрипты автоматизации: bootstrap_tools, validate_env, check_em_dash, check_secrets, check_dangerous_cmd, pre_commit, install_git_hooks, check_coverage.                                                          |
| `prompts/kickoff.md`          | Стартовый промпт пользователя (для справки).                                                                                                                                                                     |
| `prompts/resume.md`           | Промпт для возобновления сессии (для справки).                                                                                                                                                                   |

## 9. Claude Code специфика, твоё рабочее окружение

В этом репозитории есть две Claude Code-специфичные директории, которые подхватываются
автоматически:

### `.claude/settings.json`

Содержит pre-approved permissions (можешь делать git/gh/deno/supabase/curl/psql/jq и т.д. без
спроса), hooks (PostToolUse автоматически чистит em-dash, ловит секреты; PreToolUse блокирует
опасные команды), и model claude-opus-4-7. Не редактируй этот файл, разве что добавляешь новые
домены в allowlist при появлении новых интеграций.

### `.claude/agents/` (11 субагентов)

Используй subagent через Task tool когда:

- Задача узкая и подходит под одну зону (миграция, тест, security check).
- Хочешь сэкономить контекст главной сессии.
- Нужна параллельная работа.

Подробности по каждому в `docs/13_AGENTS.md`. Если коротко: `migration-writer` для SQL миграций,
`test-writer` для Deno.test, `edge-function-builder` для новых Edge Functions, `deploy-verifier` для
read-only health после deploy, `troubleshooter` когда что-то падает, `security-auditor` перед каждым
commit, `coverage-checker` перед каждым milestone closure, `spec-conformance-checker` на
M11/M14/M18, `prompt-engineer` при настройке Anthropic prompts FinBot'а, `webapp-builder` для всего
M13, `e2e-tester` для smoke через реальный webhook.

### `.claude/commands/` (8 slash commands)

Доступны как `/milestone-start <N>`, `/milestone-complete`, `/state`, `/coverage`, `/verify-deploy`,
`/security-scan`, `/resume`, `/compact-prep`. Используй их вместо ручного повторения шагов.

### `scripts/` (8 bash скриптов)

Помогают тебе в работе:

- `bootstrap_tools.sh` (запусти в M1).
- `validate_env.sh` (запусти после bootstrap, см. `docs/01_BOOTSTRAP.md`).
- `install_git_hooks.sh` (запусти в M1 после `git init`).
- `check_coverage.sh` (через `make coverage` или slash `/coverage`).
- `pre_commit.sh` (вызывается git hook, не сам).
- `check_em_dash.sh`, `check_secrets.sh`, `check_dangerous_cmd.sh` (вызываются Claude Code hooks, не
  сам).

### Hooks автоматически защищают тебя

- Если ты случайно записал em-dash в файл - hook заменит на `-` и предупредит.
- Если ты случайно вписал секрет в код - hook заблокирует, ты должен убрать.
- Если ты пытаешься `rm -rf /` или `gh repo delete` - hook заблокирует.

Это не повод расслабляться, но даёт страховку.

## 10. Версия документации

Эта документация написана под SPEC.md v6 (final). Если SPEC.md обновится, перечитай его, найди
раздел `## Версия и changelog` и сверь изменения с тем что ты уже сделал. Если нужны миграции -
сделай их.

---

Конец CLAUDE.md.
