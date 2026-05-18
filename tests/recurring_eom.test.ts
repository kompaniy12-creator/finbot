// Mandatory edge case (SPEC §18.4): recurring_eom.
// SPEC §6 says day_of_month=31 must charge on the LAST day of any month
// (28 in Feb 2026, 29 in Feb 2028 leap year, 30 in April, etc).

import { assertEquals } from "@std/assert";
import { effectiveDate, lastDayOfMonth } from "../supabase/functions/_shared/eom.ts";

Deno.test("recurring_eom: 31 Jan -> 2026-01-31", () => {
  assertEquals(effectiveDate(2026, 0, 31), "2026-01-31");
});

Deno.test("recurring_eom: 31 Feb 2026 (non-leap) -> 2026-02-28", () => {
  assertEquals(effectiveDate(2026, 1, 31), "2026-02-28");
});

Deno.test("recurring_eom: 31 Feb 2028 (leap year) -> 2028-02-29", () => {
  assertEquals(effectiveDate(2028, 1, 31), "2028-02-29");
});

Deno.test("recurring_eom: 30 Feb (non-leap) -> 2026-02-28", () => {
  assertEquals(effectiveDate(2026, 1, 30), "2026-02-28");
});

Deno.test("recurring_eom: 31 Apr (only 30 days) -> 2026-04-30", () => {
  assertEquals(effectiveDate(2026, 3, 31), "2026-04-30");
});

Deno.test("recurring_eom: 15 May -> 2026-05-15 (regular day)", () => {
  assertEquals(effectiveDate(2026, 4, 15), "2026-05-15");
});

Deno.test("recurring_eom: 1 Jan -> 2026-01-01", () => {
  assertEquals(effectiveDate(2026, 0, 1), "2026-01-01");
});

Deno.test("lastDayOfMonth: Jan 31 / Feb 28-29 / Apr 30", () => {
  assertEquals(lastDayOfMonth(2026, 0), 31);
  assertEquals(lastDayOfMonth(2026, 1), 28);
  assertEquals(lastDayOfMonth(2028, 1), 29);
  assertEquals(lastDayOfMonth(2026, 3), 30);
});
