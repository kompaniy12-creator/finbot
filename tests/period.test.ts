import { assertEquals } from "@std/assert";
import { resolveDateWindow } from "../supabase/functions/_shared/period.ts";

const TODAY = "2026-05-22";

function url(q: string): URL {
  return new URL(`https://x?${q}`);
}

Deno.test("resolveDateWindow: default = month", () => {
  const w = resolveDateWindow(url(""), TODAY);
  assertEquals(w, { start: "2026-05-01", end: TODAY, period: "month" });
});

Deno.test("resolveDateWindow: period=day", () => {
  const w = resolveDateWindow(url("period=day"), TODAY);
  assertEquals(w, { start: TODAY, end: TODAY, period: "day" });
});

Deno.test("resolveDateWindow: period=week = last 7 inclusive", () => {
  const w = resolveDateWindow(url("period=week"), TODAY);
  assertEquals(w, { start: "2026-05-16", end: TODAY, period: "week" });
});

Deno.test("resolveDateWindow: from+to take precedence over period", () => {
  const w = resolveDateWindow(url("from=2026-01-01&to=2026-03-15&period=day"), TODAY);
  assertEquals(w, { start: "2026-01-01", end: "2026-03-15", period: "custom" });
});

Deno.test("resolveDateWindow: bad ISO format -> falls back to period", () => {
  const w = resolveDateWindow(url("from=2026/01/01&to=2026-03-15"), TODAY);
  assertEquals(w.period, "month");
});

Deno.test("resolveDateWindow: from > to -> falls back to period", () => {
  const w = resolveDateWindow(url("from=2026-03-15&to=2026-01-01"), TODAY);
  assertEquals(w.period, "month");
});

Deno.test("resolveDateWindow: only from -> falls back (need both)", () => {
  const w = resolveDateWindow(url("from=2026-01-01"), TODAY);
  assertEquals(w.period, "month");
});

Deno.test("resolveDateWindow: from == to is allowed", () => {
  const w = resolveDateWindow(url("from=2026-01-01&to=2026-01-01"), TODAY);
  assertEquals(w, { start: "2026-01-01", end: "2026-01-01", period: "custom" });
});
