/**
 * The memory layer: standing facts, kept as ordinary markdown.
 *
 * A fact is an `Entry` like any other — same parser, same frontmatter rules,
 * same `ppr edit`. What makes it a fact is where it lives and what it means:
 * `memory/` rather than `entries/YYYY/MM/`, because "Emily's birthday is 20
 * October" did not happen on the afternoon it was extracted (I12).
 *
 * The store is a *projection*: delete `memory/` and `ppr memory learn --all`
 * rebuilds it from the journal. The exceptions are the facts a person wrote or
 * edited, which is why those are marked and why nothing automatic overwrites
 * them.
 *
 * Every field ppr adds here rides in `Entry.extra`, which already round-trips
 * untouched (I3) — so the whole layer needs no new owned frontmatter keys and
 * a fact stays readable in Obsidian, in `cat`, and in a diff.
 */

import type { Entry } from './types.js';
import { slugify } from './util/text.js';

export const MEMORY_DIR = 'memory';

/**
 * `memory/emilys-birthday-is-20-october-x7k2.md`
 *
 * Flat and undated, unlike an entry path: a fact is about a thing, not a day,
 * and a stable name means editing one produces a diff you can read.
 */
export function memoryPath(entry: Pick<Entry, 'id' | 'title'>): string {
  const slug = slugify(entry.title) || 'fact';
  return `${MEMORY_DIR}/${slug}-${entry.id.slice(-4)}.md`;
}

/** `manual` facts are never rewritten by anything automatic. */
export type FactOrigin = 'manual' | 'learned';

export type FactStatus = 'current' | 'retired';

/**
 * The only recurrence ppr understands.
 *
 * Deliberately not a scheduling language. Birthdays and anniversaries are the
 * facts that repeat; everything else is a date that happens once. A tool that
 * grows RRULEs has become a calendar, and there are better calendars.
 */
export type FactRecurrence = 'yearly';

/**
 * Everything the calendar half needs from anything that carries a date.
 *
 * Deliberately not "a fact". A fact is one of these, a reminder is another,
 * and so is a hand-written note that happens to have `date:` in its
 * frontmatter — dated anything is the rule, and it is a feature rather than a
 * leak. The alternative is a second countdown for reminders that drifts from
 * the first within a release.
 */
export interface DatedItem {
  id: string;
  /** One line saying what it is. */
  text: string;
  /**
   * The calendar date this carries, `YYYY-MM-DD`, when it has one.
   *
   * This is the one piece of structure the layer adds, and it earns its place
   * by making the forward-looking half work with no model at all: "Emily's
   * birthday is in 73 days" is arithmetic, not a judgement, and asking a model
   * to notice it every morning would be slower, costlier, and less reliable.
   */
  date?: string;
  recurs?: FactRecurrence;
  /**
   * Entries it was drawn from. They are its sources, so they are never also
   * news about it.
   */
  from: string[];
  entry: Entry;
}

/** A memory entry with the frontmatter ppr writes on facts read back typed. */
export interface Fact extends DatedItem {
  /** Entries it was extracted from, oldest first. Empty when hand-written. */
  from: string[];
  origin: FactOrigin;
  status: FactStatus;
  /** Ids of facts this one disagrees with, pending a decision by the user. */
  conflicts: string[];
  /** Set on a retired fact: the fact that replaced it. */
  supersededBy?: string;
}

const asIdList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
};

/**
 * The fact itself, out of a memory's body.
 *
 * First line only: a hand-edited file may have grown a note underneath it, and
 * that is the author's business, not the index's. Everything that renders,
 * prompts with, or compares a fact goes through here, so none of them can
 * disagree about where the fact ends.
 */
export const factText = (body: string): string => body.split('\n')[0]?.trim() ?? '';

