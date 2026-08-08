import type { Entry } from './types.js';
import { extractLinks, slugify } from './util/text.js';

/** Every name an entry answers to when written as `[[...]]`. */
export const linkKeys = (entry: Entry): string[] => [entry.id, slugify(entry.title)].filter(Boolean);

const normalize = (target: string): string => (/^[0-9a-z]{16}$/.test(target) ? target : slugify(target));

/** Entries that link *to* the given entry. */
export function backlinks(entries: Entry[], entry: Entry): Entry[] {
  const keys = new Set(linkKeys(entry));
  return entries.filter((e) => e.id !== entry.id && e.links.some((l) => keys.has(normalize(l))));
}

/** Entries the given entry links *out* to, plus targets that do not exist yet. */
export function forwardLinks(
  entries: Entry[],
  entry: Entry,
): { resolved: Entry[]; missing: string[] } {
  const index = new Map<string, Entry>();
  for (const e of entries) for (const key of linkKeys(e)) index.set(key, e);

  const resolved: Entry[] = [];
  const missing: string[] = [];
  for (const link of entry.links) {
    const hit = index.get(normalize(link));
    if (hit && hit.id !== entry.id) resolved.push(hit);
    else if (!hit) missing.push(link);
  }
  return { resolved, missing };
}

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
 * Cheap relatedness: shared tags, shared outbound links, title-word overlap.
 * No embeddings, no model call — this runs on every `ppr show`.
 */
export function related(entries: Entry[], entry: Entry, limit = 5): Related[] {
  const tags = new Set(entry.tags);
  const links = new Set(entry.links);
  const words = new Set(titleTokens(entry));
  const linked = new Set([
    ...backlinks(entries, entry).map((e) => e.id),
    ...forwardLinks(entries, entry).resolved.map((e) => e.id),
  ]);

  const out: Related[] = [];
  for (const other of entries) {
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
    const sharedWords = titleTokens(other).filter((w) => words.has(w));
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

  out.sort((a, b) => b.score - a.score || (a.entry.created < b.entry.created ? 1 : -1));
  return out.slice(0, limit);
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
  const index = new Map<string, Entry>();
  for (const e of entries) for (const key of linkKeys(e)) index.set(key, e);

  const edges: GraphEdge[] = [];
  for (const entry of entries) {
    for (const link of entry.links) {
      const target = index.get(normalize(link));
      if (target && target.id !== entry.id) {
        edges.push({ from: entry.id, to: target.id, via: 'link', label: link });
      }
    }
  }
  return { nodes: entries, edges };
}
