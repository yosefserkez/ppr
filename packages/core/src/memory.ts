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

import { MEMORY_KIND, type Entry } from './types.js';
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

/** A memory entry with the frontmatter ppr writes on facts read back typed. */
export interface Fact {
  id: string;
  /** The fact itself, as one line. */
  text: string;
  /** Entries it was extracted from, oldest first. Empty when hand-written. */
  from: string[];
  origin: FactOrigin;
  status: FactStatus;
  /**
   * The calendar date this fact carries, `YYYY-MM-DD`, when it has one.
   *
   * This is the one piece of structure the layer adds, and it earns its place
   * by making the forward-looking half work with no model at all: "Emily's
   * birthday is in 73 days" is arithmetic, not a judgement, and asking a model
   * to notice it every morning would be slower, costlier, and less reliable.
   */
  date?: string;
  recurs?: FactRecurrence;
  /** Ids of facts this one disagrees with, pending a decision by the user. */
  conflicts: string[];
  /** Set on a retired fact: the fact that replaced it. */
  supersededBy?: string;
  entry: Entry;
}

const asIdList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
};

export const isFact = (entry: Entry): boolean => entry.kind === MEMORY_KIND;

/** Reads the memory frontmatter off an entry. Absence always has a meaning. */
export function toFact(entry: Entry): Fact {
  const fact: Fact = {
    id: entry.id,
    // The body is the fact. First line only: a hand-edited file may have grown
    // a note underneath, and that is the author's business, not the index's.
    text: entry.body.split('\n')[0]?.trim() ?? '',
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
export function mentionScore(text: string, fact: Fact): number {
  const haystack = text.toLowerCase();
  return factTerms(fact.text).filter((term) =>
    new RegExp(`\\b${escapeRegExp(term)}\\b`).test(haystack),
  ).length;
}

export interface Occurrence {
  fact: Fact;
  /** Local midnight on the day it next falls. */
  date: Date;
  /** Whole days from today. 0 is today. */
  days: number;
  /** How many times it has come round before, for "her 24th". */
  ordinal?: number;
}

/**
 * When a dated fact next comes round, or nothing if it is simply past.
 *
 * Pure and offline — this is what lets `ppr brief` work with `ai.provider:
 * none`, and what keeps the model's job to phrasing rather than arithmetic.
 */
export function nextOccurrence(fact: Fact, now: Date): Occurrence | null {
  if (!fact.date) return null;
  const [year, month, day] = fact.date.split('-').map(Number) as [number, number, number];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const on = (y: number): Date => {
    const date = new Date(y, month - 1, day);
    // 29 February in a common year rolls into March. Hold it in its own month.
    return date.getMonth() === month - 1 ? date : new Date(y, month, 0);
  };

  let when: Date;
  if (fact.recurs === 'yearly') {
    when = on(today.getFullYear());
    if (when < today) when = on(today.getFullYear() + 1);
  } else {
    when = on(year);
    if (when < today) return null;
  }

  const occurrence: Occurrence = {
    fact,
    date: when,
    days: Math.round((when.getTime() - today.getTime()) / 86_400_000),
  };
  // `0000` is how an unknown year is recorded — a birthday with no birth year
  // still recurs, it just cannot say which one this will be.
  if (fact.recurs === 'yearly' && year >= 1000 && when.getFullYear() > year) {
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
