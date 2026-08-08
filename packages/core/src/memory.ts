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

/** A memory entry with the frontmatter ppr writes on facts read back typed. */
export interface Fact {
  id: string;
  /** The fact itself, as one line. */
  text: string;
  /** Entries it was extracted from, oldest first. Empty when hand-written. */
  from: string[];
  origin: FactOrigin;
  status: FactStatus;
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
  return fact;
}

/** The `extra` block for a fact, with empty fields left out rather than nulled. */
export function factExtra(fields: {
  from?: string[];
  status?: FactStatus;
  conflicts?: string[];
  supersededBy?: string;
}): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (fields.from?.length) extra.from = fields.from;
  if (fields.status && fields.status !== 'current') extra.status = fields.status;
  if (fields.conflicts?.length) extra.conflicts = fields.conflicts;
  if (fields.supersededBy) extra.supersededBy = fields.supersededBy;
  return extra;
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
