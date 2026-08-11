import { MEMORY_KIND, type Entry } from './types.js';
import type { Storage } from './ports.js';
import { ENTRIES_DIR, parseEntry } from './entry.js';
import { MEMORY_DIR } from './memory.js';
import { ambiguous, notFound } from './errors.js';
import { isId, shortId } from './util/id.js';
import { byCreatedDesc } from './util/order.js';
import { slugify } from './util/text.js';

const CACHE_PATH = '.ppr/cache/index.json';
/**
 * Bumped whenever a cached `Entry` stops meaning what an older ppr wrote.
 *
 * A cache entry now carries *identity* — the `raw` block of a file ppr could
 * not read, and an id derived from the path for a file that has none — so a
 * warm cache from before that change hands back entries this code would never
 * have produced, and deleting it would change behaviour rather than only
 * speed. That is exactly the thing I1 forbids, so a shape change here is a
 * version bump; `readCache` then discards the old file and re-parses.
 *
 * 3 is such a bump even though the shape did not change. A cache written by 2
 * can hold an entry that no parse would ever produce — `budget: .inf` stored
 * as `null`, because that is what JSON made of it (see `survivesJson`) — and
 * the next write to that file would have serialized the loss back over the
 * user's frontmatter. Those entries are no longer written; the ones already on
 * disk have to go.
 */
const CACHE_VERSION = 3;

/** The two trees a vault holds: what happened, and what is true (I12). */
const ROOTS = [ENTRIES_DIR, MEMORY_DIR];

interface CacheFile {
  version: number;
  files: Record<string, { mtime: number; size: number; entry: Entry }>;
}

/**
 * Whether JSON would hand this value back unchanged.
 *
 * The cache stores a parsed `Entry` and reads it back through
 * `JSON.parse(JSON.stringify(…))`, and YAML says things JSON cannot: `.inf`
 * and `.nan` come back as `null`, a `!!timestamp` as a string, a `!!set` as
 * `{}`. So a cache *hit* produced a different entry from a cache miss — and
 * since the next write re-serializes from whatever entry it was handed, and
 * `serializeDocument` drops nulls, an `append` through a warm cache *deleted*
 * `budget: .inf` from a file ppr had only been asked to add a line to. I3 and
 * I1 at once, and destructively.
 *
 * The check is on the JS side of the trip rather than the YAML side, because
 * that side is closed: seven `typeof` results and a prototype. A replacer that
 * had to enumerate YAML's types instead would be correct only until somebody
 * wrote a tag it had not heard of, and would fail silently when they did.
 * Anything outside the set means the file is left out of the cache and parsed
 * again next time — one re-parse for a rare exotic file, in exchange for a hit
 * that is a parse by construction rather than by a list of special cases.
 */
function survivesJson(value: unknown, seen: Set<object> = new Set()): boolean {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  // -0 belongs with NaN and the infinities: JSON writes it as `0`, and a cache
  // that turned `-0.0` into `0` in somebody's frontmatter is the same bug.
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  // undefined, bigint, symbol, function: the rest of what never comes back.
  if (typeof value !== 'object') return false;
  if (value === null) return true;

  // Reaching one object twice is either a cycle, which `JSON.stringify` throws
  // on, or a YAML anchor, which it copies — so `b: *x` would be written back
  // as a second copy of the block instead of the alias the file actually says.
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => survivesJson(item, seen));
  // Plain objects only. A Date, a Set, a Map, a typed array all serialize to
  // something else — often to `{}`, which is why comparing the two objects
  // after the round trip is the weaker test rather than the obvious one.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((v) => survivesJson(v, seen));
}

/**
 * How a candidate is offered back when a ref matched more than one entry.
 *
 * The short id, because that is the handle every listing prints and `resolve`
 * accepts it as a suffix — so the user can copy a line of the hint and type it
 * back. An id *prefix* would not do: the first ten characters are a timestamp,
 * so two entries written in the same second would be offered under identical
 * labels, which is no choice at all.
 */
const candidate = (entry: Entry): string => `${shortId(entry.id)} ${entry.title}`;

