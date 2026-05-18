# 01 BOOTSTRAP, начало работы (первое сообщение пользователю)

Этот файл описывает **первое сообщение**, которое Claude Code пишет пользователю, когда сессия
только что началась и `docs/STATE.md` ещё не существует.

## 1. Цель bootstrap

Собрать у пользователя **одним сообщением** все ключи, токены и решения, которые потребуются для
всех 18 milestones. После этого пользователь уходит, а Claude Code работает без участия до самого
конца.

## 2. Шаблон первого сообщения Claude Code

Скопируй этот текст (с подстановкой переменных где надо), отправь пользователю в чат, и жди ответа.

```
Привет. Прочитал CLAUDE.md и SPEC.md v6.

Сейчас один список того, что мне нужно от тебя одним сообщением, дальше я работаю до v1.0.0 сам.

== A. Telegram ==
1. TELEGRAM_BOT_TOKEN, токен бота от @BotFather (формат: 1234:ABC...).
2. TELEGRAM_ADMIN_TELEGRAM_ID, твой числовой Telegram ID (узнаётся через @userinfobot).
3. Family members: список членов семьи, формат "Имя:telegram_id, Имя:telegram_id".
   Например: "Серхий:123456789, Жена:987654321, Олівія:555111222".
   Один из них должен совпадать с TELEGRAM_ADMIN_TELEGRAM_ID, и будет role=admin.

== B. Anthropic ==
4. ANTHROPIC_API_KEY, ключ от console.anthropic.com (формат: sk-ant-...).

== C. Groq ==
5. GROQ_API_KEY, ключ от console.groq.com (формат: gsk_...).

== D. Supabase ==
6. SUPABASE_PROJECT_REF, ref проекта в Supabase (короткий код, например abcdefghijklmnop).
7. SUPABASE_ACCESS_TOKEN, personal access token из supabase.com/dashboard/account/tokens (формат: sbp_...).
8. SUPABASE_DB_PASSWORD, пароль БД, который ты задал при создании Supabase project.

== E. GitHub ==
9. GITHUB_USERNAME, твой логин на GitHub.
10. GITHUB_REPO_NAME, имя репозитория (по умолчанию: finbot).
11. GITHUB_TOKEN, classic personal access token с scope `repo`, `workflow`, `admin:repo_hook`, `read:user`.
    Сгенерируй на https://github.com/settings/tokens/new (или fine-grained PAT с правами:
    Contents: Read+Write, Actions: Read+Write, Pages: Read+Write, Secrets: Read+Write,
    Workflows: Read+Write, Administration: Read+Write на этот один репо).

== F. Backup ==
12. BACKUP_ENCRYPTION_KEY, age public key (формат: age1...).
    Если у тебя его ещё нет, выполни локально:
        age-keygen -o ~/finbot-backup-key.txt
    Файл содержит public + private. Public ключ передай мне.
    Private (строка "AGE-SECRET-KEY-...") сохрани в 1Password (или другой password manager) под именем "FinBot backup key".
    Без приватного ключа бэкапы не восстанавливаются. Это критично.

== Дополнительно (опционально) ==

13. PROJECT_DIR, абсолютный путь, где ты хочешь чтобы я создал проект (по умолчанию: ~/projects/finbot).
14. Какой регион Supabase ты выбрал (для информации, не критично). По умолчанию SPEC рекомендует Frankfurt.

== Что я сделаю дальше ==

- Создам структуру проекта.
- Сложу секреты в .env + GitHub Actions secrets.
- Пройду milestones M1...M18 по порядку. Каждый закрывается коммитом.
- В конце дам финальный отчёт.

Если что-то из списка не готово, скажи в каком пункте, и что именно нужно (например "у меня нет age-keygen, помоги установить"). Если всё есть, шли одним сообщением (можно в любом удобном формате, я разберу).
```

## 3. Парсинг ответа пользователя

Пользователь может прислать ответ в свободной форме: списком, как в шаблоне, прозой, или просто
построчно. Будь толерантен к формату. Извлеки все 12 (или 14) значений. Если чего-то не хватает,
спроси повторно одним коротким сообщением: "не нашёл X и Y, продублируй".

### Валидация полученных значений

После того как пользователь прислал ответ:

