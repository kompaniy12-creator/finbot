# 00 AUTONOMY, контракт автономии Claude Code

Этот документ это **формальное разрешение пользователя** на самостоятельные действия Claude Code при
реализации проекта FinBot. Документ часть проектной документации, был передан Claude Code
пользователем в первой сессии. Он эквивалентен явному "да" пользователя в чате.

## 1. Общая преамбула

Пользователь (Серхий Видумак, Poznań, PL) дал Claude Code задачу реализовать проект FinBot v6 (см.
`SPEC.md`) полностью автономно. Пользователь не присутствует в сессии, не одобряет каждый шаг, не
отвечает на запросы кроме тех, которые попадают под раздел "Когда останавливаться и спрашивать" в
`CLAUDE.md`. Пользователь принимает риски, связанные с автономной работой агента в рамках, описанных
ниже.

## 2. Разрешённые действия (carte blanche)

### 2.1 Файловая система проекта

- Создавать, читать, изменять, удалять любые файлы в рабочей директории проекта.
- Создавать поддиректории.
- Менять права доступа (`chmod`) где необходимо.
- Создавать и обновлять `.gitignore`.

### 2.2 Git и GitHub

- `git init`, `git add`, `git commit`, `git push`, `git pull`, `git merge`, `git rebase`,
  `git branch`, `git checkout`, `git tag`, `git revert`, `git reset`, `git stash`, `git remote`.
- `gh repo create <name> --private --source=. --remote=origin --push` для создания репозитория
  (приватного).
- `gh secret set <KEY> --body "<value>"` для GitHub Actions secrets.
- `gh pr create`, `gh pr merge --squash --delete-branch`, `gh pr checks`.
- `gh release create`, `gh release upload`, `gh release download`, `gh release delete`.
- `gh api` для всего остального через REST API (например, включение GitHub Pages, настройка branch
  protection).
- `gh workflow run`, `gh workflow view`, `gh run watch`, `gh run view`.
- **Запрет:** делать репо публичным, удалять репо целиком.

### 2.3 Deno и npm

- `deno run`, `deno test`, `deno fmt`, `deno lint`, `deno check`, `deno cache`, `deno task <name>`,
  `deno info`.
- Установка зависимостей через `npm:` префиксы в imports map. Никаких `package.json` или
  `node_modules`.
- Запуск любых скриптов из `scripts/`.
- **Запрет:** установка через `https://deno.land/x/...` (deprecated).

### 2.4 Supabase CLI

- `supabase init`, `supabase login` (через `SUPABASE_ACCESS_TOKEN`).
- `supabase link --project-ref <ref>`.
- `supabase db push`, `supabase db reset --linked` (только до момента когда бот пошёл в реальное
  использование, см. раздел 3.2).
- `supabase migration new`, `supabase migration list`, `supabase migration repair`.
- `supabase functions new`, `supabase functions deploy`, `supabase functions delete`,
  `supabase functions list`, `supabase functions logs`, `supabase functions serve`.
- `supabase secrets set --env-file .env`, `supabase secrets list`, `supabase secrets unset`.
- `supabase start`, `supabase stop` для локального эмулятора (опционально).
- `supabase storage` команды для управления bucket `receipts`.
- **Запрет:** удалять проект через CLI, менять регион.

### 2.5 Внешние API и сетевые запросы

Разрешены сетевые запросы к:

- `api.anthropic.com` (Claude messages API).
- `api.groq.com` (Whisper transcription).
- `api.telegram.org` (Telegram Bot API, включая setWebhook, sendMessage и т.д.).
- `api.github.com` (через `gh` CLI или curl).
- `*.supabase.co` (свой Supabase project).
- `api.nbp.pl` (курсы PLN).
- `api.exchangerate.host` (курсы прочие).
- `registry.npmjs.org`, `cdn.jsdelivr.net`, `unpkg.com` (зависимости).
- `deno.land`, `jsr.io` (Deno deps).
- `cdnjs.cloudflare.com` (Chart.js для webapp).

Запросы к произвольным URL за пределами этого списка - под подозрением, не делай без необходимости.
Если SPEC требует - можно.

### 2.6 Telegram

- Регистрировать webhook (`/setWebhook`) и снимать (`/deleteWebhook`).
- Слать тестовые сообщения боту (через `gh` CLI или curl, с тестового аккаунта или эмулируя update
  через POST в свой webhook).
- Менять команды бота (`/setMyCommands`).
- Настраивать Mini App URL (`/setMenuButton`).
- **Запрет:** обращаться к чужим Telegram-аккаунтам, рассылать сообщения куда-либо кроме тестового
  канала и бота админа.

### 2.7 Криптография

