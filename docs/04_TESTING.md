# 04 TESTING, стратегия тестирования

## 1. Уровни

- **Unit** (большинство): тестируют одну функцию или модуль. Все внешние сервисы (Anthropic, Groq,
  Telegram, GitHub, NBP, exchangerate.host) замокированы.
- **Integration** (опционально, `RUN_INTEGRATION=1`): тестируют связку с реальным локальным Supabase
  emulator.
- **E2E** (только локально, `RUN_E2E=1`): отправка реального сообщения боту, проверка БД. **Не
  запускаются в CI.**

## 2. Файлы и расположение

```
tests/
├── fixtures/
│   ├── receipts/
│   │   ├── receipt_jpeg_simple.jpg
│   │   ├── receipt_heic_lidl.heic
│   │   ├── receipt_jpeg_long.jpg
│   │   └── receipt_jpeg_blurry.jpg
│   ├── voice/
│   │   ├── voice_ru_kofe.ogg
│   │   ├── voice_uk_moloko.ogg
│   │   └── voice_pl_chleb.ogg
│   ├── parsed_responses.json     # Mock outputs от Claude
│   ├── groq_responses.json       # Mock outputs от Groq
│   ├── telegram_updates.json     # Sample webhook payloads
│   └── exchange_rates.json       # Sample NBP/exchangerate.host
├── tg-webhook.test.ts
├── categorizer.test.ts
├── currency.test.ts
├── currency_holidays.test.ts
├── recurring_eom.test.ts
├── idempotency.test.ts
├── idempotency_edited.test.ts
├── media_group_recovery.test.ts
├── high_amount.test.ts
├── webapp_auth.test.ts
├── webapp_cross_user.test.ts
├── audit_log.test.ts
├── budget_per_user.test.ts
├── parse_dates_tz.test.ts
├── image.test.ts
└── helpers/
    ├── mock_anthropic.ts
    ├── mock_groq.ts
    ├── mock_telegram.ts
    ├── mock_supabase.ts
    └── seed_db.ts
```

## 3. Запуск

```bash
deno task test                    # все тесты (unit only, без integration/e2e)
deno test tests/categorizer.test.ts   # один файл
deno task test --filter "edge case"   # по имени
deno test --coverage=cov tests/
deno coverage cov                 # репорт
deno coverage cov --include="supabase/functions" --exclude="tests"
```

## 4. Шаблон unit-теста

```typescript
// tests/categorizer.test.ts
import { assertEquals } from "jsr:@std/assert@1.0.0";
import { categorize } from "../supabase/functions/_shared/categorizer.ts";
import { mockSupabase } from "./helpers/mock_supabase.ts";

Deno.test("categorizer: knn finds groceries for 'milk'", async () => {
  const sb = mockSupabase({
    rpc: {
      match_expenses: [
        { id: "x", name: "молоко", category_id: "groceries-id", similarity: 0.92 },
      ],
    },
  });
  const result = await categorize("milk", "family-1", sb);
  assertEquals(result.category_id, "groceries-id");
  assertEquals(result.source, "knn");
});

Deno.test("categorizer: claude fallback when no knn match", async () => {
  // ...
});
```

## 5. Моки внешних API

### 5.1 Anthropic

В `tests/helpers/mock_anthropic.ts`:

```typescript
import { Anthropic } from "npm:@anthropic-ai/sdk@0.40.0";

export function mockAnthropic(responses: Record<string, unknown>) {
  return {
    messages: {
      create: async (params: { messages: { content: string }[] }) => {
        const key = params.messages[0]?.content?.toString().slice(0, 50);
        return responses[key] ?? responses["default"];
      },
    },
  } as unknown as Anthropic;
}
```

Используется в `_shared/claude.ts` через DI:

```typescript
export function makeClaude(client?: Anthropic) {
  const c = client ?? new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  return {
    parseExpense: async (text: string) => { ... },
    parseReceipt: async (imageUrl: string) => { ... },
  };
}
```

### 5.2 Groq

Аналогично. Записываем ожидаемые ответы в `groq_responses.json`:

```json
{
  "voice_ru_kofe.ogg": {
    "text": "купил кофе за 18 злотых",
    "x_groq": { "id": "...", "duration": 2.5 }
  },
  "voice_uk_moloko.ogg": {
    "text": "купив молоко за 4 злотих",
    "x_groq": { "id": "...", "duration": 1.8 }
  }
}
```

### 5.3 Telegram

В `tests/fixtures/telegram_updates.json` положи sample updates (message, edited_message,
callback_query, photo, voice, media_group). Используй их как input для тестов handler'ов.

### 5.4 Supabase

Самый простой вариант: написать `mockSupabase()` с in-memory таблицами. Можно по проще: через
`npm:@supabase/supabase-js` со стабом fetch:

