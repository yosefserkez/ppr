/**
 * Reminders: the forward-looking half of the timeline.
 *
 * A reminder is an ordinary entry — same parser, same file, same `ppr edit` —
 * that carries `date:` in its frontmatter. It is emphatically *not* a memory:
 * you did say "remind me to call the dentist" at the moment you said it, so it
 * belongs to its day and stays in `ppr ls` (I12 is about state, and an
 * intention is not state). What makes it different from a log is only that it
 * completes, which `status: done` records.
 *
 * Every field rides in `Entry.extra`, which round-trips untouched (I3), and
 * they are the same two keys the fact store already uses — so `ppr brief`
 * counts down to a reminder, a birthday, and a note somebody typed
 * `date: 2027-03-01` into by hand with one piece of arithmetic rather than
 * three.
 */

import { parseFactDate, type FactRecurrence } from './memory.js';
import { parseDuration, parseWhen, startOfDay } from './util/time.js';

/** How a dated thing leaves the queue. Retired is the fact store's word for it. */
export type ReminderStatus = 'done';

/**
 * The `extra` keys a reminder owns. Everything else in `extra` belongs to
 * whoever put it there and is never touched (I3).
 */
export const REMINDER_KEYS = ['date', 'recurs', 'status'] as const;

/** The `extra` block for a reminder, with empty fields left out rather than nulled. */
export function reminderExtra(fields: {
  date?: string;
  recurs?: FactRecurrence;
  status?: ReminderStatus;
}): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (fields.date) extra.date = fields.date;
  if (fields.date && fields.recurs) extra.recurs = fields.recurs;
  if (fields.status) extra.status = fields.status;
  return extra;
}

/** What a reminder says, once the date has been read out of the words. */
export interface ParsedReminder {
  /** The reminder itself, with the when-phrase removed. */
  text: string;
  /** `YYYY-MM-DD`, validated. Absent when no date could be read. */
  date?: string;
  recurs?: FactRecurrence;
}

/** `2026-08-08` for a Date, so a parsed moment can be stored as a calendar day. */
export const asDay = (d: Date): string | undefined =>
  parseFactDate(
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  );

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** `october`, `oct`, and `sept`, which is the one abbreviation people lengthen. */
function monthIndex(word: string): number | null {
  if (word === 'sept') return 8;
  const i = MONTHS.findIndex((m) => m === word || m.slice(0, 3) === word);
  return i === -1 ? null : i;
}

const MONTH_DAY = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)$|^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/;

/**
 * `20 october`, `oct 20`, `20th october` — the next one.
 *
 * Not in `parseWhen`, because `new Date('20 October')` answers *2001* and
 * fixing that generally would change what `--since` means. Here the question
 * is only ever about the future, so "the next 20 October" is the only reading.
 */
function monthDay(raw: string, now: Date): Date | null {
  const m = MONTH_DAY.exec(raw);
  if (!m) return null;
  const day = Number(m[1] ?? m[4]);
  const month = monthIndex(m[2] ?? m[3] ?? '');
  if (month === null || !day) return null;

  const on = (year: number): Date | null => {
    const date = new Date(year, month, day);
    return date.getMonth() === month ? date : null;
  };
  const thisYear = on(now.getFullYear());
  if (thisYear && thisYear >= startOfDay(now)) return thisYear;
  return on(now.getFullYear() + 1);
}

/**
 * A moment named by someone looking forwards.
 *
 * `parseWhen` is the reader for `--since`, where a bare duration means the
 * past: `7d` is a week ago. An intention can only be about the future — nobody
 * schedules last Tuesday — so `7d` here is a week from now, and everything
 * else falls through to the shared parser.
 */
export function futureWhen(phrase: string, now: Date): Date | null {
  const raw = phrase.trim().toLowerCase();
  if (!raw) return null;
  // `week`, `month`, `year` mean "the start of this one" to `--since`, which is
  // a window rather than a day. Reading them here turned "file expenses before
  // the end of the month" into a reminder due on the first — already a week
  // overdue on the day it was set.
  if (PERIOD.test(raw)) return null;
  const ms = parseDuration(raw);
  if (ms !== null) return new Date(now.getTime() + ms);
  // A month-day form is judged here and nowhere else, valid or not: falling
  // through would hand `feb 30` to `new Date`, which answers 2 March 2001.
  if (MONTH_DAY.test(raw)) return monthDay(raw, now);
  return parseWhen(raw, now);
}

