# 07 CHECKLISTS, acceptance criteria для каждого milestone

После завершения каждого milestone пройди этот чеклист **полностью**. Если хоть один пункт `[ ]`
нерешён, **не коммить и не переходи к следующему**. Чини пока не закроется.

Источник: SPEC §16 + раскрытие из `docs/02_PLAYBOOK.md`.

---

## M1: Skeleton + Supabase setup

- [ ] `git init` сделан, ветка main.
- [ ] `gh repo create $GITHUB_REPO --private` выполнено, remote origin привязан.
- [ ] Структура каталогов из SPEC §10 на диске (все папки, пусть пустые).
- [ ] `.gitignore` содержит `.env`, секреты, артефакты.
- [ ] `deno.json` точно по SPEC §11.2.
- [ ] `.env.example` точно по SPEC §11.1.
- [ ] `Makefile` точно по SPEC §13.5.
- [ ] `README.md` минимальный (1-2 абзаца, ссылка на SPEC.md).
- [ ] `BACKLOG.md` создан с содержимым SPEC §22.
- [ ] `supabase init` отработал.
- [ ] `supabase login --token "$SUPABASE_ACCESS_TOKEN"` ok.
- [ ] `supabase link --project-ref "$SUPABASE_PROJECT_REF"` ok.
- [ ] `_shared/types.ts` с базовыми Zod-схемами.
- [ ] `_shared/supabase.ts` с admin client factory.
- [ ] `tg-webhook/index.ts` минимальный: webhook secret check + reply на /start.
- [ ] `deno task check` зелёный.
- [ ] `deno task lint` зелёный.
- [ ] `deno task fmt` без изменений.
- [ ] `deno task test` зелёный (1-2 smoke теста).
- [ ] `supabase functions serve tg-webhook` поднимается локально, curl на localhost возвращает 401
      без secret и 200 с secret.
- [ ] Commit: `chore: initial skeleton`. Push в main.
- [ ] `docs/STATE.md` обновлён: `current_milestone: M2`.

---

## M2: Database schema

- [ ] 6 миграций созданы:
  - [ ] `0001_extensions.sql` (extensions).
  - [ ] `0002_tables.sql` (12 таблиц).
  - [ ] `0003_indexes.sql` (все индексы).
  - [ ] `0004_functions.sql` (`match_expenses`, `log_expense_audit`, trigger).
  - [ ] `0005_cron.sql` (все `cron.schedule` закомментированы).
  - [ ] `0006_security.sql` (RLS off + storage bucket).
- [ ] `supabase db push` отрабатывает чисто (одна команда без ошибок).
- [ ] `setup-once/index.ts` создана и развёрнута.
- [ ] Curl вызов `setup-once` возвращает 200, в БД появились 17 категорий и family_members.
- [ ] `psql ... -c "select count(*) from categories"` = 17.
- [ ] `psql ... -c "select count(*) from family_members"` = число членов семьи.
- [ ] Embedding у 17 категорий не null
      (`select count(*) from categories where embedding is not null` = 17).
- [ ] Storage bucket `receipts` создан и приватный.
- [ ] Тест `tests/audit_trigger.test.ts`: insert expense -> запись в expense_audit. Зелёный.
- [ ] Commit: `feat(db): schema with audit`. Push.
- [ ] `docs/STATE.md` обновлён.

---

## M3: Idempotency + retry queue

- [ ] `tg-webhook` использует функцию `dedupe(messageId, familyMemberId)`.
- [ ] `cron-retry-failed/index.ts` создан, реализована exponential backoff (1, 5, 15, 60, 300
      минут).
- [ ] Cron-auth check (Bearer CRON_SECRET) во всех cron-функциях.
- [ ] `_shared/retry.ts` с `enqueueRetry()`.
- [ ] Тест `tests/idempotency.test.ts`: повторный telegram_message_id не создаёт дубль.
- [ ] Тест `tests/idempotency_edited.test.ts`: edited message (длинный -> короткий -> длинный)
      hard-delete + reinsert + audit.
