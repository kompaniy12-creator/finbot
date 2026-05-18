# 15 E2E_TESTING, end-to-end проверки через реальный Telegram

Этот документ описывает когда и как делать smoke-тесты через реальный задеплоенный webhook. Это
**не** unit-тесты (те описаны в 04_TESTING.md). Это проверки что система реально работает с боевыми
внешними API.

## 1. Когда делать E2E

| Когда                            | Что проверять                                              |
| -------------------------------- | ---------------------------------------------------------- |
| После M3 (idempotency)           | T1 /start, T3 idempotency                                  |
| После M4 (auth)                  | T1, T4 unauthorized                                        |
| После M7 (text + currency)       | T1, T2 text expense, T3 idempotency, T4 unauthorized       |
| После M11 (edited + high amount) | T1-T4 + edited message, high-amount confirmation           |
| После M13 (webapp)               | T6 mini app reachable, T7 mini app unauth                  |
| После M14 (cron)                 | T8 cron jobs ran recently                                  |
| После M16 (CI/CD)                | Полный smoke + проверка auto-revert (искусственно сломав)  |
| Перед M18 tag v1.0.0             | Все T1-T8 + manual UI check в Telegram + manual в Mini App |

Слайс субагента: `e2e-tester` автоматизирует T1-T8 без участия пользователя.

## 2. Полный список E2E тестов

См. `.claude/agents/e2e-tester.md` детально. Краткий список:

- **T1**: /start от админа -> 200 + Telegram reply.
- **T2**: text expense -> 200 + строка в expenses table.
- **T3**: повтор T2 с тем же message_id -> count = 1 (idempotency).
- **T4**: запрос от неавторизованного telegram_id -> reject + admin alert.
- **T5**: GET api-health-public -> 200.
- **T6**: GET github.io/<repo>/ -> 200.
- **T7**: GET api-stats без initData -> 401.
- **T8**: cron heartbeat запускался < 2 минут назад.

## 3. Manual UI check перед v1.0.0

E2E через curl не покрывает UX. Перед tag v1.0.0 Claude Code должен запросить **Серхия** провести
ручную проверку в Telegram:

```
Финальная проверка перед v1.0.0. Прошу тебя пройти этот список в Telegram. Это последнее активное участие, дальше всё работает само.

[ ] 1. /start. Бот ответил приветствием.
[ ] 2. Напиши: "купил кофе 15 zł". Бот ответил подтверждением, категория "Кафе и рестораны".
[ ] 3. Голосовое 5-10 сек: "потратил на хлеб 4 злотых". Бот распознал.
[ ] 4. Фото чека из любого магазина. Бот вернул сводку.
[ ] 5. /undo. Последняя запись отменена.
[ ] 6. /history. Показались последние 10 трат.
[ ] 7. /dashboard. Открылся Mini App в Telegram. Графики рендерятся, числа отличны от 0.
[ ] 8. В Mini App нажми "Экспорт CSV". Скачался файл.
[ ] 9. Напиши: "купил телевизор 1500 zł". Бот спросил подтверждение (high-amount).
[ ] 10. Подожди 60 секунд. Бот написал "Записано автоматически".
[ ] 11. /health (если ты админ). Бот показал все зелёные.

Если что-то красное - напиши, я пофикшу. Если всё ок - подтверди, я делаю tag v1.0.0.
```

Это единственное место, где Claude Code просит участие пользователя за всю работу (помимо первого
bootstrap и редких блокеров из CLAUDE.md правило 3).

## 4. Curl-based smoke (без участия Серхия)

Для T1-T8 Claude Code сам всё делает через curl + psql. Не требует чтобы Серхий что-то нажимал.

Пример полного smoke run:

```bash
# load env
set -a
source .env
set +a

WEBHOOK_URL="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/tg-webhook?secret=${TELEGRAM_BOT_TOKEN}"

# T1: /start
curl -fsS -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"update_id\": $RANDOM,
    \"message\": {
      \"message_id\": $RANDOM,
      \"date\": $(date +%s),
      \"chat\": {\"id\": $TELEGRAM_ADMIN_TELEGRAM_ID, \"type\": \"private\"},
      \"from\": {\"id\": $TELEGRAM_ADMIN_TELEGRAM_ID, \"is_bot\": false, \"first_name\": \"Test\"},
      \"text\": \"/start\"
    }
  }" -o /tmp/r1.json -w "T1: %{http_code}\n"

# и так далее T2..T8
```

## 5. Возможные false negatives в E2E

E2E может сообщить fail когда на самом деле всё ок:

- **Async обработка:** Claude Code должен дать 3-5 секунд после POST перед проверкой DB. T2 в
  e2e-tester subagent уже включает `sleep 4`.
- **Rate limit Telegram:** если за минуту много POST, Telegram bot API может затроттлить. Решение:
  пауза 1-2 сек между T1-T8.
- **Race condition с cron:** между insert и cron-auto-confirm может быть гонка. Для T2 не запускать
  cron-auto-confirm рядом, либо проверять `needs_confirmation` сразу после insert.
- **Heartbeat задержан:** если pg_cron schedule только что активирован, первый запуск может быть с
  задержкой до 1 минуты. T8 может быть `degraded` сразу после M14.

## 6. Smoke-результаты и решение о продвижении

После запуска e2e-tester subagent:

- Все T1-T8 pass -> Claude Code commit + push milestone + переход к следующему.
- 1-2 теста degraded (не критичные, например T8) -> Claude Code commits, добавляет note в STATE.md,
  переходит. На M18 эти deferred should be cleared.
- Критичный test fail (T2 text expense, T5 health, T6 mini app для post-M13) -> Claude Code НЕ
  продвигается. Запускает troubleshooter subagent, чинит, перезапускает e2e-tester.

## 7. Локальный smoke без deploy (опционально)

Если deploy ещё не настроен (M1-M15), но хочется e2e:

```bash
supabase functions serve tg-webhook --env-file .env --no-verify-jwt &
SERVE_PID=$!
sleep 5

LOCAL_URL="http://127.0.0.1:54321/functions/v1/tg-webhook?secret=${TELEGRAM_BOT_TOKEN}"

curl -fsS -X POST "$LOCAL_URL" -H "Content-Type: application/json" -d '{"update_id":1,"message":{"message_id":1,"date":1700000000,"chat":{"id":1,"type":"private"},"from":{"id":1,"is_bot":false,"first_name":"Test"},"text":"/start"}}' -o /dev/null -w "%{http_code}\n"

kill $SERVE_PID 2>/dev/null
```

Не рекомендуется как замена E2E на боевом deploy, но полезно для быстрой проверки во время
разработки M1-M11.

## 8. E2E в CI

В deploy.yml workflow после `Health check` step можно добавить minimal smoke:

```yaml
- name: Smoke test
  run: |
    sleep 10
    PROJECT_REF="${{ secrets.SUPABASE_PROJECT_REF }}"
    curl -fsS -o /dev/null -w "%{http_code}" "https://${PROJECT_REF}.supabase.co/functions/v1/api-health-public" | grep -q 200
```

Полный E2E (T1-T8) в CI не запускаем чтобы не создавать тестовые expenses в production DB.

---

Конец 15_E2E_TESTING.md.
