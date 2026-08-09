/**
 * Threads: one line of thought, followed across days or years.
 *
 * A thread is not a new kind of thing and it stores nothing. It is a walk over
 * the graph that is already there — the `[[wikilinks]]` you wrote, the tags you
 * reused, the words in your own titles — seeded by an entry or by a search, and
 * handed back oldest first so it reads as a story rather than as a list of
 * matches.
 *
 * The failure mode this file is written against is an expansion that pulls in
 * the whole vault: once "related to something related to something" is allowed
 * to chain, every entry is on every thread and the feature says nothing. So the
 * walk is bounded by strength rather than by taste — a wikilink is the user's
 * own assertion that two entries belong together and barely fades, a shared tag
 * is a coincidence of vocabulary and fades fast, and below a floor the walk
 * stops. The bar for a weak edge is deliberately high for the same reason
 * `mentionScore` counts whole words and asks for two of them: one word in
 * common is a coincidence, and a thread built out of coincidences is worse than
 * no thread at all.
 *
 * Everything here is pure and offline. No model decides what belongs in a
 * thread, because "these two notes are the same thought" is a claim the user
 * already made by linking or tagging them, and inventing the claim is how a
 * recall tool starts lying.
 */

import { MEMORY_KIND, type Entry } from './types.js';
import { backlinks, forwardLinks, related } from './links.js';
import { toFact, type Fact } from './memory.js';
import { searchEntries } from './search.js';

/** Why an entry is on the thread. */
export type ThreadReason =
  /** The entry that was asked for. */
  | 'seed'
  /** A search hit for the words that were asked about. */
  | 'matched'
  /** Reached by a `[[wikilink]]`, in either direction. */
  | 'linked'
  /** Reached by shared tags, shared links, or title-word overlap. */
  | 'related';

export interface ThreadMember {
  entry: Entry;
  reason: ThreadReason;
  /** The reason in the reader's words: `linked`, `#coffee · unit economics`. */
  why: string;
  /** Steps from a seed. 0 is a seed. */
  hops: number;
  /** `related()`'s score for the edge that admitted it. 0 for a seed or a link. */
  score: number;
  /** Confidence: 1 at the seed, decaying with every step away from it. */
  strength: number;
}

/** A standing fact drawn from entries on the thread — what it concluded. */
export interface ThreadFact {
  fact: Fact;
  /** The thread entries it was extracted from. */
  from: string[];
}

/** A silence long enough to be part of the story. See `threadGaps`. */
export interface ThreadGap {
  /** Id of the entry the thread was put down after. */
  after: string;
  /** Id of the entry it was picked up with. */
  before: string;
  days: number;
}

export interface Thread {
  /** What was asked for, verbatim. */
  query: string;
  /** How that was read: an entry ref, or words to search for. */
  seededBy: 'ref' | 'query';
  /** Oldest first — a thread is read forwards. */
  entries: ThreadMember[];
  facts: ThreadFact[];
  gaps: ThreadGap[];
}

/**
 * How fast a connection fades with distance.
 *
 * A wikilink is a deliberate act, so it survives four steps before the floor
 * stops it (0.7⁴ = 0.24, 0.7⁵ = 0.17). Relatedness is an accident of
 * vocabulary, so it survives one: a related entry sits at 0.35, and anything
 * related to *that* lands at 0.12 and is dropped. Tags therefore widen a
 * thread and never lengthen it, which is the difference between "this is the
 * same thought" and "these are about the same subject".
 */
const LINK_DECAY = 0.7;
const RELATED_DECAY = 0.35;
const ADMIT = 0.2;

/**
 * The weakest `related()` score that may join a thread.
 *
 * Its scale: a shared tag is 3, a shared outbound link 2, a shared title word
 * 1. Four is therefore "more than one signal, and at least one of them
 * stronger than a word" — a tag plus a title word, or two tags. One shared tag
 * (a vault where everything is `#work`) and one shared word (`the deploy`) are
 * both coincidences, and admitting either is how a thread becomes the vault.
 */
const RELATED_MIN = 4;

/** Candidates considered per node. A bound on fan-out, not on the thread. */
const RELATED_FANOUT = 8;

/** Search hits that may seed a thread, and how far below the best one counts. */
const SEED_LIMIT = 5;
const SEED_FLOOR = 0.25;

/**
 * The thread around a set of seeds.
 *
 * `pool` is the entries that are allowed on it — facts are excluded by the
 * caller, because a fact is state rather than a moment and has no place in a
 * timeline (I12). It reaches the thread through `threadFacts` instead.
 */
