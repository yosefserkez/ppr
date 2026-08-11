import { MEMORY_KIND, type Entry, type EntryInput, type EntryPatch, type Kind } from './types.js';
import { memoryPath } from './memory.js';
import { parseDocument, serializeDocument, serializeRawDocument } from './markdown.js';
import { createId, encodeTime, timeFromId } from './util/id.js';
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
  const { data, body, rawFrontmatter } = parseDocument(raw);
  // Kept apart from `created` because "the file named no day at all" is the
  // case that decides how a derived id is built: fall back to now() first and
  // the id is minted fresh on every read (see `idFromPath`).
  const stated = statedDate(data.created, dateFromPath(path), timeFromId(String(data.id ?? '')));
  const created = stated ?? new Date();
  const id = typeof data.id === 'string' && data.id ? data.id : idFromPath(path, stated);
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
  if (rawFrontmatter !== undefined) entry.raw = { frontmatter: rawFrontmatter };
  return entry;
}

export function serializeEntry(entry: Entry): string {
  // Frontmatter ppr could not read is frontmatter ppr cannot rewrite: a fresh
  // block over it takes the id and any third-party keys with it, silently. So
  // the original block goes back out verbatim and the body — the part ppr did
  // read — carries the change.
  //
  // Refusing here was the other option and it breaks I2: `ppr append` has
  // already consumed stdin by the time this runs, so a throw costs the user
  // the words they piped in and names only the file. No file problem may do
  // that. The price is that a *frontmatter* change to such a file cannot be
  // persisted — there is no readable block to merge into — which is why its
  // identity is derived from the path instead (see `idFromPath`).
  if (entry.raw) return serializeRawDocument(entry.raw.frontmatter, entry.body);

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
 * `extra` rides along when there is any, and that is what makes an event
 * payload complete: a consumer told "a reminder was created" must be able to
 * see the day it is for without reading the file back or racing the next
 * write. It is absent on the overwhelming majority of entries, which have no
 * unowned frontmatter at all, so ordinary `--json` output is unchanged.
 * `factJson` still exists on top of this: it flattens the memory layer's
 * fields for people reading `ppr memory ls --json` with their eyes.
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
  ...(Object.keys(entry.extra).length ? { extra: entry.extra } : {}),
});

/** The first candidate that names a real moment, or null if the file names none. */
function statedDate(...candidates: unknown[]): Date | null {
  for (const c of candidates) {
    if (c instanceof Date && !Number.isNaN(c.getTime())) return c;
    if (typeof c === 'string' && c) {
      const d = new Date(c);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

const firstDate = (...candidates: unknown[]): Date => statedDate(...candidates) ?? new Date();

/**
 * An id for a file that arrived without one, derived from where it sits.
 *
 * `createId` rolls a fresh random tail on every call, so an adopted file used
 * to become a *different* entry on every reindex — and `fact.from`, `[[id]]`,
 * and the high-water mark all pointed at something that no longer existed.
 * Deriving from the path instead makes adoption idempotent: the same file is
 * the same entry, run after run. Files ppr wrote are unaffected; they always
 * carry an `id` in frontmatter (see `serializeEntry`).
 *
 * Nothing here may route through `createId`, which mutates the monotonic
 * counter in `util/id.ts`. Parsing is a *read* path, so one id-less file in a
 * vault meant that merely listing it re-rolled the tail the next write was
 * about to increment — L2, back again through the side door. `encodeTime` is
 * the pure half and is all this needs.
 *
 * The head is the file's own moment when it has one — frontmatter `created`,
 * or a dated filename — so an adopted entry still sorts where it belongs.
 * When the file names no day, `created` is `new Date()`, so encoding it would
 * mint a different id on every parse: exactly the re-roll this function
 * exists to remove. The head is therefore hashed from the path too, and such
 * an id sorts arbitrarily among ids. That is the honest answer for a file
 * that never said when it was written, and it costs little: `created` decides
 * order and the id is only the tiebreak (`util/order.ts`).
 *
 * Three seeds rather than one so the 80 bits of an id are not 32 bits
 * repeated. Two adopted files hashing alike is possible and costs no more
 * than the re-roll it replaces — and unlike the re-roll, it is not the common
 * case.
 */
function idFromPath(path: string, stated: Date | null): string {
  const head = stated
    ? encodeTime(stated.getTime(), 10)
    : base32(hash(path, 0x811c9dc5), 4) + base32(hash(path, 0x01000193), 6);
  return head + base32(hash(path, 0x9e3779b1), 6);
}

/** FNV-1a. Deterministic and short; nothing here is a security boundary. */
function hash(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

/** Folded into exactly `len` id characters, so the result still passes `isId`. */
const base32 = (n: number, len: number): string => encodeTime(n % 32 ** len, len);

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