/**
 * The in-memory view of the vault, backed by an mtime-keyed cache.
 *
 * The markdown files are the source of truth — always. The cache only skips
 * re-parsing files that have not changed, so editing a note in vim, or pulling
 * the vault from git on another machine, is picked up on the next command.
 */
export class Catalog {
  private byId = new Map<string, Entry>();
  /**
   * The sorted view and its timeline projection, built on demand.
   *
   * Around twenty call sites ask for one of these per command, and each ask
   * used to re-sort the whole map. They are dropped rather than rebuilt when
   * the map changes, because `index()` runs once per file inside `load()` and
   * rebuilding there would make a cold start quadratic.
   */
  private sortedAll: Entry[] | null = null;
  private sortedTimeline: Entry[] | null = null;
  private cache: CacheFile = { version: CACHE_VERSION, files: {} };
  private dirty = false;

  constructor(private readonly storage: Storage) {}

  async load(): Promise<this> {
    // Rebuilt from scratch so a reload reflects deletions, not just additions.
    this.byId.clear();
    this.dropOrder();
    const cached = await this.readCache();
    const files = (await Promise.all(ROOTS.map((root) => this.storage.list(root)))).flat();
    const seen = new Set<string>();
    const next: CacheFile['files'] = {};

    for (const file of files) {
      if (!file.path.endsWith('.md')) continue;
      seen.add(file.path);
      const hit = cached.files[file.path];
      if (hit && hit.mtime === file.mtime && hit.size === file.size) {
        next[file.path] = hit;
        this.index(hit.entry);
        continue;
      }
      const raw = await this.storage.read(file.path);
      if (raw === null) continue;
      const entry = parseEntry(file.path, raw);
      next[file.path] = { mtime: file.mtime, size: file.size, entry };
      this.index(entry);
      this.dirty = true;
    }

    if (Object.keys(cached.files).some((p) => !seen.has(p))) this.dirty = true;
    this.cache = { version: CACHE_VERSION, files: next };
    return this;
  }

  /** Newest first, ties broken on the id so the order is the same every run. */
  entries(): Entry[] {
    return [...this.ordered()];
  }

  /**
   * The entries that *happened*, newest first.
   *
   * `latest` and `^2` are positions in a journal, and a standing fact has no
   * position in one — so a memory extracted a minute ago must not become the
   * thing `ppr show` and `ppr memory learn` mean by "the last entry".
   */
  timeline(): Entry[] {
    return [...this.orderedTimeline()];
  }

  /**
   * The memoised orders, which are the catalog's own copies and never leave it.
   *
   * `entries()` and `timeline()` hand out a shallow copy instead: `Vault.all()`
   * passes one straight through to a host, and a caller that sorted or reversed
   * what it was given would silently reorder the vault for every reader after
   * it. A copy costs one pass where the sort cost n log n, and it keeps the
   * contract these methods already had — a fresh array the caller owns.
   */
  private ordered(): Entry[] {
    if (!this.sortedAll) this.sortedAll = [...this.byId.values()].sort(byCreatedDesc);
    return this.sortedAll;
  }

  private orderedTimeline(): Entry[] {
    if (!this.sortedTimeline) {
      this.sortedTimeline = this.ordered().filter((e) => e.kind !== MEMORY_KIND);
    }
    return this.sortedTimeline;
  }

  private dropOrder(): void {
    this.sortedAll = null;
    this.sortedTimeline = null;
  }

  get(id: string): Entry | undefined {
    return this.byId.get(id);
  }

  size(): number {
    return this.byId.size;
  }

