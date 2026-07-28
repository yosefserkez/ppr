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

/**
 * Resolves the many ways a human names a moment:
 * `today`, `yesterday`, `7d` (ago), `2026-07-01`, `2026-07-01T09:00`, `last week`.
 * Bare durations and bare day-names resolve to the *start* of that period.
 */
export function parseWhen(input: string, now: Date = new Date()): Date | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'now') return now;
  if (raw === 'today') return startOfDay(now);
  if (raw === 'yesterday') return startOfDay(addDays(now, -1));
  if (raw === 'tomorrow') return startOfDay(addDays(now, 1));
  if (raw === 'week' || raw === 'this week') return startOfDay(addDays(now, -now.getDay()));
  if (raw === 'last week') return startOfDay(addDays(now, -now.getDay() - 7));
  if (raw === 'month' || raw === 'this month')
    return new Date(now.getFullYear(), now.getMonth(), 1);
  if (raw === 'year' || raw === 'this year') return new Date(now.getFullYear(), 0, 1);

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