export function walkThread(pool: Entry[], seeds: ThreadMember[]): ThreadMember[] {
  const found = new Map<string, ThreadMember>();
  for (const seed of seeds) {
    const seen = found.get(seed.entry.id);
    if (!seen || seen.strength < seed.strength) found.set(seed.entry.id, seed);
  }

  let frontier = [...found.values()];
  while (frontier.length) {
    const next: ThreadMember[] = [];
    for (const node of frontier) {
      for (const candidate of neighbours(pool, node)) {
        if (candidate.strength < ADMIT) continue;
        const seen = found.get(candidate.entry.id);
        // A better route to somewhere already on the thread replaces the
        // reason it is there and is walked again from — otherwise which edge
        // was tried first would decide what the thread says about an entry.
        if (seen && seen.strength >= candidate.strength) continue;
        found.set(candidate.entry.id, candidate);
        next.push(candidate);
      }
    }
    frontier = next;
  }

  return [...found.values()].sort(byTime);
}

/** Oldest first, ties on id — monotonic, so the order is the same every run (L2). */
const byTime = (a: ThreadMember, b: ThreadMember): number =>
  a.entry.created === b.entry.created
    ? a.entry.id < b.entry.id
      ? -1
      : 1
    : a.entry.created < b.entry.created
      ? -1
      : 1;

/** Everything one step from a node, links first so a link never loses to a tag. */
function neighbours(pool: Entry[], node: ThreadMember): ThreadMember[] {
  const out: ThreadMember[] = [];
  const linked = new Set<string>();

  for (const entry of [
    ...forwardLinks(pool, node.entry).resolved,
    ...backlinks(pool, node.entry),
  ]) {
    if (linked.has(entry.id)) continue;
    linked.add(entry.id);
    out.push({
      entry,
      reason: 'linked',
      why: 'linked',
      hops: node.hops + 1,
      score: 0,
      strength: node.strength * LINK_DECAY,
    });
  }

  for (const hit of related(pool, node.entry, RELATED_FANOUT)) {
    if (hit.score < RELATED_MIN || linked.has(hit.entry.id)) continue;
    out.push({
      entry: hit.entry,
      reason: 'related',
      why: hit.reasons.join(' · '),
      hops: node.hops + 1,
      score: hit.score,
      strength: node.strength * RELATED_DECAY,
    });
  }

  return out;
}

/**
 * The standing facts drawn from entries on the thread.
 *
 * The memory layer is part of the story: "this is what you concluded" is
 * exactly the thing you have forgotten when you come back to something eight
 * months later. Retired facts are left out — a fact you have since superseded
 * is not what you concluded.
 */
export function threadFacts(all: Entry[], members: ThreadMember[]): ThreadFact[] {
  const ids = new Set(members.map((m) => m.entry.id));
  const out: ThreadFact[] = [];
  for (const entry of all) {
    if (entry.kind !== MEMORY_KIND) continue;
    const fact = toFact(entry);
    if (fact.status !== 'current') continue;
    const from = fact.from.filter((id) => ids.has(id));
    if (from.length) out.push({ fact, from });
  }
  return out.sort((a, b) => (a.fact.entry.created < b.fact.entry.created ? -1 : 1));
}

/** The shortest silence anybody would call putting something down. */
const GAP_MIN_DAYS = 14;
/** The longest silence that could still be somebody's normal rhythm. */
const GAP_MAX_DAYS = 60;
/** How many times the usual beat a silence has to be before it is a gap. */
const GAP_FACTOR = 6;

/**
 * Where the thread was put down and picked up again.
 *
 * Relative first, because "a long time" only means anything against the
 * thread's own rhythm: a fortnight of silence in something you were writing
 * about daily is a break, and in something you touch every other month it is
 * nothing. So the bar is six times the median interval — a beat six times
 * longer than the usual one is not the usual one — clamped at both ends by the
 * two things that are true whatever the rhythm was. Under a fortnight nothing
 * counts, or a thread written across one week sprouts markers between
 * Wednesday and Friday. Over two months everything counts, or a slow thread
 * hides the eight-month silence that is the most interesting thing about it.
 *
 * Pure arithmetic over `created`, so the offline view tells the same shape of
 * time as the model's story does.
 */
