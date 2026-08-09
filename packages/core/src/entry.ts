import { MEMORY_KIND, type Entry, type EntryInput, type EntryPatch, type Kind } from './types.js';
import { memoryPath } from './memory.js';
import { parseDocument, serializeDocument } from './markdown.js';
import { createId, timeFromId } from './util/id.js';
import { dayKey, timeKey, toLocalISO } from './util/time.js';
import { extractLinks, extractTags, slugify, titleFromBody } from './util/text.js';

/** Frontmatter keys ppr owns. Everything else round-trips untouched in `extra`. */
const OWNED = new Set([
  'id',
  'kind',
  'title',
  'created',
  'updated',
  'tags',
  'links',
  'source',
  'pinned',
]);

export const ENTRIES_DIR = 'entries';

/**
 * `entries/2026/07/2026-07-27-1432-fix-the-deploy-x7k2.md`
 *
 * Date-first so the tree sorts and greps well; the id suffix guarantees
 * uniqueness without making the name unreadable.
 *
 * Facts are the exception and go to `memory/` instead — see `memoryPath`.
 */
export function entryPath(entry: Pick<Entry, 'id' | 'created' | 'title' | 'kind'>): string {
  if (entry.kind === MEMORY_KIND) return memoryPath(entry);
  const d = new Date(entry.created);
  const day = dayKey(d);
  const slug = slugify(entry.title || entry.kind) || 'entry';
  const suffix = entry.id.slice(-4);
  const [year, month] = [day.slice(0, 4), day.slice(5, 7)];
  return `${ENTRIES_DIR}/${year}/${month}/${day}-${timeKey(d)}-${slug}-${suffix}.md`;
}

const asStringArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
};

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/** Tags/links are derived from the body and merged with explicit frontmatter. */
function derive(body: string, tags: string[] = []): { tags: string[]; links: string[] } {
  return {
    tags: uniq([...tags.map((t) => t.replace(/^#/, '').toLowerCase()), ...extractTags(body)]).sort(),
    links: extractLinks(body).sort(),
  };
}

export function createEntry(input: EntryInput, now: Date = new Date()): Entry {
  const created = input.created ? new Date(input.created) : now;
  const id = createId(created);
  const body = input.body.trim();
  const title = (input.title ?? titleFromBody(body)).trim() || 'Untitled';
  const kind: Kind = input.kind ?? 'note';
  const { tags, links } = derive(body, input.tags);

  const entry: Entry = {
    id,
    kind,
    title,
    created: toLocalISO(created),
    updated: toLocalISO(created),
    tags,
    links,
    extra: input.extra ?? {},
    body,
    path: '',
  };
  if (input.source) entry.source = input.source;
  if (input.pinned) entry.pinned = true;
  entry.path = entryPath(entry);
  return entry;
}

/**
 * Patching `extra` merges, so keys ppr does not own survive (I3). Setting a key
 * to `undefined` is how you remove one — without that there is no way to clear
 * a field, and a settled conflict would keep pointing at the fact it settled.
 */
function mergeExtra(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base, ...patch };
  for (const [key, value] of Object.entries(out)) if (value === undefined) delete out[key];
  return out;
}

export function applyPatch(entry: Entry, patch: EntryPatch, now: Date = new Date()): Entry {
  const body = patch.body !== undefined ? patch.body.trim() : entry.body;
  const explicitTags = patch.tags ?? entry.tags;
  const { tags, links } = derive(body, explicitTags);

  const next: Entry = {
    ...entry,
    body,
    tags,
    links,
    kind: patch.kind ?? entry.kind,
    title: (patch.title ?? entry.title).trim() || 'Untitled',
    updated: toLocalISO(now),
    extra: patch.extra ? mergeExtra(entry.extra, patch.extra) : entry.extra,
  };
  if (patch.source !== undefined) next.source = patch.source;
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  // Renaming the title moves the file so the tree stays browsable.
  next.path = entryPath(next);
  return next;
}

/**
 * Parses a vault file. Files written by hand — no frontmatter, missing id —
 * are adopted rather than rejected: ppr fills in what it can from the path.
 */
export function parseEntry(path: string, raw: string): Entry {
  const { data, body } = parseDocument(raw);
  const created = firstDate(data.created, dateFromPath(path), timeFromId(String(data.id ?? '')));
  const id = typeof data.id === 'string' && data.id ? data.id : createId(created);
  const title = String(data.title ?? '').trim() || titleFromBody(body) || basename(path);
  const explicit = asStringArray(data.tags);
  const derived = derive(body, explicit);

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!OWNED.has(k)) extra[k] = v;

  const entry: Entry = {
    id,
    kind: String(data.kind ?? 'note'),
    title,
    created: toLocalISO(created),
    updated: toLocalISO(firstDate(data.updated, created)),
    tags: derived.tags,
    links: derived.links,
    extra,
    body,
    path,
  };
  if (typeof data.source === 'string' && data.source) entry.source = data.source;
  if (data.pinned === true) entry.pinned = true;
  return entry;
}

export function serializeEntry(entry: Entry): string {
  const data: Record<string, unknown> = {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    created: entry.created,
    updated: entry.updated,
  };
  if (entry.tags.length) data.tags = entry.tags;
  if (entry.source) data.source = entry.source;
  if (entry.pinned) data.pinned = true;
  Object.assign(data, entry.extra);
  return serializeDocument(data, entry.body);
}

/**
 * An entry as JSON — the one wire shape ppr publishes.
 *
 * `ppr ls --json`, `ppr show --json`, and the payload of every event that
 * carries an entry are all this function. It lives in core rather than in the
 * renderer because it is now an interface other people write code against: a
 * hook reading an event and a script reading `--json` must be able to share a
 * parser, and two definitions of "an entry, as JSON" would eventually disagree
 * about a field.
 *
 * Owned frontmatter only. `extra` is deliberately absent — a fact's `date`,
 * `from`, and `status` are exposed by `factJson`, which is where the memory
 * layer decides what it publishes (I3 keeps them round-tripping either way).
 */
export const entryJson = (entry: Entry) => ({
  id: entry.id,
  kind: entry.kind,
  title: entry.title,
  created: entry.created,
  updated: entry.updated,
  tags: entry.tags,
  links: entry.links,
  ...(entry.source ? { source: entry.source } : {}),
  ...(entry.pinned ? { pinned: true } : {}),
  path: entry.path,
  body: entry.body,
});

function firstDate(...candidates: unknown[]): Date {
  for (const c of candidates) {
    if (c instanceof Date && !Number.isNaN(c.getTime())) return c;
    if (typeof c === 'string' && c) {
      const d = new Date(c);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return new Date();
}

/** `entries/2026/07/2026-07-27-1432-slug-x7k2.md` -> local Date. */
function dateFromPath(path: string): Date | null {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2}))?/.exec(basename(path));
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    m[4] ? Number(m[4]) : 0,
    m[5] ? Number(m[5]) : 0,
  );
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
