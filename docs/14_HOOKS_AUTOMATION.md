# 14 HOOKS_AUTOMATION, hooks Claude Code + автоматика

В пакете два уровня автоматизации:

1. **Claude Code hooks** (`.claude/settings.json` `hooks` блок). Срабатывают на события Claude Code:
   до/после tool call, при старте сессии. Запускают shell-команды.
2. **Git hooks** (`.git/hooks/pre-commit`). Срабатывают на git events. Запускают shell-скрипты из
   `scripts/`.

Цель: убрать рутинные проверки из ответственности Claude Code, чтобы он мог сосредоточиться на
бизнес-логике, не забывая про мелочи (em-dash, секреты, опасные команды).

## 1. Claude Code hooks

Конфиг в `.claude/settings.json`. Три типа hooks:

### PreToolUse hooks

Срабатывают **до** того как Claude Code запустит инструмент. Могут заблокировать действие (exit 2).

**check_dangerous_cmd.sh** (`scripts/check_dangerous_cmd.sh`):

- Матчер: `Bash`.
- Блокирует команды: `rm -rf /`, `git push --force origin main`, `supabase projects delete`,
  `gh repo delete`, sudo, fork bombs, `mkfs`, raw `dd` writes.
- Предупреждает (без блокировки): `git push --force` на не-main ветки, `git reset --hard`,
  `--no-verify` флаги.
- На блокировке: выходит с exit 2, Claude Code увидит сообщение и не выполнит команду. Должен
  попросить пользователя помощь (см. CLAUDE.md правило 3).

### PostToolUse hooks

Срабатывают **после** Edit/Write. Могут модифицировать файл (auto-fix) или вернуть warning.

**check_em_dash.sh** (`scripts/check_em_dash.sh`):

- Матчер: `Edit|Write`.
- Скан файла на U+2014 (em-dash).
- Если найден: автоматически заменяет на `-` (пробел-hyphen-пробел) через sed.
- В stderr пишет warning. Claude Code увидит и в следующих файлах будет аккуратнее.

**check_secrets.sh** (`scripts/check_secrets.sh`):

- Матчер: `Edit|Write`.
- Скан на захардкоженные токены: `sk-ant-`, `gsk_`, `ghp_`, `sbp_`, Telegram bot token pattern,
  `AGE-SECRET-KEY-`, Postgres URL with password.
- Если найден: выходит с exit 1 и пишет в stderr CRITICAL. Claude Code должен убрать секрет.
- Игнорирует: `.env*`, `SPEC.md`, `CLAUDE.md`, документация (там разрешены placeholder'ы типа
  `sk-ant-api03-...`).

### SessionStart hooks

Срабатывают при запуске сессии (включая resume).

**Печатает первые 50 строк `docs/STATE.md`** в контекст начала сессии. Это помогает Claude Code
сразу видеть где он остановился. Если файла нет, печатает подсказку прочитать CLAUDE.md.

## 2. Git hooks

### pre-commit (`.git/hooks/pre-commit`)

Устанавливается через `scripts/install_git_hooks.sh` в M1.

Запускает `scripts/pre_commit.sh`, который проверяет:

1. `deno fmt --check` (без правок).
2. `deno lint`.
3. `deno check supabase/functions/**/*.ts`.
4. `deno task test`.
5. Em-dash scan в staged файлах.
6. Secret scan в staged файлах через `scripts/check_secrets.sh`.

Если что-то fail - блокирует commit. Claude Code должен починить и пересоздать.

**Bypass:** `git commit --no-verify` обходит. Используется только в crash recovery, не как
нормальный workflow.

## 3. Полная карта файлов автоматизации

```
.claude/
├── settings.json           # Claude Code hooks + permissions
└── ...

scripts/
├── bootstrap_tools.sh      # установка deno, supabase, gh, age (M1)
├── check_coverage.sh       # coverage thresholds, для slash command
├── check_dangerous_cmd.sh  # PreToolUse hook
├── check_em_dash.sh        # PostToolUse hook
├── check_secrets.sh        # PostToolUse hook
├── install_git_hooks.sh    # установка git hooks (M1)
├── pre_commit.sh           # git pre-commit hook entrypoint
└── validate_env.sh         # проверка .env при bootstrap

.git/hooks/
└── pre-commit              # auto-installed git pre-commit, дёргает scripts/pre_commit.sh
```

## 4. Что делает Claude Code в M1 для активации автоматики

Шаг в M1 playbook (см. `docs/02_PLAYBOOK.md`):

```bash
# После git init
bash scripts/install_git_hooks.sh
```

Этот шаг устанавливает `.git/hooks/pre-commit`. Все последующие commits проходят через него.

`.claude/settings.json` уже лежит в репозитории и подхватывается Claude Code автоматически при
старте сессии в этой директории.

## 5. Hooks и subagents

**Важно:** subagents наследуют `.claude/settings.json` главного agent'а (включая hooks). Это значит:

- migration-writer subagent создаёт файл -> em-dash hook сработает.
- test-writer subagent пишет тест -> secret hook сработает.
- Нет нужды повторять защиту в каждом subagent.

Единственное что subagent НЕ наследует - это его собственный системный промпт. Тот определяется в
`.claude/agents/<name>.md` frontmatter.

## 6. Когда hooks не срабатывают

- **MultiEdit tool** (если используется): hooks матчатся по имени tool. `MultiEdit` отдельный
  матчер, у нас в settings.json он покрыт через `Edit|Write` regex.
- **Tool сделанный subagent'ом**: hooks применяются. Subagent видит ту же stderr.
- **Удаление файла**: PostToolUse Edit/Write hooks не срабатывают (нет Write события). Защищай через
  deny permissions.
- **Bash команда которая пишет файл напрямую** (`echo X > file.ts`): hooks не сработают (это Bash,
  не Write). Это известное ограничение. Claude Code должен использовать Write/Edit tools, не bash
  heredoc для создания кода. В крайнем случае - bash + ручная проверка через grep.

## 7. Логирование работы hooks

Hooks пишут в stderr. Claude Code видит их output, но они не блокируют выполнение если exit code 0.

При проблемах: запустить hook вручную:

```bash
bash scripts/check_em_dash.sh some_file.ts
echo $?  # 0 если ок
```

## 8. Отключить hooks временно

Не рекомендуется, но если crash recovery: удалить `.claude/settings.json` блок hooks, перезапустить
Claude Code. После починки вернуть.

## 9. Расширение hooks

При добавлении новых проверок:

1. Создать скрипт `scripts/check_NEW.sh`.
2. Скрипт принимает аргументы:
   - PostToolUse: file path.
   - PreToolUse: command string.
   - SessionStart: ничего.
3. Скрипт пишет stderr на warning, exit 0 на successful skip, exit 1 на soft fail, exit 2 на hard
   block (только PreToolUse).
4. Добавить в `.claude/settings.json` -> `hooks` -> подходящая фаза.

---

Конец 14_HOOKS_AUTOMATION.md.