  /**
   * Turns whatever the user typed into one entry:
   * `latest`/`last`, `^2` (2nd newest), a full or partial id, or a title match.
   *
   * Positional refs walk the timeline; everything else searches the whole
   * vault, so a memory stays addressable by id or title for `show`, `edit`,
   * and `rm` while never being what "the latest entry" means.
   */
  resolve(ref: string): Entry {
    const query = ref.trim();
    if (!query) throw notFound(ref);
    const all = this.ordered();

    if (query === 'latest' || query === 'last') {
      const first = this.orderedTimeline()[0];
      if (!first) throw notFound(ref);
      return first;
    }
    const nth = /^\^(\d+)$/.exec(query);
    if (nth) {
      const hit = this.orderedTimeline()[Number(nth[1]) - 1];
      if (!hit) throw notFound(ref);
      return hit;
    }
    if (isId(query)) {
      const exact = this.byId.get(query);
      if (exact) return exact;
    }

    // Ids match by prefix or suffix: the prefix is the timestamp, the suffix is
    // the random part shown in listings and used in filenames.
    const lower = query.toLowerCase();
    const idMatches = all.filter((e) => e.id.startsWith(lower) || e.id.endsWith(lower));
    if (idMatches.length === 1) return idMatches[0]!;
    if (idMatches.length > 1) throw ambiguous(ref, idMatches.map((e) => e.id));

    const slug = slugify(query);
    const titleExact = all.filter((e) => slugify(e.title) === slug);
    if (titleExact.length === 1) return titleExact[0]!;
    // This branch used to return the newest of them, which was the last silent
    // guess left in here: two entries called "standup" and you got whichever
    // was written most recently, with nothing said. §5 — ambiguity is an error
    // with the candidates listed — is about what the user typed, not about how
    // well it matched, so a perfect match to two titles is as much a question
    // as a partial match to two is.
    if (titleExact.length > 1) throw ambiguous(ref, titleExact.map(candidate));

    const titlePartial = all.filter((e) => e.title.toLowerCase().includes(lower));
    if (titlePartial.length === 1) return titlePartial[0]!;
    if (titlePartial.length > 1) throw ambiguous(ref, titlePartial.map(candidate));
    throw notFound(ref);
  }

  upsert(entry: Entry, stat?: { mtime: number; size: number }): void {
    const previous = this.byId.get(entry.id);
    if (previous && previous.path !== entry.path) delete this.cache.files[previous.path];
    this.index(entry);
    this.cache.files[entry.path] = {
      mtime: stat?.mtime ?? Date.now(),
      size: stat?.size ?? entry.body.length,
      entry,
    };
    this.dirty = true;
  }

  forget(entry: Entry): void {
    this.byId.delete(entry.id);
    this.dropOrder();
    delete this.cache.files[entry.path];
    this.dirty = true;
  }

  /** Best-effort: a broken cache must never break a command. */
  async persist(): Promise<void> {
    if (!this.dirty) return;
    try {
      await this.storage.write(CACHE_PATH, JSON.stringify(this.cacheable()));
      this.dirty = false;
    } catch {
      /* cache is disposable */
    }
  }

  /**
   * The cache with every file JSON cannot carry left out of it (`survivesJson`).
   *
   * An omitted file is a miss next run and a miss is a change, so a vault
   * holding one rewrites this small file every command. That is the whole
   * price, and it beats remembering which files were dropped — a second record
   * that can be wrong about the first.
   */
  private cacheable(): CacheFile {
    const files: CacheFile['files'] = {};
    for (const [path, hit] of Object.entries(this.cache.files)) {
      if (survivesJson(hit.entry)) files[path] = hit;
    }
    return { version: CACHE_VERSION, files };
  }

  async invalidate(): Promise<void> {
    this.byId.clear();
    this.dropOrder();
    this.cache = { version: CACHE_VERSION, files: {} };
    this.dirty = true;
    await this.storage.remove(CACHE_PATH).catch(() => {});
  }

  /** The single write into `byId`, so it is the single place the order dies. */
  private index(entry: Entry): void {
    this.byId.set(entry.id, entry);
    this.dropOrder();
  }

  private async readCache(): Promise<CacheFile> {
    try {
      const raw = await this.storage.read(CACHE_PATH);
      if (!raw) return { version: CACHE_VERSION, files: {} };
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version !== CACHE_VERSION || !parsed.files) {
        return { version: CACHE_VERSION, files: {} };
      }
      return parsed;
    } catch {
      return { version: CACHE_VERSION, files: {} };
    }
  }
}
