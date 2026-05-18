# 13 AGENTS, использование субагентов

В пакете `.claude/agents/` живут 11 специализированных субагентов. Каждый имеет узкую зону
ответственности и собственный системный промпт. Это позволяет:

1. **Параллелизм:** один subagent работает над миграцией, другой над тестом, главный agent
   координирует.
2. **Изоляция контекста:** subagent имеет чистый контекст, без шума от предыдущих шагов. Полезно при
   упирании в context window.
3. **Специализация:** subagent имеет более узкие правила, что снижает шанс ошибки.

## Список субагентов

| Имя                        | Назначение                                  | Триггеры                                   |
| -------------------------- | ------------------------------------------- | ------------------------------------------ |
| `migration-writer`         | Пишет SQL миграции с idempotency            | "create migration", "modify schema"        |
| `test-writer`              | Пишет Deno.test файлы                       | "add tests", "coverage gap on file X"      |
| `edge-function-builder`    | Создаёт новую Edge Function                 | "scaffold cron-X", "create api-Y endpoint" |
| `deploy-verifier`          | Read-only health check после deploy         | "verify deploy", после `gh pr merge`       |
| `troubleshooter`           | Диагностирует ошибки, предлагает фиксы      | bash fail, deploy fail, test fail          |
| `security-auditor`         | Сканирует на security issues                | перед каждым commit, перед v1.0.0          |
| `coverage-checker`         | Запускает coverage и идентифицирует пробелы | после milestone, перед v1.0.0              |
| `spec-conformance-checker` | Проверяет соответствие SPEC.md              | M11, M14, M18                              |
| `prompt-engineer`          | Дорабатывает Anthropic prompts FinBot'а     | tweak parse_expense, cache_control         |
| `webapp-builder`           | Mini App frontend (vanilla HTML/CSS/JS)     | M13 целиком                                |
| `e2e-tester`               | E2E smoke через реальный webhook            | после M14+                                 |

## Когда использовать subagent vs делать самому

### Используй subagent:

- Задача узкая и хорошо подходит под одну зону ответственности (миграция, тест, фикс).
- Контекст main agent уже заполнен, нужно делегировать чистый контекст.
- Нужна параллельная работа (например, M2 миграции и M3 idempotency module одновременно).
- Задача требует **проверки** (deploy-verifier, security-auditor, spec-conformance-checker,
  coverage-checker).

### НЕ используй subagent:

- Маленькая правка одной строки.
- Решение, которое требует знания контекста всего проекта.
- Если ты главный agent и уже глубоко в задаче, проще доделать чем переключаться.

## Делегирование, паттерны

### Паттерн A: Sequential delegation

Главный agent:

1. Завершил M2 step 1 (создал supabase setup).
2. Step 2 - 6 миграций. Делегирует migration-writer subagent с инструкцией "Generate migrations 0001
   to 0006 per SPEC §4".
3. Получает результат, проверяет имена файлов.
4. Step 3 - setup-once Edge Function. Делегирует edge-function-builder subagent.
5. Step 4 - тесты на audit trigger. Делегирует test-writer subagent.
6. Step 5 - проверка через psql. Делает сам.
7. Commit + push (главный сам, не делегирует, чтобы поддержать STATE.md).

### Паттерн B: Quality gate

Перед `git commit` на любом milestone:

1. Главный agent запускает security-auditor subagent.
2. Если critical findings - применяет фиксы.
3. Запускает coverage-checker (если milestone >= M3).
4. Если ниже порога - запускает test-writer.
5. Запускает deploy-verifier (если milestone >= M16).
6. Только когда все зелёные, commit + push.

Это реализовано в slash command `/milestone-complete`.

### Паттерн C: Failure handling

bash или test fail:

1. Главный agent ловит ошибку.
2. Запускает troubleshooter subagent с контекстом ошибки.
3. Получает YAML report с diagnosis + fix steps.
4. Применяет fix.
5. Повторяет команду.
6. Если опять fail - вторая итерация troubleshooter с обновлённым контекстом.
7. Третья итерация - стоп, сообщение пользователю (CLAUDE.md правило).

## Когда вызывается каждый агент по milestones

### M1: skeleton

- Никаких subagents, простой setup.

### M2: schema

