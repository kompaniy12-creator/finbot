// End-of-month date math for cron-recurring (SPEC §6.x + M14 acceptance).
//
// If a user has day_of_month=31 but the current month only has 28/29/30 days,
// the charge happens on the LAST day of the month. Same for day_of_month=30
// in February.

export function lastDayOfMonth(year: number, monthZeroBased: number): number {
  // Day 0 of next month = last day of current month.
  return new Date(year, monthZeroBased + 1, 0).getDate();
}

/**
 * Given a recurring `day_of_month` (1..31) and a target month (year, month0),
 * return the effective ISO date (YYYY-MM-DD). Clamps to last day of month.
 */
export function effectiveDate(year: number, monthZeroBased: number, dayOfMonth: number): string {
  const last = lastDayOfMonth(year, monthZeroBased);
  const day = Math.min(dayOfMonth, last);
  const mm = String(monthZeroBased + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Effective date for "today" interpretation given a Warsaw-local today ISO.
 * Used when the cron fires on the start of the day - if today is the effective
 * day, return today's ISO; otherwise return null (skip charge for now).
 */
export function effectiveDateForToday(
  todayIso: string,
  dayOfMonth: number,
): string | null {
  const year = Number(todayIso.slice(0, 4));
  const month0 = Number(todayIso.slice(5, 7)) - 1;
  const todayDay = Number(todayIso.slice(8, 10));
  const eff = effectiveDate(year, month0, dayOfMonth);
  return eff === todayIso || todayDay === lastDayOfMonth(year, month0) && dayOfMonth >= todayDay
    ? eff
    : null;
}