- [ ] Тест `tests/retry_queue.test.ts`: fail -> enqueue -> retry -> success.
- [ ] Тесты зелёные.
- [ ] Commit: `feat(reliability): idempotency and retry queue`.

---

## M4: Auth + базовые команды

- [ ] `_shared/auth.ts` с `authorize()`.
- [ ] Whitelist проверка через `family_members.active = true`.
- [ ] Unauthorized: alert админу + дружелюбный отказ юзеру.
- [ ] Команды:
  - [ ] `/start`.
  - [ ] `/help`.
  - [ ] `/categories`.
  - [ ] `/dashboard`.
  - [ ] `/health` (admin only).
  - [ ] `/audit <expense_id>` (admin only).
- [ ] Не-admin вызывает `/health` -> отказ.
- [ ] Тест `tests/auth.test.ts`: чужой telegram_id отвергается.
- [ ] Тест `tests/commands.test.ts`: каждая команда отвечает.
- [ ] Commit: `feat(auth): authorization and base commands`.

---

## M5: Claude + budget tracking

- [ ] `_shared/claude.ts` с tool use, prompt caching, temperature=0.
- [ ] `_shared/budget.ts` с per-user soft + global hard cap.
- [ ] Cost calculation из `usage` (input/output/cache_creation/cache_read tokens).
- [ ] Insert в `anthropic_usage` после каждого вызова.
- [ ] Pre-check budget перед каждым Claude-вызовом.
- [ ] Per-user soft превышение: warning, продолжаем.
- [ ] Global hard превышение: hard stop, юзеру "🚫 Дневной бюджет исчерпан".
- [ ] Prompt caching активен (видно в response usage: `cache_read_input_tokens > 0` на втором
      вызове).
- [ ] Тест `tests/budget_per_user.test.ts`: один user превысил, другой ок.
- [ ] Тест `tests/budget_global.test.ts`: global hit -> hard stop.
- [ ] Тест `tests/claude_cost_calc.test.ts`: фикстура -> ожидаемая сумма.
- [ ] Commit: `feat(ai): claude with two-tier budget`.

---

## M6: Embedder + categorizer + retraining

- [ ] `_shared/embedder.ts`: `Supabase.ai.Session("gte-small")` работает (или xenova fallback с
      записью в STATE.md).
- [ ] `_shared/categorizer.ts`:
  - [ ] kNN через `match_expenses` RPC.
  - [ ] Threshold 0.85 для kNN-уверенности.
  - [ ] Claude fallback с топ-30 категорий + топ-5 похожих expenses.
  - [ ] Новая категория создаётся если Claude её предложил.
- [ ] `name_normalized_en` приходит из Claude parse_expense, используется для embed.
- [ ] `cron-retraining/index.ts`:
  - [ ] Cron-auth.
  - [ ] Пересчёт `categories.embedding` для категорий с >=3 corrected expenses.
  - [ ] Update `centroid_updated_at`.
- [ ] Тест `tests/categorizer_knn.test.ts`: "кофе"/"espresso"/"молоко" -> правильные категории.
- [ ] Тест `tests/categorizer_fallback.test.ts`: неизвестный товар -> Claude fallback.
- [ ] Тест `tests/categorizer_new.test.ts`: Claude новая категория -> insert.
- [ ] Тест `tests/retraining.test.ts`: 3 corrected -> embedding изменилось.
- [ ] Commit: `feat(ai): categorizer with multilingual workaround`.

---

## M7: Текст + currency

- [ ] `_shared/dates.ts`: timezone-aware Europe/Warsaw, парсинг "вчера", "позавчера", "в субботу",
      dd.mm.
- [ ] `_shared/currency.ts`:
  - [ ] PLN это base = 1.0.
  - [ ] EUR/USD через NBP.
  - [ ] ALL через exchangerate.host.
  - [ ] Fallback на последний рабочий день.
  - [ ] Cache в `exchange_rates`.
- [ ] Text handler в tg-webhook:
  - [ ] Полный pipeline по SPEC §6.1.
  - [ ] High-amount check > 200 PLN -> needs_confirmation=true.
