// Resolve a date window from query params. Either an explicit (from, to) pair,
// an explicit (month=YYYY-MM) calendar month, or a named period
// (day | week | month). Returns inclusive ISO dates.

import { addDaysIso } from "./dates.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

export interface DateWindow {
  start: string;
  end: string;
  period: "day" | "week" | "month" | "custom";
  month?: string; // YYYY-MM, set when window is a full calendar month
}

/**
 * Last day of the given YYYY-MM as ISO YYYY-MM-DD.
 */
function lastDayOfMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split("-").map(Number);
  // Day 0 of next month = last day of given month (UTC math, no DST drift).
  const d = new Date(Date.UTC(y!, m!, 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Parse `from`, `to`, `month`, `period` from a URL. `today` is the reference
 * date (typically todayWarsawIso()). Precedence:
 *   1. valid `from`+`to` (custom range)
 *   2. valid `month=YYYY-MM` (full calendar month, or month-to-today for current)
 *   3. `period` = day | week | month (defaults to current calendar month)
 */
export function resolveDateWindow(url: URL, today: string): DateWindow {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from && to && ISO_DATE.test(from) && ISO_DATE.test(to) && from <= to) {
    return { start: from, end: to, period: "custom" };
  }
  const month = url.searchParams.get("month");
  if (month && ISO_MONTH.test(month)) {
    const start = `${month}-01`;
    // For the current month don't clip to today's date - users want to see
    // the month-to-date so far; for past months use the actual last day.
    const isCurrent = month === today.slice(0, 7);
    const end = isCurrent ? today : lastDayOfMonth(month);
    return { start, end, period: "month", month };
  }
  const period = (url.searchParams.get("period") ?? "month").toLowerCase();
  if (period === "day") return { start: today, end: today, period: "day" };
  if (period === "week") return { start: addDaysIso(today, -6), end: today, period: "week" };
  const curMonth = today.slice(0, 7);
  return {
    start: `${curMonth}-01`,
    end: today,
    period: "month",
    month: curMonth,
  };
}