- `age-keygen` для генерации backup-ключей (если пользователь не сгенерировал сам).
- `openssl rand -hex 32` для генерации `CRON_SECRET` и подобных.
- `psql` для прямых SQL-запросов к Supabase Postgres (через `SUPABASE_DB_URL`).
- `jq` для парсинга JSON.

### 2.8 Деньги

- Тратить на Anthropic API в рамках `ANTHROPIC_DAILY_BUDGET_USD` (default $1/день).
- Тратить на Groq API: бесплатный tier должен хватать на разработку и тесты.
- Прочее, Supabase Free tier, GitHub Free tier, Telegram, всё бесплатно.

**Если за время разработки (включая прогон всех тестов и финальный e2e) траты на Anthropic могут
превысить $5 - остановись и спроси.** Это страховка от багов в твоём коде, которые крутят Claude в
бесконечном цикле.

## 3. Что НЕ разрешено

### 3.1 Стратегические решения

- Менять стек (Python вместо TS, OpenAI вместо Anthropic, polling вместо webhook, и т.д.) -
  запрещено. Стек жёстко зафиксирован в SPEC §2.
- Менять архитектуру (например, отказаться от Edge Functions в пользу VPS) - запрещено.
- Добавлять фичи из BACKLOG (SPEC §22) в v1 - запрещено.
- Удалять / упрощать фичи из обязательного scope (SPEC §6, §7, §8) - запрещено.

### 3.2 Деструктивные действия после go-live

После того как пользователь подтвердил, что начал реально использовать бота (через сообщение типа
"пользуюсь", "запустил", или после tag v1.0.0):

- Нельзя делать `supabase db reset`.
- Нельзя массово удалять записи в Postgres без явного запроса.
- Нельзя удалять Storage bucket `receipts` или массово файлы оттуда.
- Нельзя force push в main.
- Можно только nondestructive операции: добавление миграций, новые функции, исправление багов через
  PR.

### 3.3 Раскрытие секретов

- Не пиши секреты в коммит-сообщения, PR описания, README, любые публичные места.
- Маскируй секреты в логах когда печатаешь их (показывай только первые 4 и последние 4 символа:
  `sk-ant-***-abcd`).
- Если случайно закоммитил секрет, немедленно: `git reset --soft HEAD~1`, исправь, force push на
  feature ветке (не на main), и попроси пользователя ротировать ключ.

### 3.4 Чужая инфраструктура

- Не дёргай Supabase / GitHub / Telegram через токены/ключи, не принадлежащие пользователю.
- Все ключи в `.env`, переданные пользователем в первом сообщении, принадлежат ему.

## 4. Контракт ошибок

### 4.1 Что считается фейлом

- Тест не зелёный, и три разных попытки исправить не помогли.
- Deploy упал, и auto-revert не помог.
- Внешний API возвращает ошибку > 10 минут подряд.
- Bash команда падает с непонятной ошибкой, и `docs/05_TROUBLESHOOTING.md` не помогает.

### 4.2 Что делать при фейле

1. Записать в `docs/STATE.md` детали.
2. Краткое сообщение пользователю в чат: что упало + что нужно от него (если что-то нужно).
3. Не флудить сообщениями. Если ждёшь пользователя, тихо ждёшь.

### 4.3 Чего НЕ делать при фейле

- Не делать `git reset --hard` на main.
- Не дропать таблицы.
- Не пытаться "пофиксить" через всё более радикальные хаки. Если простое решение не работает за 3
  попытки - стоп.
- Не молчать.

## 5. Бюджет времени и контекста

- Реализация v1.0.0 (M1...M18) ожидается за разумное число сессий (одна-две длинные сессии Claude
  Code).
- Если приближаешься к лимиту контекста сессии, заранее обнови `docs/STATE.md` (за ~20% до конца) и
  закончи на чистом коммите.
- Не пиши лишнего кода. Минимально достаточно для acceptance criteria каждого milestone.

## 6. Тестирование на тебе

- Ты сам пишешь тесты для своего кода. Параллельно, не в конце.
- Coverage обязательно проверяешь после каждого milestone:
  `deno test --coverage=cov && deno coverage cov`.
- Если coverage `supabase/functions/` упал ниже 80% или `_shared/` ниже 90%, добавь тестов до
  коммита.

## 7. Подпись пользователя

Этот документ передан Claude Code пользователем 18 мая 2026 в первой сессии работы над FinBot v6.
Серхий Видумак, Poznań, PL, является единоличным автором и владельцем проекта FinBot и всех
связанных ключей и инфраструктуры. Пользователь даёт Claude Code разрешение действовать согласно
правилам выше до момента tag `v1.0.0`, после чего автономия сужается до non-destructive операций.

---

Конец 00_AUTONOMY.md.
