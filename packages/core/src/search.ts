import { MEMORY_KIND, type Entry, type ListQuery, type SearchHit } from './types.js';
import { plainText, truncate } from './util/text.js';

const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/**
 * Pure filter over already-loaded entries. Same semantics on every platform.
 *
 * Memory is the one kind that has to be asked for by name. It is state rather
 * than an event (see `MEMORY_KIND`), so a list of what happened, a recap of a
 * week, or a search across the journal should not be padded with standing
 * facts — `ppr memory` and `ppr ask` are how you reach those. `-k memory` is
 * the escape hatch, and it works on every command that takes the filter flags.
 */
export function filterEntries(entries: Entry[], query: ListQuery = {}): Entry[] {
  const kinds = new Set(asArray(query.kind).map(String));
  const tags = asArray(query.tag).map((t) => t.replace(/^#/, '').toLowerCase());

  let out = entries.filter((e) => {
    if (!kinds.size && e.kind === MEMORY_KIND) return false;
    if (kinds.size && !kinds.has(e.kind)) return false;
    if (tags.length && !tags.every((t) => e.tags.some((et) => et === t || et.startsWith(`${t}/`))))
      return false;
    if (query.pinned !== undefined && Boolean(e.pinned) !== query.pinned) return false;
    if (query.since && new Date(e.created) < query.since) return false;
    if (query.until && new Date(e.created) >= query.until) return false;
    return true;
  });

  if (query.order === 'asc') out = out.reverse();
  const offset = query.offset ?? 0;
  return query.limit ? out.slice(offset, offset + query.limit) : out.slice(offset);
}

// `min` is 2 when searching, where a stray "a" or "is" only adds noise to a
// query somebody finished typing, and 1 when filtering, where the first letter
// typed is the entire query and dropping it would blank the pane.
const tokenize = (s: string, min = 2): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9#/_'-]+/i)
    .map((t) => t.replace(/^[#'-]+|['-]+$/g, ''))
    .filter((t) => t.length >= min);

const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
};

const RECENCY_HALF_LIFE_DAYS = 90;

/**
 * What the caller is doing, which decides what counts as a match.
 *
 * `search` answers a question about the corpus: recall first, so one token of
 * several is enough to be listed and the ranking sorts the rest out.
 * `filter` is a box somebody is typing into, and a box has to narrow — every
 * token must match, or adding a word makes the list *longer*, and the first
 * character has to narrow already or the pane blanks on every keystroke.
 *
 * They are two modes rather than two functions on purpose: a second matcher is
 * a matcher that drifts (see the DRY note in AGENTS.md), and `ppr search redis`
 * and `/redis` in the browser have to keep agreeing about what a match is and
 * what order matches arrive in.
 */
export type SearchMode = 'search' | 'filter';

/**
 * Lexical search with field weighting and a gentle recency tilt.
 *
 * Deliberately not embeddings: it needs zero setup, works offline, is instant
 * on a personal vault, and never surprises you. `ppr ask` is where semantics live.
 */
export function searchEntries(
  entries: Entry[],
  rawQuery: string,
  opts: { limit?: number; now?: Date; mode?: SearchMode } = {},
): SearchHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const filtering = opts.mode === 'filter';
  const tokens = tokenize(query, filtering ? 1 : 2);
  if (!tokens.length) return [];
  const now = opts.now ?? new Date();

  const scored: SearchHit[] = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    const body = plainText(entry.body).toLowerCase();
    const tags = entry.tags.join(' ');

    let score = 0;
    let matched = 0;
    for (const token of tokens) {
      let tokenScore = 0;
      if (title.includes(token)) tokenScore += 6;
      if (tags.includes(token)) tokenScore += 4;
      const hits = countOccurrences(body, token);
      if (hits) tokenScore += 2 + Math.min(hits - 1, 4) * 0.5;
      if (entry.source?.toLowerCase().includes(token)) tokenScore += 1;
      if (tokenScore) matched++;
      score += tokenScore;
    }
    if (!matched) continue;
    if (filtering && matched < tokens.length) continue;

    // Every token present beats a partial match, always.
    if (matched === tokens.length) score *= 2;
    if (title.includes(query)) score += 10;
    if (body.includes(query)) score += 5;

    const ageDays = (now.getTime() - new Date(entry.created).getTime()) / 86_400_000;
    score *= 1 + 0.25 * Math.exp(-Math.max(ageDays, 0) / RECENCY_HALF_LIFE_DAYS);
    if (entry.pinned) score *= 1.15;

    scored.push({ entry, score, excerpt: excerpt(entry.body, tokens) });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.entry.created === b.entry.created
        ? a.entry.id < b.entry.id
          ? 1
          : -1
        : a.entry.created < b.entry.created
          ? 1
          : -1),
  );
  return opts.limit ? scored.slice(0, opts.limit) : scored;
}

/** A readable window around the first matching token. */
export function excerpt(body: string, tokens: string[], width = 160): string {
  const text = plainText(body);
  if (!text) return '';
  const lower = text.toLowerCase();
  let at = -1;
  for (const token of tokens) {
    const i = lower.indexOf(token);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return truncate(text, width);

  const start = Math.max(0, at - Math.floor(width / 3));
  const slice = text.slice(start, start + width);
  return (start > 0 ? '…' : '') + slice.trim() + (start + width < text.length ? '…' : '');
}
