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

/** Whether an entry has already been dealt with. */
export const isDone = (extra: Record<string, unknown>): boolean => extra.status === 'done';

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
