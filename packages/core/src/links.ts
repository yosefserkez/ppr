import type { Entry } from './types.js';
import { byCreatedDesc } from './util/order.js';
import { extractLinks, slugify } from './util/text.js';

/** Every name an entry answers to when written as `[[...]]`. */
export const linkKeys = (entry: Entry): string[] => [entry.id, slugify(entry.title)].filter(Boolean);

const normalize = (target: string): string => (/^[0-9a-z]{16}$/.test(target) ? target : slugify(target));

export interface Related {
  entry: Entry;
  score: number;
  reasons: string[];
}

const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'about', 'into', 'what', 'when', 'why',
  'how', 'was', 'were', 'are', 'have', 'has', 'not', 'you', 'your', 'but', 'its',
]);

const titleTokens = (entry: Entry): string[] =>
  slugify(entry.title, 200)
    .split('-')
    .filter((t) => t.length > 2 && !TITLE_STOPWORDS.has(t));

/**
 * The link graph of one pool of entries, computed once and asked many times.
 *
 * `backlinks`, `forwardLinks`, and `related` all want the same three lookups —
 * which name resolves to which entry, who links to whom, and the words in a
 * title — and a thread walk asks all three of every node it reaches. Rebuilding
 * them per call re-slugified the whole vault at every step of the walk.
 *
 * The pool is an explicit argument and never an ambient cache: a thread walks
 * entries with the facts filtered out (I12) while `ppr links` walks all of
 * them, and an index built over the wrong set answers a different question
 * without saying so.
 *
 * Each map is built on first use, so asking only for backlinks still costs
 * only backlinks.
 */
export class LinkIndex {
  /** Every name an entry answers to, to that entry. Last writer wins a clash. */
  private forward?: Map<string, Entry>;
  /** Who links to a target, plus each entry's place in the pool. */
  private incoming?: { sources: Map<string, Entry[]>; rank: Map<string, number> };
  /**
   * Title words, keyed on the entry *object* rather than its id: the entry a
   * caller asks about need not be the pool's copy of it, and a stale title
   * would otherwise answer for a fresh one.
   */
  private readonly tokens = new Map<Entry, string[]>();

  constructor(private readonly pool: Entry[]) {}

  /** Entries that link *to* the given entry. */
  backlinks(entry: Entry): Entry[] {
    const { sources, rank } = this.byTarget();
    const out: Entry[] = [];
    const seen = new Set<string>();
    for (const key of linkKeys(entry)) {
      for (const source of sources.get(key) ?? []) {
        if (source.id === entry.id || seen.has(source.id)) continue;
        seen.add(source.id);
        out.push(source);
      }
    }
    // An entry answers to its id *and* its title, so the two lists are
    // separate; pool order is what a single pass over the pool used to give.
    return out.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }

  /** Entries the given entry links *out* to, plus targets that do not exist yet. */
  forwardLinks(entry: Entry): { resolved: Entry[]; missing: string[] } {
    const forward = this.byName();
    const resolved: Entry[] = [];
    const missing: string[] = [];
    for (const link of entry.links) {
      const hit = forward.get(normalize(link));
      // A link an entry makes to itself is neither a step out nor a dead end.
      if (hit && hit.id !== entry.id) resolved.push(hit);
      else if (!hit) missing.push(link);
    }
    return { resolved, missing };
  }

  /** The entry a `[[name]]` names, if this pool holds one. */
  resolve(link: string): Entry | undefined {
    return this.byName().get(normalize(link));
  }

  /**
   * Cheap relatedness: shared tags, shared outbound links, title-word overlap.
   * No embeddings, no model call — this runs on every `ppr show`.
   */
  related(entry: Entry, limit = 5): Related[] {
    const tags = new Set(entry.tags);
    const links = new Set(entry.links);
    const words = new Set(this.titleWords(entry));
    const linked = new Set([
      ...this.backlinks(entry).map((e) => e.id),
      ...this.forwardLinks(entry).resolved.map((e) => e.id),
    ]);

    const out: Related[] = [];
    for (const other of this.pool) {
      if (other.id === entry.id) continue;
      let score = 0;
      const reasons: string[] = [];

      const sharedTags = other.tags.filter((t) => tags.has(t));
      if (sharedTags.length) {
        score += sharedTags.length * 3;
        reasons.push(sharedTags.map((t) => `#${t}`).join(' '));
      }
      const sharedLinks = other.links.filter((l) => links.has(l));
      if (sharedLinks.length) {
        score += sharedLinks.length * 2;
        reasons.push(`links: ${sharedLinks.join(', ')}`);
      }
      const sharedWords = this.titleWords(other).filter((w) => words.has(w));
      if (sharedWords.length) {
        score += sharedWords.length;
        reasons.push(sharedWords.join(' '));
      }
      if (linked.has(other.id)) {
        score += 5;
        reasons.unshift('linked');
      }
      if (score > 0) out.push({ entry: other, score, reasons });
    }

    out.sort((a, b) => b.score - a.score || byCreatedDesc(a.entry, b.entry));
    return out.slice(0, limit);
  }