- [ ] Callbacks:
  - [ ] `undo:<id>` (10 мин окно).
  - [ ] `cat_menu:<id>` (топ-5).
  - [ ] `cat_all:<id>` (пагинация).
  - [ ] `cat_set:<id>:<cat_id>` ставит `corrected_by_user=true`.
- [ ] Команды `/history`, `/undo`, `/stats` (tz-aware).
- [ ] `cron-rates/index.ts` создан (schedule activate в M14).
- [ ] Тесты:
  - [ ] `tests/currency.test.ts`.
  - [ ] `tests/currency_holidays.test.ts` (праздник -> fallback).
  - [ ] `tests/parse_dates_tz.test.ts` ("вчера" в 23:00 Warsaw).
  - [ ] `tests/text_pipeline.test.ts` (e2e на моках).
- [ ] Commit: `feat(text): full text pipeline`.

---

## M8: Голос через Groq

- [ ] `_shared/groq.ts` с `transcribe()`.
- [ ] Voice handler:
  - [ ] Duration pre-check (`voice.duration > WHISPER_MAX_VOICE_DURATION_SEC` -> reject до
        download).
  - [ ] Download ogg через Telegram getFile.
  - [ ] POST в Groq `whisper-large-v3-turbo`.
  - [ ] Language whitelist check (ru/uk/pl/en).
  - [ ] Progress messages "🎙 Распознаю..." -> "🤖 Думаю..." -> финал (через editMessageText).
  - [ ] После транскрипции - тот же pipeline что и текст.
- [ ] Фикстуры:
  - [ ] `tests/fixtures/voice_ru_kofe.ogg`.
  - [ ] `tests/fixtures/voice_uk_moloko.ogg`.
  - [ ] `tests/fixtures/groq_responses.json`.
- [ ] Тест `tests/voice.test.ts`: ru/uk -> запись создаётся.
- [ ] Тест `tests/voice_duration.test.ts`: 6-минутное -> reject до download.
- [ ] Тест `tests/voice_language.test.ts`: китайский -> reject.
- [ ] Commit: `feat(voice): groq whisper integration`.

---

## M9: Фото чеков + HEIC + Vision

- [ ] `_shared/image.ts`:
  - [ ] HEIC detection + конверсия через `heic-convert`.
  - [ ] Compress через sharp (max 1920px, q85).
- [ ] Photo handler:
  - [ ] Download через Telegram getFile.
  - [ ] Conversion + compress.
  - [ ] Upload в Storage `receipts/<family_member_id>/<date>/<uuid>.jpg`.
  - [ ] Signed URL TTL 300 сек.
  - [ ] Claude Vision (Sonnet 4.6) через `parse_receipt` tool.
  - [ ] Reconciliation +/- 5%.
  - [ ] Если reconciliation провалена -> `needs_review=true` всем expenses этого receipt.
  - [ ] Aggregate items по категориям.
  - [ ] Insert receipt + expenses (одна транзакция).
- [ ] Reply: сводка по категориям + callback "📋 Подробно".
- [ ] Callback "📋 Подробно": список всех items.
- [ ] Фикстуры:
  - [ ] `tests/fixtures/receipts/receipt_jpeg_simple.jpg`.
  - [ ] `tests/fixtures/receipts/receipt_heic_lidl.heic`.
  - [ ] `tests/fixtures/receipts/receipt_jpeg_long.jpg`.
  - [ ] `tests/fixtures/receipts/receipt_jpeg_blurry.jpg`.
- [ ] Тесты на 4 фикстурах: зелёные.
- [ ] Тест `tests/image.test.ts`: HEIC -> JPEG conversion.
- [ ] Commit: `feat(receipts): photo with vision`.

---

## M10: Media groups

- [ ] Media group buffer:
  - [ ] Первое фото в группе -> insert в buffer + reply "📸 Принимаю альбом, секунду...".
  - [ ] Последующие фото с тем же media_group_id -> только insert в buffer, без reply.