/** Reads the memory frontmatter off an entry. Absence always has a meaning. */
export function toFact(entry: Entry): Fact {
  const fact: Fact = {
    id: entry.id,
    text: factText(entry.body),
    from: asIdList(entry.extra.from),
    origin: entry.source === 'manual' ? 'manual' : 'learned',
    status: entry.extra.status === 'retired' ? 'retired' : 'current',
    conflicts: asIdList(entry.extra.conflicts),
    entry,
  };
  const superseded = entry.extra.supersededBy;
  if (typeof superseded === 'string' && superseded) fact.supersededBy = superseded;
  const date = parseFactDate(entry.extra.date);
  if (date) fact.date = date;
  if (date && entry.extra.recurs === 'yearly') fact.recurs = 'yearly';
  return fact;
}

/**
 * A timeline entry read as a dated thing, or nothing if it is not one.
 *
 * Any entry qualifies — a reminder, or a note somebody typed `date: 2027-03-01`
 * into by hand. That is deliberate: `date:` in frontmatter is the whole
 * interface, so a file written in vim reaches `ppr brief` without ppr having
 * invented a second way to say the same thing.
 *
 * `status` is how a dated thing leaves the queue. `done` is what `ppr done`
 * writes; `retired` is the fact store's word for the same idea, and both mean
 * "stop telling me about this".
 */
export function toDated(entry: Entry): DatedItem | null {
  const date = parseFactDate(entry.extra.date);
  if (!date) return null;
  if (entry.extra.status === 'done' || entry.extra.status === 'retired') return null;
  return {
    id: entry.id,
    // The title, not the body: a reminder's title *is* its text, and a
    // hand-dated note's title is the one line worth putting in a brief.
    text: entry.title,
    date,
    ...(entry.extra.recurs === 'yearly' ? { recurs: 'yearly' as const } : {}),
    from: [],
    entry,
  };
}

/**
 * `YYYY-MM-DD`, or nothing.
 *
 * A hand-edited file, or a model asked for a date, will offer "October 20",
 * "2002-10-20T00:00:00Z", or a `Date` the YAML parser already built. Only a
 * plain calendar day is accepted — a half-understood date is worse than none,
 * because everything downstream treats it as certain.
 */