  private byName(): Map<string, Entry> {
    if (this.forward) return this.forward;
    const forward = new Map<string, Entry>();
    for (const e of this.pool) for (const key of linkKeys(e)) forward.set(key, e);
    return (this.forward = forward);
  }

  private byTarget(): { sources: Map<string, Entry[]>; rank: Map<string, number> } {
    if (this.incoming) return this.incoming;
    const sources = new Map<string, Entry[]>();
    const rank = new Map<string, number>();
    for (const [i, e] of this.pool.entries()) {
      rank.set(e.id, i);
      for (const link of e.links) {
        const key = normalize(link);
        const at = sources.get(key);
        if (!at) sources.set(key, [e]);
        // Saying the same name twice in one entry is still one backlink.
        else if (at.at(-1) !== e) at.push(e);
      }
    }
    return (this.incoming = { sources, rank });
  }

  private titleWords(entry: Entry): string[] {
    const hit = this.tokens.get(entry);
    if (hit) return hit;
    const words = titleTokens(entry);
    this.tokens.set(entry, words);
    return words;
  }
}

/*
 * The one-shot forms, unchanged for every caller that asks one question of one
 * pool: they build an index and throw it away. Only something that asks the
 * same pool many things — a thread walk — needs to hold on to one.
 */

/** Entries that link *to* the given entry. */
export function backlinks(entries: Entry[], entry: Entry): Entry[] {
  return new LinkIndex(entries).backlinks(entry);
}

/** Entries the given entry links *out* to, plus targets that do not exist yet. */
export function forwardLinks(
  entries: Entry[],
  entry: Entry,
): { resolved: Entry[]; missing: string[] } {
  return new LinkIndex(entries).forwardLinks(entry);
}

/** Cheap relatedness over a throwaway index. See `LinkIndex.related`. */
export function related(entries: Entry[], entry: Entry, limit = 5): Related[] {
  return new LinkIndex(entries).related(entry, limit);
}

/**
 * Regions of a body that must be left exactly as written: fenced and inline
 * code, existing wikilinks, markdown links, headings, and bare URLs.
 */
const PROTECTED =
  /```[\s\S]*?```|`[^`\n]*`|\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|^\s{0,3}#{1,6} .*$|https?:\/\/\S+/gm;

/**
 * Wraps mentions of things the vault already knows about in `[[wikilinks]]`.
 *
 * Deterministic and offline: it links only names that already exist somewhere,
 * so it can introduce a connection but never invent a subject. The first
 * mention in a body is linked and the rest are left alone — linking every
 * occurrence turns a paragraph into a wall of brackets, and the point is to
 * make the graph navigable, not to decorate the prose.
 *
 * The matched text keeps its own capitalisation, so `[[Emily]]` reads as it
 * was written even though targets are indexed in lower case.
 */
export function autoLink(body: string, vocabulary: string[]): string {
  const terms = [...new Set(vocabulary.map((t) => t.trim()).filter((t) => t.length >= 3))]
    // Longest first, so "redis migration" wins over "redis".
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return body;

  const pattern = new RegExp(`(?<![\\w[])(${terms.map(escapeRegExp).join('|')})(?![\\w\\]])`, 'gi');
  // Names the body already links are done: the connection exists, and a second
  // bracket pair further down adds nothing but noise.
  const linked = new Set(extractLinks(body));

  return mapUnprotected(body, (segment) =>
    segment.replace(pattern, (match) => {
      const key = match.toLowerCase();
      if (linked.has(key)) return match;
      linked.add(key);
      return `[[${match}]]`;
    }),
  );
}

/** Applies `fn` to everything outside a protected region, keeping offsets sane. */
function mapUnprotected(body: string, fn: (segment: string) => string): string {
  let out = '';
  let last = 0;
  for (const match of body.matchAll(PROTECTED)) {
    out += fn(body.slice(last, match.index));
    out += match[0];
    last = match.index + match[0].length;
  }
  return out + fn(body.slice(last));
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface TagCount {
  tag: string;
  count: number;
  lastUsed: string;
}

export function tagCounts(entries: Entry[]): TagCount[] {
  const counts = new Map<string, TagCount>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const hit = counts.get(tag);
      if (hit) {
        hit.count++;
        if (entry.created > hit.lastUsed) hit.lastUsed = entry.created;
      } else {
        counts.set(tag, { tag, count: 1, lastUsed: entry.created });
      }
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export interface GraphEdge {
  from: string;
  to: string;
  /** `link` for an explicit wikilink, `tag` for a shared-tag edge. */
  via: 'link' | 'tag';
  label?: string;
}

/** Node/edge projection for any future UI that wants to draw the vault. */
export function graph(entries: Entry[]): { nodes: Entry[]; edges: GraphEdge[] } {
  const index = new LinkIndex(entries);

  const edges: GraphEdge[] = [];
  for (const entry of entries) {
    for (const link of entry.links) {
      const target = index.resolve(link);
      if (target && target.id !== entry.id) {
        edges.push({ from: entry.id, to: target.id, via: 'link', label: link });
      }
    }
  }
  return { nodes: entries, edges };
}
