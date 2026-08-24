// Unit tests for the refined receipt duplicate check (isRealDuplicate).
// Context: two receipts that share merchant + date + total + currency used to
// collapse into one. isRealDuplicate uses receipt_number, then receipt_time, as
// tie-breakers so genuinely different receipts are kept apart.

import { assertEquals } from "@std/assert";
import { isRealDuplicate } from "../supabase/functions/tg-webhook/photo_pipeline.ts";

Deno.test("different receipt numbers => not a duplicate", () => {
  assertEquals(
    isRealDuplicate({ receipt_number: "0007/2026" }, { receipt_number: "0008/2026" }),
    false,
  );
});

Deno.test("same receipt number => duplicate", () => {
  assertEquals(
    isRealDuplicate({ receipt_number: "0007/2026" }, { receipt_number: "0007/2026" }),
    true,
  );
});

Deno.test("receipt number compared case-insensitively and trimmed", () => {
  assertEquals(
    isRealDuplicate({ receipt_number: " ABC-12 " }, { receipt_number: "abc-12" }),
    true,
  );
});

Deno.test("incoming has a number, stored candidate has none => not a duplicate (re-upload vs pre-migration row)", () => {
  assertEquals(
    isRealDuplicate(
      { receipt_number: "123", receipt_time: "14:05" },
      { receipt_number: null, receipt_time: null },
    ),
    false,
  );
});

Deno.test("incoming number present but different from candidate => not a duplicate regardless of time", () => {
  assertEquals(
    isRealDuplicate(
      { receipt_number: "123", receipt_time: "14:05" },
      { receipt_number: "999", receipt_time: "14:05" },
    ),
    false,
  );
});

Deno.test("no numbers, different times => not a duplicate", () => {
  assertEquals(
    isRealDuplicate({ receipt_time: "09:15" }, { receipt_time: "17:52" }),
    false,
  );
});

Deno.test("no numbers, same time => duplicate", () => {
  assertEquals(
    isRealDuplicate({ receipt_time: "09:15:30" }, { receipt_time: "09:15:30" }),
    true,
  );
});

Deno.test("no discriminators at all => coarse match stays a duplicate (old behaviour)", () => {
  assertEquals(isRealDuplicate({}, {}), true);
  assertEquals(
    isRealDuplicate({ receipt_number: null, receipt_time: null }, {}),
    true,
  );
});

Deno.test("empty-string discriminators treated as absent", () => {
  assertEquals(
    isRealDuplicate({ receipt_number: "  ", receipt_time: "" }, { receipt_number: "x" }),
    true,
  );
});