- [ ] `cron-media-group-sweep/index.ts`:
  - [ ] Cron-auth.
  - [ ] Каждые 2 минуты.
  - [ ] Группы старше 30 секунд -> обработать.
  - [ ] Лимит 5 фото в группе.
  - [ ] Каждое фото -> independent flow как M9.
  - [ ] Один сводный reply на группу.
  - [ ] Delete из buffer после обработки.
- [ ] Тест `tests/media_group_recovery.test.ts`: 3 фото в группе -> sweep обрабатывает все 3.
- [ ] Тест: 7 фото -> первые 5 обработаны, остальные silently игнорируются (log warning).
- [ ] Commit: `feat(media_group): album processing via cron sweep`.

---

## M11: Edited + high-amount confirmation

- [ ] Edited message handler:
  - [ ] `select expenses where telegram_message_id = ? and family_member_id = ?`.
  - [ ] Update `archived=true` для всех (audit trigger зафиксирует archive).
  - [ ] **Затем** hard delete.
  - [ ] Прогнать pipeline с line_index=0.
  - [ ] Reply "♻️ Запись обновлена".
- [ ] High-amount flow:
  - [ ] При insert если `amount_pln > 200`: `needs_confirmation=true`.
  - [ ] Reply с inline keyboard "✅ Да / ✏️ Изменить / ❌ Отмена".
  - [ ] Callback `conf_yes`: `needs_confirmation=false`.
  - [ ] Callback `conf_no`: `archived=true`.
  - [ ] Callback `conf_edit`: открыть категорий меню.
- [ ] `cron-auto-confirm/index.ts`:
  - [ ] Каждую минуту.
  - [ ] `update expenses set needs_confirmation=false where needs_confirmation=true and created_at < now() - interval '60 seconds'`.
- [ ] Тест `tests/idempotency_edited.test.ts`: edited длинный -> короткий -> длинный.
- [ ] Тест `tests/high_amount.test.ts`:
  - [ ] 200 PLN -> needs_confirmation.
  - [ ] Через 60 сек auto-confirm.
  - [ ] Отмена -> archived=true.
- [ ] Commit: `feat(edge): edited and high-amount confirmation`.

---

## M12: Mini App API endpoints

- [ ] `_shared/webapp_auth.ts`:
  - [ ] HMAC-SHA256 validation Telegram initData.
  - [ ] TTL 24 часа.
  - [ ] `family_member_id` извлекается из verified initData.
- [ ] `_shared/cors.ts`:
  - [ ] Allow: `web.telegram.org`, `<gh-user>.github.io`.
  - [ ] OPTIONS preflight.
- [ ] Endpoints (каждый возвращает JSON, требует валидную initData кроме api-health-public):
  - [ ] `api-me`: текущий user + family.
  - [ ] `api-stats?period=...`: KPI.
  - [ ] `api-transactions?limit=...`: список с пагинацией + поиск.
  - [ ] `api-categories`.
  - [ ] `api-family`.
  - [ ] `api-export?period=...`: CSV.
  - [ ] `api-health` (admin only).
  - [ ] `api-health-public`: 200/503 без деталей.
- [ ] Query-параметр идентификации игнорируется (берётся из initData).
- [ ] Rate limit (опционально через таблицу rate_limit).
- [ ] Тесты:
  - [ ] `tests/webapp_auth.test.ts`: правильный HMAC ok, неправильный 401, истёкший 401.
  - [ ] `tests/webapp_cross_user.test.ts`: попытка получить чужие данные -> 403 или возврат своих.
  - [ ] Тест на каждый endpoint.
- [ ] Commit: `feat(api): mini app endpoints with auth`.

---

## M13: Mini App frontend на GitHub Pages

- [ ] `webapp/index.html`:
  - [ ] Telegram WebApp SDK script.
  - [ ] Access gating: без initData -> заглушка.
  - [ ] Использует CSS variables Telegram WebApp.
- [ ] `webapp/styles.css`: vanilla, mobile-first.
- [ ] `webapp/app.js`:
  - [ ] `fetchAPI(path)` с `Authorization: tma <initData>`.
  - [ ] Виджеты:
    - [ ] KPI карточки (3).
    - [ ] Donut по категориям.
    - [ ] Line chart по дням.
    - [ ] Horizontal bar топ-5 категорий.
    - [ ] Stacked bar по членам семьи.
    - [ ] Список транзакций с поиском.
    - [ ] Кнопка CSV export.
