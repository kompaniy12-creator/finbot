# QUICKSTART

5 шагов, ~20 минут подготовки, дальше Claude Code работает сам.

## Шаг 1. Подготовь ключи (один раз, ~15 минут)

Тебе нужно сделать руками 5 действий (это единственные ручные шаги):

### A. Telegram bot

1. Открой @BotFather в Telegram.
2. `/newbot`, придумай имя, выбери username (например, `family_finbot`).
3. Сохрани токен (формат `1234567890:ABCdef...`).
4. `/setcommands` -> выбери своего бота -> вставь:
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
5. Узнай свой Telegram ID: напиши @userinfobot, он вернёт твой числовой ID. Сохрани.

### B. Anthropic API key

1. console.anthropic.com -> API Keys -> Create Key.
2. Сохрани (формат `sk-ant-api03-...`).
3. Убедись что на балансе есть $5+ (для buffer).

### C. Groq API key

1. console.groq.com -> API Keys -> Create API Key.
2. Сохрани (формат `gsk_...`).
3. Free tier подходит.

### D. Supabase project

1. supabase.com -> New project.
2. Имя: finbot. Регион: Frankfurt (eu-central-1). Plan: Free.
3. Запомни DB password.
4. После создания: Project Settings -> General -> Reference ID (например, `abcdefghijklmnop`).
   Сохрани.
5. Personal access token: supabase.com/dashboard/account/tokens -> Generate. Формат `sbp_...`.
   Сохрани.

### E. GitHub

1. Создай pустой приватный репозиторий ИЛИ позволь Claude Code создать его (рекомендуется, проще).
   Если делаешь сам: github.com/new -> name `finbot`, Private, без README/gitignore/license.
2. Personal access token: github.com/settings/tokens/new (classic) -> scopes: `repo`, `workflow`,
   `admin:repo_hook`, `read:user`. Сохрани (формат `ghp_...`).
3. **age key (для шифрования бэкапов):**
   ```bash
   # Установи age если нет
   # macOS: brew install age
   # Linux: sudo apt install age, или скачать из github.com/FiloSottile/age/releases

   age-keygen -o ~/finbot-backup-key.txt
   cat ~/finbot-backup-key.txt
   ```
   Файл содержит две строки:
   ```
   # public key: age1...
   AGE-SECRET-KEY-1...
   ```
   - Public ключ (`age1...`) сохрани, его передашь Claude Code.
   - **Private ключ (`AGE-SECRET-KEY-...`) положи в 1Password** под именем "FinBot backup key". Без
     него бэкапы не восстанавливаются. **Это критично.**

## Шаг 2. Установи инструменты на машине

Тебе нужны:

- `deno` (1.40+).
- `supabase` CLI (latest).
- `gh` CLI (2.40+).
- `git`.
- `jq`.

```bash
# macOS
brew install deno supabase/tap/supabase gh git jq

# Linux Ubuntu
curl -fsSL https://deno.land/install.sh | sh
curl -fsSL https://cli.github.com/install.sh | sudo bash
npm install -g supabase  # либо скачай бинарник из github releases
sudo apt-get install -y git jq
```

Проверка:

```bash
deno --version && supabase --version && gh --version && git --version && jq --version
```

## Шаг 3. Подготовь рабочую директорию

```bash
mkdir ~/projects/finbot-workspace
cd ~/projects/finbot-workspace

# Распакуй пакет finbot-docs.tar.gz сюда:
tar -xzf /path/to/finbot-docs.tar.gz
# Должно получиться:
# - CLAUDE.md
# - README.md (этот файл)
# - QUICKSTART.md
# - docs/
# - prompts/
# - SPEC.md  <- этот ты добавляешь руками

# Положи твой SPEC.md в эту же директорию
cp /path/to/SPEC.md .

ls -la
# Ожидается:
# CLAUDE.md, QUICKSTART.md, README.md, SPEC.md, docs/, prompts/
```

## Шаг 4. Залогинься в gh

```bash
gh auth login  # выбери HTTPS, paste your PAT с шага 1E
```

Проверка:

```bash
gh auth status
```

## Шаг 5. Запусти Claude Code

```bash
cd ~/projects/finbot-workspace
claude --dangerously-skip-permissions
```

**Почему `--dangerously-skip-permissions`?** Чтобы Claude Code не спрашивал тебя на каждый bash или
Write. Дополнительно, в пакете есть `.claude/settings.json` с pre-approved permissions (git, gh,
deno, supabase, curl, psql, jq и т.д.) и hooks (auto-fix em-dash, secret scanner, dangerous command
blocker). Даже без флага CC будет работать тихо за счёт settings.json, но с флагом гарантированно
без единого prompt.

В чат вставь точный текст из `prompts/kickoff.md` (Способ 1, копируй блок в тройных кавычках).

Claude Code прочитает документы, через ~30 секунд отправит **одно сообщение** с запросом ~12 ключей
и параметров.

Ты отвечаешь **одним сообщением** в любом удобном формате (можно простым списком):

```
1. TELEGRAM_BOT_TOKEN: 1234567890:ABCdef...
2. TELEGRAM_ADMIN_TELEGRAM_ID: 123456789
3. Family members: Серхій:123456789, Жена:987654321, Олівія:555111222
4. ANTHROPIC_API_KEY: sk-ant-api03-...
5. GROQ_API_KEY: gsk_...
6. SUPABASE_PROJECT_REF: abcdefghijklmnop
7. SUPABASE_ACCESS_TOKEN: sbp_...
8. SUPABASE_DB_PASSWORD: <твой пароль>
9. GITHUB_USERNAME: serhii-username
10. GITHUB_REPO_NAME: finbot
11. GITHUB_TOKEN: ghp_...
12. BACKUP_ENCRYPTION_KEY: age1...
```

Дальше Claude Code работает 3-7 часов без участия. Кодит, тестирует, деплоит, проверяет.

## Готово

Финальное сообщение Claude Code будет про `v1.0.0`, в нём ссылка на репо и URL Mini App. Можешь идти
в Telegram, открыть бота, `/start`.

## Что-то пошло не так

См. `docs/05_TROUBLESHOOTING.md`. Claude Code чинит сам.

Если Claude Code остановился и спрашивает что-то конкретное (один из 5 разрешённых случаев из
`CLAUDE.md` раздел 3), ответь по сути.

Если контекст сессии закончился (Claude Code сообщил об этом), запусти новую сессию:

```bash
cd ~/projects/finbot-workspace
claude --dangerously-skip-permissions
```

И вставь текст из `prompts/resume.md`.

## Время

| Шаг                              | Минут   |
| -------------------------------- | ------- |
| 1. Подготовка ключей             | 15      |
| 2. Установка инструментов        | 5       |
| 3. Распаковка пакета             | 1       |
| 4. gh auth                       | 1       |
| 5. Запуск + первый ответ ключами | 5       |
| Ожидание автономной работы       | 180-420 |

**Твоё активное время: ~25 минут.** Остальное Claude Code сам.
