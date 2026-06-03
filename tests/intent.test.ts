import { assertEquals } from "@std/assert";
import { classifyIntent } from "../supabase/functions/_shared/intent.ts";

Deno.test("intent: question word at start → question", () => {
  assertEquals(classifyIntent("сколько я потратил на еду"), "question");
  assertEquals(classifyIntent("Как считал?"), "question");
  assertEquals(classifyIntent("почему так много"), "question");
  assertEquals(classifyIntent("how much did I spend"), "question");
  assertEquals(classifyIntent("Покажи топ категорий"), "question");
});

Deno.test("intent: question mark anywhere → question", () => {
  assertEquals(classifyIntent("а ты понял?"), "question");
  assertEquals(classifyIntent("это не нормально, разве нет?"), "question");
});

Deno.test("intent: greeting / acknowledgement → question (analyst)", () => {
  assertEquals(classifyIntent("привет"), "question");
  assertEquals(classifyIntent("Спасибо"), "question");
  assertEquals(classifyIntent("ок"), "question");
});

Deno.test("intent: number + currency word → expense", () => {
  assertEquals(classifyIntent("кофе 12 zł"), "expense");
  assertEquals(classifyIntent("бензин 200 zl"), "expense");
  assertEquals(classifyIntent("электричество 9565 лек"), "expense");
  assertEquals(classifyIntent("такси 8 €"), "expense");
  assertEquals(classifyIntent("groceries 130 PLN"), "expense");
});

Deno.test("intent: number without currency → expense (parser owns it)", () => {
  // No currency word, but the parser defaults to PLN; keep the heuristic
  // simple and let the parser decide.
  assertEquals(classifyIntent("кофе 12"), "expense");
  assertEquals(classifyIntent("100"), "expense");
});

Deno.test("intent: pure text / chitchat → question", () => {
  assertEquals(classifyIntent("я устал"), "question");
  assertEquals(classifyIntent("давай посмотрим"), "question");
  assertEquals(classifyIntent("ну ладно"), "question");
});

Deno.test("intent: empty / whitespace → question", () => {
  assertEquals(classifyIntent(""), "question");
  assertEquals(classifyIntent("   "), "question");
});

Deno.test("intent: question word wins over number+currency", () => {
  // "Сколько я потратил вчера 200 zl?" looks ambiguous but contains the
  // question marker - the analyst is the right destination, it can read the
  // user's own data and answer (not record a phantom 200 zl line).
  assertEquals(
    classifyIntent("Сколько я потратил вчера 200 zl?"),
    "question",
  );
});

Deno.test("intent: word boundary - 'какойто' (no boundary) is not a question word", () => {
  // The Russian "какой" is a question word; "какойто" (informal "some kind
  // of") is not a question. Word-boundary regex must distinguish them.
  // Note: without a clear digit or currency, this still falls through to
  // "question" by rule 5 - that's fine. We just want to make sure the regex
  // boundary works on "какой" itself.
  assertEquals(classifyIntent("какой кофе купил"), "question"); // real question
});

import { detectPhotoKind } from "../supabase/functions/_shared/intent.ts";

Deno.test("detectPhotoKind: empty caption → expense", () => {
  assertEquals(detectPhotoKind(""), "expense");
  assertEquals(detectPhotoKind("   "), "expense");
});

Deno.test("detectPhotoKind: income category names → income", () => {
  assertEquals(detectPhotoKind("Зарплата"), "income");
  assertEquals(detectPhotoKind("Дивиденды"), "income");
  assertEquals(detectPhotoKind("Девиденды"), "income"); // common typo
  assertEquals(detectPhotoKind("Фриланс"), "income");
  assertEquals(detectPhotoKind("Подарок"), "income");
});

Deno.test("detectPhotoKind: income keywords in middle → income", () => {
  assertEquals(detectPhotoKind("пришла зарплата за июнь"), "income");
  assertEquals(detectPhotoKind("PayPal salary"), "income");
  assertEquals(detectPhotoKind("вернули долг от Васи"), "income");
  assertEquals(detectPhotoKind("получил кэшбэк"), "income");
});

Deno.test("detectPhotoKind: generic captions stay expense", () => {
  assertEquals(detectPhotoKind("Lidl"), "expense");
  assertEquals(detectPhotoKind("Магазин у дома"), "expense");
  assertEquals(detectPhotoKind("чек за бензин"), "expense");
  assertEquals(detectPhotoKind("Уличные собаки"), "expense");
});
