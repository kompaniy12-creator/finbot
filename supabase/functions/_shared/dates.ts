// Timezone-aware dates for FinBot. All business dates are in Europe/Warsaw
// (default tz), but stored in DB as plain DATE (YYYY-MM-DD). At write time
// we convert "now" -> Warsaw local date; at parse time we interpret strings
// like "вчера" or "01.03" in the user's local (Warsaw) frame.

export const DEFAULT_TZ = "Europe/Warsaw";

function getTz(): string {
  return Deno.env.get("DEFAULT_TIMEZONE") ?? DEFAULT_TZ;
}

/**
 * Today's date in Europe/Warsaw, ISO YYYY-MM-DD.
 */
export function todayWarsawIso(now: Date = new Date()): string {
  const tz = getTz();
  // en-CA produces YYYY-MM-DD literal output.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Number of days between two YYYY-MM-DD strings (b - a). Both interpreted as
 * Warsaw-local midnight dates.
 */
export function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso + "T00:00:00Z").getTime();
  const b = new Date(bIso + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Add N days to a YYYY-MM-DD string. Returns YYYY-MM-DD.
 */
export function addDaysIso(iso: string, days: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime() + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// Weekday stem -> ISO weekday (1=Mon ... 7=Sun). We match against the BEGINNING
// of the word so that all declined forms work: "в субботу", "в субботы", "w sobote".
const WEEKDAY_STEMS: Array<[string, number]> = [
  // Polish
  ["poniedz", 1],
  ["wtor", 2],
  ["sroda", 3],
  ["środa", 3],
  ["środy", 3],
  ["czwart", 4],
  ["piatek", 5],
  ["piątek", 5],
  ["piątk", 5],
  ["piatk", 5],
  ["sobot", 6],
  ["niedz", 7],
  // Russian (suffixes covered by prefix match)
  ["понедельн", 1],
  ["вторник", 2],
  ["вторни", 2],
  ["среда", 3],
  ["сред", 3],
  ["четверг", 4],
  ["четверьг", 4],
  ["четв", 4],
  ["пятниц", 5],
  ["пятн", 5],
  ["суббот", 6],
  ["суббо", 6],
  ["воскресен", 7],
  ["воскрес", 7],
  // Ukrainian
  ["понеділ", 1],
  ["вівтор", 2],
  ["середа", 3],
  ["середи", 3],
  ["середу", 3],
  ["четвер", 4],
  ["пятниц", 5],
  ["субот", 6],
  ["неділ", 7],
];

function lookupWeekday(word: string): number | null {
  for (const [stem, day] of WEEKDAY_STEMS) {
    if (word.startsWith(stem)) return day;
  }
  return null;
}

function isoWeekday(iso: string): number {
  // JS getUTCDay: 0=Sun, 1=Mon, ..., 6=Sat. We want ISO 1=Mon, 7=Sun.
  const d = new Date(iso + "T00:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * Resolve a relative or absolute date in the Warsaw frame, given today's
 * Warsaw-local ISO date. Returns null if the string is unrecognizable.
 *
 * Supports:
 *   - сегодня / today
 *   - вчера / yesterday
 *   - позавчера
 *   - dwa dni temu / 3 дня назад (basic)
 *   - в субботу / w sobote (last weekday)
 *   - 01.03 (current year, or previous year if that would put it > 30 days
 *     in the future)
 *   - 01.03.2026 / 2026-03-01
 */
export function parseDate(text: string, todayIso: string): string | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;

  if (s === "сегодня" || s === "сьогодні" || s === "dzisiaj" || s === "today") {
    return todayIso;
  }
  if (s === "вчера" || s === "вчора" || s === "wczoraj" || s === "yesterday") {
    return addDaysIso(todayIso, -1);
  }
  if (s === "позавчера" || s === "позавчора" || s === "przedwczoraj") {
    return addDaysIso(todayIso, -2);
  }

  // "в субботу" / "в субботы" / "w sobote": strip leading preposition and look up stem.
  const weekdayMatch = s.match(/(?:в |w |у )?([a-zа-яёії]+)/u);
  if (weekdayMatch) {
    const word = weekdayMatch[1]!;
    const target = lookupWeekday(word);
    if (target) {
      const todayWd = isoWeekday(todayIso);
      // Go backwards: 1..7 days. If today is the target, the SPEC says "last", so -7.
      let delta = todayWd - target;
      if (delta <= 0) delta += 7;
      return addDaysIso(todayIso, -delta);
    }
  }

  // YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return s;

  // DD.MM.YYYY
  const dmyMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }

  // DD.MM (current year, with > 30 days future -> previous year)
  const dmMatch = s.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (dmMatch) {
    const [, d, m] = dmMatch;
    const year = Number(todayIso.slice(0, 4));
    const candidate = `${year}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
    const delta = daysBetween(todayIso, candidate);
    if (delta > 30) {
      return `${year - 1}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
    }
    return candidate;
  }

  return null;
}