- `migration-writer`: 6 миграций.
- `edge-function-builder`: setup-once function.
- `test-writer`: audit_trigger.test.ts.

### M3: idempotency + retry

- `test-writer`: idempotency.test.ts, idempotency_edited.test.ts (mandatory edge case),
  retry_queue.test.ts.

### M4: auth + commands

- `test-writer`: auth.test.ts, commands.test.ts.

### M5: claude + budget

- `prompt-engineer`: при необходимости тонкая настройка prompts.
- `test-writer`: budget tests.

### M6: embedder + categorizer

- `test-writer`: categorizer_knn, _fallback, _new, retraining.

### M7: text + currency

- `test-writer`: currency.test.ts, currency_holidays.test.ts, parse_dates_tz.test.ts,
  text_pipeline.test.ts.

### M8: voice

- `test-writer`: voice.test.ts, voice_duration.test.ts, voice_language.test.ts.

### M9: photo + receipts

- `prompt-engineer`: настройка parse_receipt prompt при необходимости.
- `test-writer`: 4 тестовых фикстуры receipts.

### M10: media groups

- `test-writer`: media_group_recovery.test.ts (mandatory edge case).

### M11: edited + high-amount

- `test-writer`: high_amount.test.ts (mandatory edge case).
- `spec-conformance-checker`: проверка M11 окончания.

### M12: api endpoints

- `edge-function-builder`: 8 api-* endpoints.
- `test-writer`: webapp_auth.test.ts, webapp_cross_user.test.ts (mandatory edge case).
- `security-auditor`: проверка что initData проверяется правильно.

### M13: webapp

- `webapp-builder`: целиком M13.

### M14: cron activation

- `migration-writer`: 0008_cron_activate.sql.
- `test-writer`: recurring_eom.test.ts (mandatory edge case).
- `spec-conformance-checker`: проверка M14.

### M15: backup

- `edge-function-builder`: cron-backup.
- `test-writer`: backup_safety_gate.test.ts, backup_integrity.test.ts.

### M16: CI/CD

- `security-auditor`: проверка отсутствия secrets в YAML workflows.

### M17: DR testing

- `deploy-verifier`: full check.
- `e2e-tester`: smoke testing.

### M18: docs + final

- `spec-conformance-checker`: full SPEC §19 check.
- `coverage-checker`: final coverage check.
- `security-auditor`: pre-v1.0.0 sweep.
- `e2e-tester`: final smoke test.

## Slash commands invoke subagents автоматически

| Slash command         | Какие subagents задействует                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/milestone-start N`  | Просто читает доки, не запускает subagents.                                                                      |
| `/milestone-complete` | security-auditor (always), coverage-checker (>= M3), spec-conformance-checker (>= M11), deploy-verifier (>= M16) |
| `/coverage`           | coverage-checker -> test-writer (loop)                                                                           |
| `/verify-deploy`      | deploy-verifier -> troubleshooter (если fail)                                                                    |
| `/security-scan`      | security-auditor                                                                                                 |

## Передача контекста в subagent

Когда главный agent делегирует, нужно передать достаточный контекст без раздувания:

**Хороший пример:**

> Test-writer: Add a test file `tests/idempotency_edited.test.ts` per `docs/07_CHECKLISTS.md` M3
> line for "idempotency_edited". The test should:
>
> 1. Insert an expense with telegram_message_id=100, family_member_id="fm-1", text "кофе 12 zł".
> 2. Simulate edited_message with same message_id but text "кофе 15 zł и булочка 5 zł".
> 3. Assert: 2 expenses now exist (kofe 15, bulochka 5), the original is hard-deleted (no
>    archived=true row remains), 3 audit rows exist (original insert, original archive, two new
>    inserts).
>
> Use `tests/helpers/mock_supabase.ts`. The handler under test is
> `supabase/functions/_shared/handlers/edited.ts` (you may need to read it).

**Плохой пример:**

> Test-writer: write tests for edited messages.

## Когда subagent не справился

Если subagent вернул что-то странное (например, "I refused because..." или нерелевантный output),
главный agent НЕ должен повторять запрос с теми же словами. Вместо этого:

1. Переформулировать с большей конкретикой.
2. Дать пример input/output.
3. Если две попытки не помогли - делать самому (не делегировать).

---

Конец 13_AGENTS.md.