- [ ] `webapp/tg-webapp.js`: обёртка над Telegram.WebApp.
- [ ] Никакого `localStorage`/`sessionStorage`.
- [ ] Chart.js через CDN с фиксированной версией.
- [ ] GitHub Pages включён через `gh api`.
- [ ] Первый deploy в gh-pages branch успешен.
- [ ] `https://<username>.github.io/<repo>/` открывается.
- [ ] Без initData видна заглушка.
- [ ] Виджеты рендерятся на моковых данных (или с реальной БД если есть).
- [ ] CSV экспорт работает (скачивает файл).
- [ ] Commit: `feat(webapp): mini app frontend`.

---

## M14: Cron jobs activated

- [ ] Все cron Edge Functions созданы (см. M3, M6, M7, M10, M11 - часть уже создана, тут проверь
      полноту):
  - [ ] `cron-recurring`.
  - [ ] `cron-retention`.
  - [ ] `cron-anomaly`.
  - [ ] `cron-retraining` (из M6).
  - [ ] `cron-auto-confirm` (из M11).
  - [ ] `cron-retry-failed` (из M3).
  - [ ] `cron-media-group-sweep` (из M10).
  - [ ] `cron-rates` (из M7).
- [ ] `cron-recurring/index.ts`: end-of-month logic с 4 кейсами.
- [ ] `cron-retention/index.ts`: фото > 90 дней удаляются из Storage.
- [ ] `cron-anomaly/index.ts`: daily check > 3x от 7-day avg -> notify admin.
- [ ] Heartbeat: pg_cron `update system_health` напрямую через SQL.
- [ ] Новая миграция `0008_cron_activate.sql`:
  - [ ] Unschedule всех имён (для idempotency).
  - [ ] Schedule всех jobs.
- [ ] Скрипт `scripts/configure_cron.sh`:
  - [ ] `alter database postgres set app.functions_url = ...`.
  - [ ] `alter database postgres set app.cron_secret = ...`.
- [ ] Скрипт выполнен.
- [ ] `psql -c "select jobname, schedule, active from cron.job"` показывает все jobs active.
- [ ] Тесты:
  - [ ] `tests/recurring_eom.test.ts`: 4 кейса (15-й, 31 января, 31 февраля 2027, 31 февраля 2028
        високосный).
  - [ ] `tests/retention.test.ts`.
  - [ ] `tests/anomaly.test.ts`.
- [ ] Commit: `feat(cron): all scheduled jobs active`.

---

## M15: Backup + restore + safety gate

- [ ] `cron-backup/index.ts`:
  - [ ] Safety gate: проверка `system_health.backup_key_confirmed`.
  - [ ] Export всех таблиц в JSON (пачками).
  - [ ] Gzip через CompressionStream.
  - [ ] Encrypt через age (`BACKUP_ENCRYPTION_KEY`).
  - [ ] Upload в GitHub Releases (tag `backup-YYYY-MM-DD`).
  - [ ] Удалить releases > 12 недель.
  - [ ] Integrity check: re-download, decrypt, decompress, check counts.
  - [ ] При неудаче integrity: notify admin.
- [ ] `/health backup-confirm` команда (admin) ставит флаг.
- [ ] `scripts/restore.ts`:
  - [ ] gh release download.
  - [ ] Запрос private age key у пользователя через stdin (не env).
  - [ ] Decrypt + decompress.
  - [ ] Confirm перед каждой таблицей.
  - [ ] Truncate + bulk insert.
- [ ] Тест `tests/backup_safety_gate.test.ts`.
- [ ] Тест `tests/backup_integrity.test.ts`.
- [ ] Commit: `feat(backup): weekly to github releases with safety gate`.

---

## M16: CI/CD