export function threadGaps(entries: Entry[]): ThreadGap[] {
  const ordered = [...entries].sort((a, b) => (a.created < b.created ? -1 : 1));
  if (ordered.length < 3) return [];

  const spans: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    spans.push(daysBetween(ordered[i - 1]!.created, ordered[i]!.created));
  }
  const threshold = Math.min(GAP_MAX_DAYS, Math.max(GAP_MIN_DAYS, GAP_FACTOR * median(spans)));

  const gaps: ThreadGap[] = [];
  for (const [i, span] of spans.entries()) {
    if (span < threshold) continue;
    gaps.push({ after: ordered[i]!.id, before: ordered[i + 1]!.id, days: Math.round(span) });
  }
  return gaps;
}

const daysBetween = (a: string, b: string): number =>
  Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * A gap in words. One definition, because the offline timeline and the
 * fallback story both say it and would otherwise say it differently.
 */
export function gapWords(days: number): string {
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} later`;
  if (days < 21) return plural(days, 'day');
  if (days < 60) return plural(Math.round(days / 7), 'week');
  if (days < 545) return plural(Math.round(days / 30), 'month');
  return plural(Math.round(days / 365), 'year');
}

/**
 * The floor for saying "this continues something" without being asked.
 *
 * Twice the floor for a thread you went looking for, because nobody asked for
 * this one. A line printed after every capture that is right two thirds of the
 * time is noise, and noise on the capture path is the one place ppr cannot
 * afford it — that is the same trade `mentionsSince` makes when it insists on
 * two distinctive whole words before claiming a fact has been thought about.
 */
const NUDGE_RELATED_MIN = 8;

/**
 * How big the thread is, when a just-written entry clearly continues one.
 *
 * Only the entry's *own* neighbours count — one hop, and either a wikilink it
 * actually resolved or a relatedness score twice the browsing floor. Two of
 * them, because one prior entry is a pair and a pair is a coincidence; the
 * third time something comes back it is a line of thought.
 *
 * The number handed back is the whole thread, since that is what
 * `ppr thread <id>` will show, and a count that disagreed with the command it
 * names would be worse than saying nothing.
 */
export function continuesThread(thread: Thread, entryId: string): number | null {
  const near = thread.entries.filter(
    (m) =>
      m.entry.id !== entryId &&
      m.hops === 1 &&
      (m.reason === 'linked' || m.score >= NUDGE_RELATED_MIN),
  );
  return near.length >= 2 ? thread.entries.length : null;
}

/**
 * Where a thread starts: one entry you named, or the words you asked about.
 *
 * **An id is a ref; everything else is a search.** `latest` and `^2` are
 * positions in the journal and a short id is a handle ppr printed, so those
 * name one entry. A word is not — and sending it to search rather than to
 * `Catalog.resolve` is deliberate: resolve would take a title fragment and
 * answer with exactly one entry, quietly throwing away the four other entries
 * that mention it, which on a thread is throwing away the thread.
 *
 * Search hits are kept only while they are in the same league as the best one.
 * A hit scoring a tenth of the top one shares a word and nothing else, and a
 * seed is where a walk *starts*, so a bad one costs everything downstream of
 * it.
 */
export function threadSeeds(
  pool: Entry[],
  query: string,
  opts: { now?: Date; limit?: number } = {},
): { seeds: ThreadMember[]; seededBy: 'ref' | 'query' } {
  const asSeed = (entry: Entry, reason: 'seed' | 'matched'): ThreadMember => ({
    entry,
    reason,
    why: reason === 'seed' ? 'the entry you named' : 'matched',
    hops: 0,
    score: 0,
    strength: 1,
  });

  const named = namedEntry(pool, query);
  if (named) return { seeds: [asSeed(named, 'seed')], seededBy: 'ref' };

  const hits = searchEntries(pool, query, {
    limit: opts.limit ?? SEED_LIMIT,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const best = hits[0]?.score ?? 0;
  return {
    seeds: hits.filter((h) => h.score >= best * SEED_FLOOR).map((h) => asSeed(h.entry, 'matched')),
    seededBy: 'query',
  };
}

/** The one entry a ref names, or nothing if the words are not a ref at all. */
function namedEntry(pool: Entry[], query: string): Entry | undefined {
  const ref = query.trim().toLowerCase();
  if (ref === 'latest' || ref === 'last') return pool[0];
  const nth = /^\^(\d+)$/.exec(ref);
  if (nth) return pool[Number(nth[1]) - 1];
  // Four characters, because a shorter one is a word that happens to be
  // spelled in base32 rather than a handle anybody was handed.
  if (ref.length < 4 || !/^[0-9a-hjkmnp-tv-z]+$/.test(ref)) return undefined;
  const matches = pool.filter((e) => e.id.startsWith(ref) || e.id.endsWith(ref));
  return matches.length === 1 ? matches[0] : undefined;
}
