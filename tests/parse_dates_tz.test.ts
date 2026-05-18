// Mandatory edge case (SPEC §18.4): parse_dates_tz.
// Verifies timezone semantics for "вчера" at boundary times around midnight.

import { assertEquals } from "@std/assert";
import {
  addDaysIso,
  daysBetween,
  parseDate,
  todayWarsawIso,
} from "../supabase/functions/_shared/dates.ts";

Deno.test("todayWarsawIso: 23:00 Warsaw is still today", () => {
  // 21:00 UTC = 23:00 Warsaw (winter, CET = UTC+1)
  // or 23:00 Warsaw (summer, CEST = UTC+2, then 21:00 UTC)
  // Actually CEST is UTC+2, so 23:00 Warsaw = 21:00 UTC in summer.
  // CET (winter) is UTC+1, so 23:00 Warsaw = 22:00 UTC.
  // Test below: 2026-05-18 21:00 UTC (CEST May) = 2026-05-18 23:00 Warsaw.
  const at23Warsaw = new Date("2026-05-18T21:00:00Z");
  assertEquals(todayWarsawIso(at23Warsaw), "2026-05-18");
});

Deno.test("todayWarsawIso: 00:30 Warsaw is already next day", () => {
  // 22:30 UTC = 00:30 next day Warsaw (CEST in May, UTC+2)
  const at0030Warsaw = new Date("2026-05-18T22:30:00Z");
  assertEquals(todayWarsawIso(at0030Warsaw), "2026-05-19");
});

Deno.test("parseDate: 'вчера' relative to Warsaw 'today' Iso", () => {
  // If today is 2026-05-19, вчера should be 2026-05-18.
  assertEquals(parseDate("вчера", "2026-05-19"), "2026-05-18");
  assertEquals(parseDate("вчора", "2026-05-19"), "2026-05-18");
  assertEquals(parseDate("wczoraj", "2026-05-19"), "2026-05-18");
});

Deno.test("parseDate: 'позавчера' = today - 2", () => {
  assertEquals(parseDate("позавчера", "2026-05-19"), "2026-05-17");
});

Deno.test("parseDate: 'сегодня' returns today", () => {
  assertEquals(parseDate("сегодня", "2026-05-19"), "2026-05-19");
  assertEquals(parseDate("dzisiaj", "2026-05-19"), "2026-05-19");
});

Deno.test("parseDate: 'в субботу' last Saturday from a Tuesday (target before today this week)", () => {
  // 2026-05-19 is a Tuesday (ISO weekday 2). Last Saturday = 2026-05-16.
  assertEquals(parseDate("в субботу", "2026-05-19"), "2026-05-16");
});

Deno.test("parseDate: 'в субботу' from a Saturday returns previous week's Saturday", () => {
  // 2026-05-16 is a Saturday (ISO weekday 6). Last Saturday = 2026-05-09 (delta -7).
  assertEquals(parseDate("в субботу", "2026-05-16"), "2026-05-09");
});

Deno.test("parseDate: ISO YYYY-MM-DD passes through", () => {
  assertEquals(parseDate("2026-03-15", "2026-05-19"), "2026-03-15");
});

Deno.test("parseDate: DD.MM future-by-30 rolls back to previous year", () => {
  // Today is 2026-05-19. "01.07" (July 1) is more than 30 days in future ->
  // assume user means 2025-07-01.
  assertEquals(parseDate("01.07", "2026-05-19"), "2025-07-01");
});

Deno.test("parseDate: DD.MM within 30 days future stays current year", () => {
  // Today 2026-05-19. "10.06" is within 30 days. Keep current year.
  assertEquals(parseDate("10.06", "2026-05-19"), "2026-06-10");
});

Deno.test("parseDate: DD.MM in the past stays current year", () => {
  // Today 2026-05-19. "01.03" was in past, stay 2026.
  assertEquals(parseDate("01.03", "2026-05-19"), "2026-03-01");
});

Deno.test("parseDate: DD.MM.YYYY passes through", () => {
  assertEquals(parseDate("15.03.2025", "2026-05-19"), "2025-03-15");
});

Deno.test("parseDate: nonsense -> null", () => {
  assertEquals(parseDate("blah", "2026-05-19"), null);
  assertEquals(parseDate("", "2026-05-19"), null);
});

Deno.test("addDaysIso + daysBetween are inverses", () => {
  const start = "2026-01-01";
  assertEquals(addDaysIso(start, 365), "2027-01-01");
  assertEquals(daysBetween("2026-01-01", "2027-01-01"), 365);
  assertEquals(daysBetween("2026-05-19", "2026-05-19"), 0);
});
