// Resolve a date window from query params. Either an explicit (from, to) pair
// or a named period (day | week | month). Returns inclusive ISO dates.

import { addDaysIso } from "./dates.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface DateWindow {
  start: string;
  end: string;
  period: "day" | "week" | "month" | "custom";
}

/**
 * Parse `from`, `to`, `period` from a URL. `today` is the reference date
 * (typically todayWarsawIso()). Custom range takes precedence when both
 * `from` and `to` are valid ISO dates and from <= to.
 */
export function resolveDateWindow(url: URL, today: string): DateWindow {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from && to && ISO_DATE.test(from) && ISO_DATE.test(to) && from <= to) {
    return { start: from, end: to, period: "custom" };
  }
  const period = (url.searchParams.get("period") ?? "month").toLowerCase();
  if (period === "day") return { start: today, end: today, period: "day" };
  if (period === "week") return { start: addDaysIso(today, -6), end: today, period: "week" };
  const monthStart = today.slice(0, 7) + "-01";
  return { start: monthStart, end: today, period: "month" };
}