```bash
# 1. Создать рабочую директорию
PROJECT_DIR="${PROJECT_DIR:-$HOME/projects/finbot}"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

# 2. Создать .env
cat > .env <<'EOF'
TELEGRAM_BOT_TOKEN=<value>
TELEGRAM_ADMIN_TELEGRAM_ID=<value>
ANTHROPIC_API_KEY=<value>
CLAUDE_MODEL_FAST=claude-haiku-4-5-20251001
CLAUDE_MODEL_VISION=claude-sonnet-4-6
ANTHROPIC_DAILY_BUDGET_USD=1.00
ANTHROPIC_DAILY_BUDGET_USD_PER_USER=0.30
GROQ_API_KEY=<value>
GROQ_MODEL=whisper-large-v3-turbo
WHISPER_LANGUAGES_WHITELIST=ru,uk,pl,en
WHISPER_MAX_VOICE_DURATION_SEC=300
IMAGE_MAX_DIMENSION=1920
IMAGE_JPEG_QUALITY=85
PHOTO_RETENTION_DAYS=90
DEFAULT_CURRENCY=PLN
DEFAULT_TIMEZONE=Europe/Warsaw
HIGH_AMOUNT_THRESHOLD_PLN=200
CONFIRMATION_TIMEOUT_SEC=60
UNDO_WINDOW_MINUTES=10
CRON_SECRET=<generated>
GITHUB_TOKEN=<value>
GITHUB_REPO=<username>/<repo_name>
BACKUP_ENCRYPTION_KEY=<value>
EOF

chmod 600 .env

# 3. CRON_SECRET генерируем сами
CRON_SECRET=$(openssl rand -hex 32)
sed -i.bak "s|CRON_SECRET=.*|CRON_SECRET=$CRON_SECRET|" .env && rm .env.bak

# 4. Валидация каждого ключа

# Telegram
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" | jq -e '.ok == true' || echo "TELEGRAM_BOT_TOKEN invalid"

# Anthropic
curl -fsS https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" | jq -e '.data | length > 0' || echo "ANTHROPIC_API_KEY invalid"

# Groq
curl -fsS https://api.groq.com/openai/v1/models \
  -H "Authorization: Bearer $GROQ_API_KEY" | jq -e '.data | length > 0' || echo "GROQ_API_KEY invalid"

# Supabase access token
curl -fsS "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" | jq -e '.id' || echo "SUPABASE_ACCESS_TOKEN or PROJECT_REF invalid"

# GitHub
curl -fsS https://api.github.com/user \
  -H "Authorization: Bearer $GITHUB_TOKEN" | jq -e '.login' || echo "GITHUB_TOKEN invalid"

# BACKUP_ENCRYPTION_KEY format
echo "$BACKUP_ENCRYPTION_KEY" | grep -qE '^age1[a-z0-9]+$' || echo "BACKUP_ENCRYPTION_KEY not in age public key format"
```

Если **любая** валидация фейлится: остановись, напиши пользователю **одно** конкретное сообщение "X
не работает: <ответ API>". Жди исправления.

Если все ок: переходи к M1.

## 4. Сохранение family members

После валидации ключей, парси строку с семьёй (`"Имя:telegram_id, ..."`) и сложи в `docs/STATE.md`:

```yaml
family_members:
  - { name: "Серхій", telegram_id: 123456789, role: "admin" }
  - { name: "Жена", telegram_id: 987654321, role: "member" }
  - { name: "Олівія", telegram_id: 555111222, role: "member" }
```

Эти данные используешь в M2 (seed) и M4 (auth).

## 5. Установка инструментов

Перед началом M1 убедись, что в системе пользователя установлены:

```bash
deno --version || { echo "Deno not installed"; exit 1; }
supabase --version || { echo "Supabase CLI not installed"; exit 1; }
gh --version || { echo "GitHub CLI not installed"; exit 1; }
git --version || { echo "Git not installed"; exit 1; }
jq --version || { echo "jq not installed"; exit 1; }
psql --version || echo "psql optional, нужен только для restore.ts локально"
age --version || echo "age optional на этой машине, нужен только для restore"
```

Если что-то из обязательных отсутствует, **установи сам** через стандартный пакетный менеджер
пользователя:

- macOS (есть `brew --version`): `brew install deno supabase/tap/supabase gh jq`.
- Linux apt:
  `sudo apt-get update && sudo apt-get install -y curl jq git && curl -fsSL https://cli.github.com/install.sh | sudo bash`,
  далее Deno через `curl -fsSL https://deno.land/install.sh | sh`, Supabase CLI через
  `npm i -g supabase` или скачать бинарник.
- Если ничего не подходит, скажи пользователю что именно установить.

## 6. Готовность к M1

Когда:

- Все 12 ключей провалидированы.
- `.env` создан с правильными правами.
- Инструменты установлены.
- Family members разобраны в `docs/STATE.md`.

Пиши одну короткую строку в чат: `Bootstrap ok. Старт M1.` и сразу начинай.

---

Конец 01_BOOTSTRAP.md.