/** Words naming a period rather than a day. `next month` is still a day. */
const PERIOD = /^(?:this\s+)?(?:week|month|year)$/;

/**
 * Whether a phrase is even worth handing to a date parser.
 *
 * `new Date('2')` is 1 February 2001, which is how "remind me 2 things" would
 * have acquired a due date. A date has a word in it or it is an ISO day;
 * digits on their own are a count of something.
 */
const looksLikeAWhen = (phrase: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(phrase) || /[a-z]/i.test(phrase);

/** Longest first: `next friday` must beat `friday`, `20 october` beat `october`. */
const WHEN_PHRASE_WORDS = 3;

const clean = (phrase: string): string =>
  phrase
    .replace(/^[\s,:;.]+|[\s,:;.]+$/g, '')
    .replace(/^(?:on|at|by)\s+/i, '')
    .toLowerCase();

/**
 * Finds the when-phrase at one end of a line and hands back the rest.
 *
 * Both ends, because both are how people write it: "tomorrow: call the
 * dentist" and "call the dentist tomorrow". Only the ends — a date buried in
 * the middle of a sentence is a sentence, and guessing at it is how a note
 * about "the friday deploy" would acquire a due date it never asked for
 * (L17/I11). When the deterministic read fails, a model gets one attempt, and
 * failing that the words are kept as an ordinary log.
 */
function extractWhen(text: string, now: Date): { date: string; rest: string } | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  for (const take of [WHEN_PHRASE_WORDS, 2, 1]) {
    if (take > words.length) continue;
    for (const [phrase, rest] of [
      [words.slice(0, take).join(' '), words.slice(take).join(' ')],
      [words.slice(-take).join(' '), words.slice(0, -take).join(' ')],
    ] as Array<[string, string]>) {
      const candidate = clean(phrase);
      if (!candidate || !looksLikeAWhen(candidate)) continue;
      const when = futureWhen(candidate, now);
      // A day *inferred* from a sentence is never one that has already gone.
      // Nobody means "remind me last friday", so a phrase that resolves
      // backwards is a phrase that was misread — and reading it as a date
      // would file a reminder that arrives already overdue. `--at` is the
      // place to name a past day, because there it was typed on purpose.
      if (!when || when < startOfDay(now)) continue;
      const date = asDay(when);
      if (date) return { date, rest };
    }
  }
  return null;
}

/**
 * Strips the grammar that held the when-phrase on, so what is left is the
 * thing itself. Exported because a model's answer needs the same trim: asked
 * to remove "before the end of the month" it hands back "to file expenses",
 * and a reminder titled "to file expenses" reads like a fragment because it
 * is one.
 */
export const tidyReminder = (text: string): string =>
  text
    .replace(/^[\s,:;.]+|[\s,:;.]+$/g, '')
    .replace(/^(?:to|that|about)\s+/i, '')
    .replace(/^(?:on|at|by)\s+/i, '')
    .replace(/\s+(?:on|at|by|of|to)$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

/** `every year`, and only that: `recurs` is not a scheduling language. */
const YEARLY = /\b(?:every\s+year|each\s+year|yearly|annually)\b/i;

/**
 * Reads "remind me tomorrow to call the dentist" into a day and a thing to do.
 *
 * Deterministic and total: it always returns the words, and returns a date
 * only when one is unmistakably there. A reminder with no date never surfaces,
 * which would be the quietest way to lose something, so the caller stores an
 * undated result as an ordinary log and says so — never as a reminder nobody
 * will ever be reminded of (I2).
 */
export function parseReminder(input: string, now: Date): ParsedReminder {
  let text = input.trim().replace(/^remind(?:\s+me)?\b[\s,:;.-]*/i, '');

  let recurs: FactRecurrence | undefined;
  if (YEARLY.test(text)) {
    recurs = 'yearly';
    text = text.replace(YEARLY, ' ');
  }

  const found = extractWhen(text, now);
  return {
    text: tidyReminder(found ? found.rest : text),
    ...(found ? { date: found.date } : {}),
    // Recurrence with nothing to recur from is not a fact about anything.
    ...(found && recurs ? { recurs } : {}),
  };
}
