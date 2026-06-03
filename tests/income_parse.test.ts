// Parser schema must accept and default the kind field correctly.
// Doesn't talk to Claude - only verifies the Zod schema contract.
import { assertEquals } from "@std/assert";
import { ParsedExpenseRowSchema } from "../supabase/functions/_shared/prompts/parse_expense.ts";

Deno.test("ParsedExpenseRow: kind defaults to 'expense' when omitted", () => {
  const row = ParsedExpenseRowSchema.parse({
    name: "кофе",
    name_normalized_en: "coffee",
    amount: 12,
    currency: "PLN",
    expense_date: "2026-06-04",
  });
  assertEquals(row.kind, "expense");
});

Deno.test("ParsedExpenseRow: kind='income' is accepted", () => {
  const row = ParsedExpenseRowSchema.parse({
    kind: "income",
    name: "зарплата",
    name_normalized_en: "salary monthly wage",
    amount: 5000,
    currency: "PLN",
    expense_date: "2026-06-04",
  });
  assertEquals(row.kind, "income");
});

Deno.test("ParsedExpenseRow: kind='other' is rejected", () => {
  let threw = false;
  try {
    ParsedExpenseRowSchema.parse({
      kind: "other",
      name: "x",
      name_normalized_en: "x",
      amount: 1,
      currency: "PLN",
      expense_date: "2026-06-04",
    });
  } catch (_) {
    threw = true;
  }
  assertEquals(threw, true);
});
