import type { Entry } from './types.js';
import type { Storage } from './ports.js';
import { ENTRIES_DIR, parseEntry } from './entry.js';
import { ambiguous, notFound } from './errors.js';
import { isId } from './util/id.js';
import { slugify } from './util/text.js';

const CACHE_PATH = '.ppr/cache/index.json';
const CACHE_VERSION = 1;

interface CacheFile {
  version: number;
  files: Record<string, { mtime: number; size: number; entry: Entry }>;
}

/**
 * The in-memory view of the vault, backed by an mtime-keyed cache.
 *
 * The markdown files are the source of truth — always. The cache only skips
 * re-parsing files that have not changed, so editing a note in vim, or pulling
 * the vault from git on another machine, is picked up on the next command.
 */
export class Catalog {
  private byId = new Map<string, Entry>();
  private cache: CacheFile = { version: CACHE_VERSION, files: {} };
  private dirty = false;

  constructor(private readonly storage: Storage) {}

  async load(): Promise<this> {
    // Rebuilt from scratch so a reload reflects deletions, not just additions.
    this.byId.clear();
    const cached = await this.readCache();
    const files = await this.storage.list(ENTRIES_DIR);
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

  /**
   * Newest first. Timestamps are second-resolution for readability, so ties
   * break on the id — which carries milliseconds and keeps the order stable.
   */
  entries(): Entry[] {
    return [...this.byId.values()].sort((a, b) =>
      a.created === b.created ? (a.id < b.id ? 1 : -1) : a.created < b.created ? 1 : -1,
    );
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
   */
  resolve(ref: string): Entry {
    const query = ref.trim();
    if (!query) throw notFound(ref);
    const all = this.entries();

    if (query === 'latest' || query === 'last') {
      const first = all[0];
      if (!first) throw notFound(ref);
      return first;
    }
    const nth = /^\^(\d+)$/.exec(query);
    if (nth) {
      const hit = all[Number(nth[1]) - 1];
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
    if (titleExact.length >= 1) return titleExact[0]!;

    const titlePartial = all.filter((e) => e.title.toLowerCase().includes(lower));
    if (titlePartial.length === 1) return titlePartial[0]!;
    if (titlePartial.length > 1) {
      throw ambiguous(
        ref,
        titlePartial.map((e) => `${e.id.slice(0, 8)} ${e.title}`),
      );
    }
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
    delete this.cache.files[entry.path];
    this.dirty = true;
  }

  /** Best-effort: a broken cache must never break a command. */
  async persist(): Promise<void> {
    if (!this.dirty) return;
    try {
      await this.storage.write(CACHE_PATH, JSON.stringify(this.cache));
      this.dirty = false;
    } catch {
      /* cache is disposable */
    }
  }

  async invalidate(): Promise<void> {
    this.byId.clear();
    this.cache = { version: CACHE_VERSION, files: {} };
    this.dirty = true;
    await this.storage.remove(CACHE_PATH).catch(() => {});
  }

  private index(entry: Entry): void {
    this.byId.set(entry.id, entry);
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