- [ ] `.github/workflows/test.yml` точно по SPEC §14.1.
- [ ] `.github/workflows/deploy.yml` точно по SPEC §14.2:
  - [ ] Apply migrations.
  - [ ] Deploy functions.
  - [ ] Health check + auto-revert on failure.
  - [ ] `[no-auto-revert]` метка предотвращает infinite loop.
  - [ ] Deploy webapp через `peaceiris/actions-gh-pages`.
- [ ] GitHub secrets:
  - [ ] `SUPABASE_ACCESS_TOKEN`.
  - [ ] `SUPABASE_PROJECT_REF`.
  - [ ] `SUPABASE_DB_PASSWORD`.
- [ ] Branch protection main:
  - [ ] required_status_checks включает test workflow.
  - [ ] enforce_admins=false (чтобы Claude Code мог обходить).
- [ ] Тест 1: сломанная feature ветка -> tests fail -> PR не мержится. **Проверено.**
- [ ] Тест 2: рабочая фича через PR -> deploy -> health OK. **Проверено.**
- [ ] Тест 3: код ломающий health-public -> auto-revert PR создан. **Проверено.**
- [ ] Тест 4: revert содержит `[no-auto-revert]`, loop невозможен. **Проверено.**
- [ ] Документация setup в README.
- [ ] Commit: `feat(ci): test and deploy with auto-revert`.

---

## M17: DR testing

- [ ] Симуляция: backup -> download -> restore.ts локально -> данные на месте.
- [ ] Симуляция: revert через GitHub UI -> deploy откатывает.
- [ ] Runbook "DR" в README:
  - [ ] Bug в новой функции -> auto-revert.
  - [ ] Один Edge Function упал -> auto-restart.
  - [ ] Supabase project заблокирован -> новый project + restore + setWebhook.
  - [ ] Telegram bot заблокирован -> новый bot + secrets + setWebhook.
  - [ ] GitHub repo удалён -> локальные клоны + mirror.
  - [ ] Backup encryption key потерян -> критично, безвозвратно.
  - [ ] pg_cron не выполняет -> unschedule + reschedule.
- [ ] Commit: `feat(dr): disaster recovery tested`.

---

## M18: Docs и финал

- [ ] README.md полный:
  - [ ] Описание проекта.
  - [ ] Бейджи Actions.
  - [ ] Quickstart (5 ручных шагов).
  - [ ] Architecture (Mermaid или ASCII).
  - [ ] Setup GitHub Secrets.
  - [ ] Troubleshooting секция (DR runbook).
- [ ] BACKLOG.md соответствует SPEC §22.
- [ ] Coverage:
  - [ ] `supabase/functions/` >= 80%.
  - [ ] `supabase/functions/_shared/` >= 90%.
- [ ] Финальный e2e чек по SPEC §19 (пройди каждый пункт):
  - [ ] Голосовое создаёт запись < 10 сек.
  - [ ] Voice > 5 мин rejected.
  - [ ] Фото JPEG/HEIC обрабатывается.
  - [ ] Альбом через sweep.
  - [ ] `/undo` archive.
  - [ ] Повтор не дублирует.
  - [ ] Edited работает.
  - [ ] Recategorize ставит corrected_by_user.
  - [ ] Сбой API -> pending_retry.
  - [ ] Mini App работает.
  - [ ] Cross-user -> 403.
  - [ ] CSV export.
  - [ ] Per-user/global budget.
  - [ ] Recurring 31 в феврале -> 28/29.
  - [ ] High-amount auto-confirm 60 сек.
  - [ ] Push feature -> test green.
  - [ ] Merge -> deploy -> health 200.
  - [ ] Сломанный health -> auto-revert.
  - [ ] Backup safety gate.
  - [ ] Heartbeat в system_health каждую минуту.
  - [ ] Photos > 90 дней purge.
- [ ] `git tag v1.0.0 && git push origin v1.0.0`.
- [ ] Commit: `docs: readme, backlog, troubleshooting`.
- [ ] Финальный отчёт пользователю (см. CLAUDE.md раздел 7).
- [ ] `docs/STATE.md` финализирован: `current_milestone: DONE`.

---

Конец 07_CHECKLISTS.md.
