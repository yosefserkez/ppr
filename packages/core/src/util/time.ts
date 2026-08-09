/** Local-time helpers. Days are the user's days, not UTC days. */

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** ISO-8601 with the local UTC offset, e.g. 2026-07-27T14:32:05-07:00. */
export function toLocalISO(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** YYYY-MM-DD in local time. */
export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const timeKey = (d: Date): string => `${pad(d.getHours())}${pad(d.getMinutes())}`;

export const startOfDay = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);

export const addDays = (d: Date, n: number): Date => {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
};

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** `30m`, `2h`, `7d`, `3w` -> milliseconds. Returns null if unparseable. */
export function parseDuration(input: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(mo|[smhdwy])$/i.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit === 'mo') return n * 30 * UNIT_MS.d!;
  if (unit === 'y') return n * 365 * UNIT_MS.d!;
  return n * UNIT_MS[unit]!;
}

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/** `friday` or `fri`. Nothing looser: `tues` and `thurs` are not day names. */
function weekdayIndex(word: string): number | null {
  const i = WEEKDAYS.findIndex((day) => day === word || day.slice(0, 3) === word);
  return i === -1 ? null : i;
}

/**
 * The next such weekday, never today.
 *
 * Said on a Friday, "friday" means the one coming, not the one you are
 * standing in — a person with today in mind says "today". Getting this wrong
 * in the other direction is the expensive one: a reminder that fires the
 * moment you set it is a reminder you did not get.
 *
 * "next friday" resolves to the same day, deliberately. Half of English
 * readers hear "the friday after this coming one" and half hear "the coming
 * friday", so there is no reading that surprises nobody — and the one that
 * surprises least is the one where two spellings of a phrase agree. Someone
 * who means the week after can say `in 2 weeks` or name the date.
 */
const nextWeekday = (now: Date, target: number): Date =>
  startOfDay(addDays(now, ((target - now.getDay() + 7) % 7) || 7));

/** The most recent such weekday, never today — the mirror of `nextWeekday`. */
const lastWeekday = (now: Date, target: number): Date =>
  startOfDay(addDays(now, -(((now.getDay() - target + 7) % 7) || 7)));

const daysInMonth = (year: number, month: number): number =>
  new Date(year, month + 1, 0).getDate();

/** 31 January plus one month is 28 February. JS overflows into March; people do not. */
function addMonths(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth() + n, 1);
  out.setDate(Math.min(d.getDate(), daysInMonth(out.getFullYear(), out.getMonth())));
  return out;
}

/** `in 3 days`, `in 2 weeks`, `in a month`. Forward only; `ago` is the other half. */
const IN_N = /^in\s+(?:(\d{1,4})|an?)\s+(day|week|month|year)s?$/;

/**
 * Resolves the many ways a human names a moment:
 * `today`, `tomorrow`, `yesterday`, `7d` (ago), `2026-07-01`, `2026-07-01T09:00`,
 * `last week`, `next month`, `friday`, `next friday`, `in 3 days`, `tonight`.
 * Bare durations and bare day-names resolve to the *start* of that period.
 *
 * A bare weekday resolves *forwards*, because the commands that take one are
 * the forward-looking ones; `last friday` is how you reach back. Everything
 * here is deterministic and dependency-free on purpose — a date library would
 * be a fourth dependency to save arithmetic that fits on a screen, and would
 * still not know what "next friday" means to this user.
 */
export function parseWhen(input: string, now: Date = new Date()): Date | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'now') return now;
  if (raw === 'today') return startOfDay(now);
  // Days are the unit ppr stores, so an hour of the evening is still today.
  if (raw === 'tonight' || raw === 'this evening') return startOfDay(now);
  if (raw === 'yesterday') return startOfDay(addDays(now, -1));
  if (raw === 'tomorrow') return startOfDay(addDays(now, 1));
  if (raw === 'week' || raw === 'this week') return startOfDay(addDays(now, -now.getDay()));
  if (raw === 'last week') return startOfDay(addDays(now, -now.getDay() - 7));
  if (raw === 'next week') return startOfDay(addDays(now, 7 - now.getDay()));
  if (raw === 'month' || raw === 'this month')
    return new Date(now.getFullYear(), now.getMonth(), 1);
  if (raw === 'next month') return new Date(now.getFullYear(), now.getMonth() + 1, 1);
  if (raw === 'year' || raw === 'this year') return new Date(now.getFullYear(), 0, 1);
  if (raw === 'next year') return new Date(now.getFullYear() + 1, 0, 1);

  const counted = IN_N.exec(raw);
  if (counted) {
    const n = counted[1] ? Number(counted[1]) : 1;
    switch (counted[2]) {
      case 'day':
        return startOfDay(addDays(now, n));
      case 'week':
        return startOfDay(addDays(now, n * 7));
      case 'month':
        return startOfDay(addMonths(now, n));
      default:
        return startOfDay(addMonths(now, n * 12));
    }
  }

  const named = /^(?:(next|this|last)\s+)?([a-z]+)$/.exec(raw);
  if (named) {
    const day = weekdayIndex(named[2]!);
    if (day !== null) {
      return named[1] === 'last' ? lastWeekday(now, day) : nextWeekday(now, day);
    }
  }

  const ago = /^(.+?)\s+ago$/.exec(raw);
  const durationText = ago ? ago[1]! : raw;
  const ms = parseDuration(durationText);
  if (ms !== null) return new Date(now.getTime() - ms);

  // Plain dates are local midnight; anything with a time component is passed through.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, mo, d] = raw.split('-').map(Number) as [number, number, number];
    return new Date(y, mo - 1, d);
  }
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const RELATIVE_STEPS: Array<[limit: number, div: number, unit: string]> = [
  [60_000, 1000, 's'],
  [3_600_000, 60_000, 'm'],
  [86_400_000, 3_600_000, 'h'],
  [2_592_000_000, 86_400_000, 'd'],
  [31_536_000_000, 2_592_000_000, 'mo'],
];

/**
 * How far off a dated thing is, in words. One definition, because the brief,
 * the context dump, and the bare `ppr` overview all say it and had begun to
 * say it differently.
 *
 * Negative days are already past — which only a reminder can be, since a fact
 * whose date has gone simply stops being upcoming.
 */
export const countdown = (days: number): string =>
  days < 0
    ? `${-days} ${days === -1 ? 'day' : 'days'} overdue`
    : days === 0
      ? 'today'
      : days === 1
        ? 'tomorrow'
        : `in ${days} days`;

/** Compact age, e.g. `3m`, `2h`, `5d`, `now`. */
export function relativeAge(d: Date, now: Date = new Date()): string {
  const diff = now.getTime() - d.getTime();
  if (diff < 45_000) return 'now';
  for (const [limit, div, unit] of RELATIVE_STEPS) {
    if (diff < limit) return `${Math.floor(diff / div)}${unit}`;
  }
  return `${Math.floor(diff / 31_536_000_000)}y`;
}

/** `Mon 27 Jul` — stable, locale-independent, scannable in a list. */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const formatDay = (d: Date): string =>
  `${DAYS[d.getDay()]} ${pad(d.getDate())} ${MONTHS[d.getMonth()]}`;

export const formatTime = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