```typescript
export function mockSupabase(seed: Partial<Database>) {
  const tables: Record<string, unknown[]> = { ...seed };
  return {
    from(table: string) {
      return {
        select: (cols: string) => Promise.resolve({ data: tables[table], error: null }),
        insert: (rows: unknown[]) => {
          tables[table] = [...(tables[table] ?? []), ...rows];
          return Promise.resolve({ data: rows, error: null });
        },
        // ... и т.д.
      };
    },
    rpc(name: string, args: unknown) {
      // вернуть из seed.rpc[name]
    },
  };
}
```

Не пытайся 100% воспроизвести API supabase-js. Достаточно того, что используется в коде.

## 6. Required edge-case tests (SPEC §18.4)

Эти тесты обязательны до v1.0.0:

- [x] `tests/idempotency.test.ts`, простой повтор.
- [x] `tests/idempotency_edited.test.ts`, edited message hard-delete + reinsert.
- [x] `tests/currency_holidays.test.ts`, запрос на праздник -> fallback на предыдущий рабочий день.
- [x] `tests/recurring_eom.test.ts`, 4 кейса:
  1. `day_of_month=15`, февраль -> 15 февраля.
  2. `day_of_month=31`, январь -> 31 января.
  3. `day_of_month=31`, февраль (не-високосный) -> 28 февраля.
  4. `day_of_month=31`, февраль (високосный 2028) -> 29 февраля.
- [x] `tests/webapp_cross_user.test.ts`, попытка получить чужие данные через initData manipulation
      -> 403.
- [x] `tests/media_group_recovery.test.ts`, sweep подбирает группу старше 30 сек.
- [x] `tests/parse_dates_tz.test.ts`, "вчера" в 23:00 Warsaw -> правильная дата с учётом tz.
- [x] `tests/high_amount.test.ts`, > 200 PLN -> needs_confirmation, auto-confirm после 60 сек.

## 7. Coverage цели

- `supabase/functions/`: **>= 80%**.
- `supabase/functions/_shared/`: **>= 90%**.
- `webapp/`: ручное тестирование, coverage не считаем.

После каждого milestone:

```bash
deno test --allow-all --coverage=cov tests/
COV_FUNCTIONS=$(deno coverage cov --include="supabase/functions/" --exclude="supabase/functions/_shared/" 2>/dev/null | tail -1 | grep -oP '\d+\.\d+')
COV_SHARED=$(deno coverage cov --include="supabase/functions/_shared/" 2>/dev/null | tail -1 | grep -oP '\d+\.\d+')

awk -v c="$COV_FUNCTIONS" 'BEGIN{exit !(c+0 >= 80)}' || { echo "functions coverage $COV_FUNCTIONS < 80"; exit 1; }
awk -v c="$COV_SHARED" 'BEGIN{exit !(c+0 >= 90)}' || { echo "_shared coverage $COV_SHARED < 90"; exit 1; }
```

## 8. Где брать фикстуры

### Изображения чеков

Сгенерируй сам через простую программу: создай 4 разных PNG/JPG-файла, нарисуй на каждом простой
"чек" с merchant name, датой, позициями, total. Можно через canvas в html (open in browser,
screenshot). Или просто скачай несколько public domain receipt photos с unsplash.com и переименуй.

Один из четырёх должен быть **HEIC** (для тестирования conversion). Если у тебя нет генератора HEIC:
можно создать минимальный HEIC через `npm:heic-convert` в обратную сторону (decode jpeg -> encode
heic), либо положить заглушку и тестировать только error path.

### Voice ogg

Сгенерируй через TTS (`espeak` или онлайн TTS-сервисы) короткие фразы. Сохрани в `.ogg` через
ffmpeg. Если нет инструментов локально - можно использовать pure-JS TTS либо просто положить файл
`silence.ogg` (1 секунда тишины) и **моки Groq** возвращают нужный текст. Главное чтобы webhook
handler не упал на download/upload, а реальный transcribe замокирован.

### Telegram updates

В `tests/fixtures/telegram_updates.json` - возьми из Telegram Bot API docs `getUpdates` examples,
или из реальных логов своего бота на dev-стадии (запиши update'ы в файл при первом тестовом
сообщении).

## 9. Тесты SQL миграций

После `supabase db reset` (или `db push --debug`) проверяем что:

- Все таблицы созданы.
- Аудит-триггер на expenses реально пишет в expense_audit при insert.
- Storage bucket существует.

Тест в `tests/audit_log.test.ts` через `psql` (requires `SUPABASE_DB_URL` env, integration tier):

```typescript
Deno.test({
  name: "audit log on insert",
  ignore: !Deno.env.get("RUN_INTEGRATION"),
  fn: async () => {
    // psql -c "insert into expenses (...) values (...)"
    // psql -c "select count(*) from expense_audit where expense_id = ..."
    // assertEquals(...)
  },
});
```

## 10. CI

В `.github/workflows/test.yml` гонится `deno task test` без integration/e2e. Для unit-тестов
достаточно.

---

Конец 04_TESTING.md.
