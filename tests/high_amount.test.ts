// Mandatory edge case (SPEC §18.4): high_amount.
// Verifies the inline-keyboard generator for high-amount confirmation
// (SPEC §6.6) and the threshold logic.

import { assertEquals } from "@std/assert";
import { highAmountKeyboard } from "../supabase/functions/tg-webhook/text_pipeline.ts";

const baseExpense = {
  name: "x",
  amount: 1,
  currency: "PLN",
  expense_date: "2026-05-19",
  category_name: "cat",
};

Deno.test("highAmountKeyboard: returns null when nothing needs confirmation", () => {
  const out = highAmountKeyboard({
    expenses: [
      { ...baseExpense, id: "e1", amount_pln: 50, needs_confirmation: false },
      { ...baseExpense, id: "e2", amount_pln: 100, needs_confirmation: false },
    ],
    warnings: [],
  });
  assertEquals(out, null);
});

Deno.test("highAmountKeyboard: builds Да/Изменить/Отмена for the first flagged expense", () => {
  const out = highAmountKeyboard({
    expenses: [
      { ...baseExpense, id: "e1", amount_pln: 50, needs_confirmation: false },
      { ...baseExpense, id: "e2", amount_pln: 250, needs_confirmation: true },
    ],
    warnings: [],
  });
  if (!out) throw new Error("expected keyboard");
  assertEquals(out.inline_keyboard.length, 1);
  const row = out.inline_keyboard[0]!;
  assertEquals(row.length, 3);
  assertEquals(row[0]!.text, "Да");
  assertEquals(row[0]!.callback_data, "conf_yes:e2");
  assertEquals(row[1]!.text, "Изменить");
  assertEquals(row[1]!.callback_data, "conf_edit:e2");
  assertEquals(row[2]!.text, "Отмена");
  assertEquals(row[2]!.callback_data, "conf_no:e2");
});

Deno.test("highAmountKeyboard: uses the FIRST flagged expense even if many", () => {
  const out = highAmountKeyboard({
    expenses: [
      { ...baseExpense, id: "first", amount_pln: 300, needs_confirmation: true },
      { ...baseExpense, id: "second", amount_pln: 500, needs_confirmation: true },
    ],
    warnings: [],
  });
  if (!out) throw new Error("expected keyboard");
  const row = out.inline_keyboard[0]!;
  assertEquals(row[0]!.callback_data.endsWith(":first"), true);
});