export function parseFactDate(value: unknown): string | undefined {
  const raw =
    value instanceof Date
      ? `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
      : typeof value === 'string'
        ? value.trim().slice(0, 10)
        : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const [y, m, d] = raw.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return raw;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The `extra` keys the memory layer owns. Everything else in `extra` belongs to
 * whoever put it there and is never touched (I3).
 */
export const FACT_KEYS = ['from', 'status', 'conflicts', 'supersededBy', 'date', 'recurs'] as const;

/** The `extra` block for a fact, with empty fields left out rather than nulled. */
export function factExtra(fields: {
  from?: string[];
  status?: FactStatus;
  conflicts?: string[];
  supersededBy?: string;
  date?: string;
  recurs?: FactRecurrence;
}): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (fields.from?.length) extra.from = fields.from;
  if (fields.status && fields.status !== 'current') extra.status = fields.status;
  if (fields.conflicts?.length) extra.conflicts = fields.conflicts;
  if (fields.supersededBy) extra.supersededBy = fields.supersededBy;
  if (fields.date) extra.date = fields.date;
  if (fields.date && fields.recurs) extra.recurs = fields.recurs;
  return extra;
}

/**
 * The key two facts share when they say the same thing in the same words.
 *
 * Not similarity — deciding that two different sentences mean one thing is the
 * model's job. This is the floor underneath it: whatever a provider answers,
 * or fails to answer, the same sentence twice must never become two facts.
 */
export const factKey = (text: string): string =>
  text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');

/**
 * Words too ordinary to mean a fact is being talked about. Short words are
 * excluded by length; these are the long ones that carry no subject.
 */
const COMMON = new Set([
  'about', 'after', 'also', 'because', 'been', 'before', 'every', 'from', 'have', 'into', 'like',
  'likes', 'more', 'most', 'over', 'prefers', 'said', 'says', 'some', 'than', 'that', 'their',
  'them', 'then', 'these', 'they', 'this', 'used', 'uses', 'user', 'users', 'very', 'were', 'what',
  'when', 'which', 'will', 'with', 'would', 'year', 'years',
]);

/**
 * The words in a fact specific enough to recognise it somewhere else.
 *
 * Possessives are stripped: the fact says "Emily's birthday" and the entry
 * says "got Emily a present", and those are the same Emily.
 */
export function factTerms(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).map((w) =>
    w.replace(/'s$/, '').replace(/[-']+$/, ''),
  );
  return [...new Set(words)].filter((w) => w.length >= 4 && !COMMON.has(w));
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How strongly a piece of text is about a fact: the number of its distinctive
 * words that appear, as whole words.
 *
 * Whole words matter more than it looks. Substring matching had "redis"
 * counting as a mention of a birthday, because "redis" contains "is" — which
 * is the sort of thing that makes a daily brief unreadable within a week.
 */
export function mentionScore(text: string, item: DatedItem): number {
  const haystack = text.toLowerCase();
  return factTerms(item.text).filter((term) =>
    new RegExp(`\\b${escapeRegExp(term)}\\b`).test(haystack),
  ).length;
}

export interface Occurrence {
  item: DatedItem;
  /** Local midnight on the day it next falls. */
  date: Date;
  /** Whole days from today. 0 is today, negative is overdue. */
  days: number;
  /** How many times it has come round before, for "her 24th". */
  ordinal?: number;
}

/**
 * When a dated thing next comes round, or nothing if it is simply past.
 *
 * Pure and offline — this is what lets `ppr brief` work with `ai.provider:
 * none`, and what keeps the model's job to phrasing rather than arithmetic.
 *
 * `graceDays` keeps a date that has already gone by in view, with `days`
 * negative. A fact's date passing means the day happened and there is nothing
 * to say; an intention's passing means it did *not* happen, which is exactly
 * the moment you want telling — so the callers that hold intentions pass a
 * window and the fact store does not.
 */
export function nextOccurrence(
  item: DatedItem,
  now: Date,
  opts: { graceDays?: number } = {},
): Occurrence | null {
  if (!item.date) return null;
  const [year, month, day] = item.date.split('-').map(Number) as [number, number, number];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const on = (y: number): Date => {
    const date = new Date(y, month - 1, day);
    // 29 February in a common year rolls into March. Hold it in its own month.
    return date.getMonth() === month - 1 ? date : new Date(y, month, 0);
  };

  let when: Date;
  if (item.recurs === 'yearly') {
    when = on(today.getFullYear());
    if (when < today) when = on(today.getFullYear() + 1);
  } else {
    when = on(year);
  }

  const days = Math.round((when.getTime() - today.getTime()) / 86_400_000);
  if (days < -(opts.graceDays ?? 0)) return null;

  const occurrence: Occurrence = { item, date: when, days };
  // `0000` is how an unknown year is recorded — a birthday with no birth year
  // still recurs, it just cannot say which one this will be.
  if (item.recurs === 'yearly' && year >= 1000 && when.getFullYear() > year) {
    occurrence.ordinal = when.getFullYear() - year;
  }
  return occurrence;
}

/**
 * Where the incremental learner keeps its place.
 *
 * Not in `.ppr/cache/`: losing the cache costs only speed (I1), while losing
 * this costs a re-scan of the whole journal. It is still regenerable — pass
 * `--since` or `--all` — so it is a convenience, never a source of truth.
 */
export const STATE_PATH = '.ppr/state.json';

export interface VaultState {
  /**
   * The id of the newest entry `learn` has already read.
   *
   * An id rather than a timestamp: `created` is stored at second resolution so
   * it reads well, which means two entries written in the same second are
   * indistinguishable to a time-based mark and the second one is never read.
   * Ids are time-prefixed and monotonic (L2), so comparing them lexicographically
   * orders entries exactly.
   */
  learnedThrough?: string;
}

export function parseState(raw: string | null): VaultState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as VaultState;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt marker means "scan again", which is safe. Reconciliation
    // absorbs the repeats; refusing to run would not.
    return {};
  }
}
