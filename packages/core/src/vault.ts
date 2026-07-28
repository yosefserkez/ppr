import type { Clock, AIProvider, Fetcher, Storage, Transcriber, AudioInput } from './ports.js';
import type { Config } from './config.js';
import type { Entry, EntryInput, EntryPatch, ListQuery, SearchHit, VaultStats } from './types.js';
import { Catalog } from './catalog.js';
import { applyPatch, createEntry, serializeEntry } from './entry.js';
import { PprError, noAI } from './errors.js';
import { backlinks, forwardLinks, graph, related, tagCounts } from './links.js';
import { filterEntries, searchEntries } from './search.js';
import { lenses } from './navigate.js';
import { systemClock } from './ports.js';
import { wordCount } from './util/text.js';
import { buildClipEntry, buildDumpEntry } from './capture.js';
import * as tasks from './ai/tasks.js';

export interface VaultOptions {
  /** Human-readable location, for messages only. Storage is already scoped to it. */
  root: string;
  storage: Storage;
  config: Config;
  clock?: Clock;
  provider?: AIProvider | undefined;
  transcriber?: Transcriber | undefined;
  fetcher?: Fetcher;
}

/**
 * The single API every ppr front-end talks to.
 *
 * A mobile or web client supplies its own Storage and provider and gets the
 * identical behaviour — that is the whole point of keeping this class free of
 * platform imports.
 */
export class Vault {
  readonly root: string;
  readonly config: Config;
  readonly provider: AIProvider | undefined;
  private readonly storage: Storage;
  private readonly clock: Clock;
  private readonly transcriber: Transcriber | undefined;
  private readonly fetcher: Fetcher | undefined;
  private readonly catalog: Catalog;

  private constructor(opts: VaultOptions, catalog: Catalog) {
    this.root = opts.root;
    this.storage = opts.storage;
    this.config = opts.config;
    this.clock = opts.clock ?? systemClock;
    this.provider = opts.provider;
    this.transcriber = opts.transcriber;
    this.fetcher = opts.fetcher;
    this.catalog = catalog;
  }

  static async open(opts: VaultOptions): Promise<Vault> {
    const catalog = await new Catalog(opts.storage).load();
    return new Vault(opts, catalog);
  }

  get hasAI(): boolean {
    return Boolean(this.provider);
  }

  now(): Date {
    return this.clock.now();
  }

  // ---------------------------------------------------------------- entries

  async add(input: EntryInput): Promise<Entry> {
    const entry = createEntry(input, this.clock.now());
    await this.write(entry);
    return entry;
  }

  get(ref: string): Entry {
    return this.catalog.resolve(ref);
  }

  find(id: string): Entry | undefined {
    return this.catalog.get(id);
  }

  async update(ref: string, patch: EntryPatch): Promise<Entry> {
    const current = this.catalog.resolve(ref);
    const next = applyPatch(current, patch, this.clock.now());
    if (next.path !== current.path) await this.storage.remove(current.path).catch(() => {});
    await this.write(next);
    return next;
  }

  async remove(ref: string): Promise<Entry> {
    const entry = this.catalog.resolve(ref);
    await this.storage.remove(entry.path);
    this.catalog.forget(entry);
    return entry;
  }

  /** Appends to an existing entry — the cheapest way to keep a thread going. */
  async append(ref: string, text: string): Promise<Entry> {
    const entry = this.catalog.resolve(ref);
    return this.update(ref, { body: `${entry.body}\n\n${text.trim()}` });
  }

  list(query: ListQuery = {}): Entry[] {
    return filterEntries(this.catalog.entries(), query);
  }

  all(): Entry[] {
    return this.catalog.entries();
  }

  search(query: string, opts: { limit?: number } & ListQuery = {}): SearchHit[] {
    const { limit, ...filters } = opts;
    const scope = filterEntries(this.catalog.entries(), filters);
    return searchEntries(scope, query, { ...(limit ? { limit } : {}), now: this.clock.now() });
  }

  // ------------------------------------------------------------------ graph

  tags() {
    return tagCounts(this.catalog.entries());
  }

  related(entry: Entry, limit?: number) {
    return related(this.catalog.entries(), entry, limit);
  }

  backlinks(entry: Entry) {
    return backlinks(this.catalog.entries(), entry);
  }

  forwardLinks(entry: Entry) {
    return forwardLinks(this.catalog.entries(), entry);
  }

  graph() {
    return graph(this.catalog.entries());
  }

  stats(): VaultStats {
    const entries = this.catalog.entries();
    const byKind: Record<string, number> = {};
    let words = 0;
    let links = 0;
    const tags = new Set<string>();
    for (const e of entries) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      words += wordCount(e.body);
      links += e.links.length;
      for (const t of e.tags) tags.add(t);
    }
    const out: VaultStats = { entries: entries.length, byKind, tags: tags.size, links, words };
    const last = entries[0];
    const first = entries[entries.length - 1];
    if (first) out.firstEntry = first.created;
    if (last) out.lastEntry = last.created;
    return out;
  }

  // --------------------------------------------------------------------- ai

  /** Raw text (typed, piped, or transcribed) -> a clean entry. */
  async dump(
    text: string,
    opts: { kind?: string; distill?: boolean; keepRaw?: boolean; tags?: string[]; source?: string; signal?: AbortSignal } = {},
  ): Promise<Entry> {
    const input = await buildDumpEntry(text, {
      config: this.config,
      provider: this.provider,
      knownTags: this.tags().slice(0, 40).map((t) => t.tag),
      ...(this.fetcher ? { fetcher: this.fetcher } : {}),
      ...opts,
    });
    if (opts.tags?.length) input.tags = [...(input.tags ?? []), ...opts.tags];
    if (opts.source) input.source = opts.source;
    return this.add(input);
  }

  async clip(url: string, opts: { tags?: string[]; signal?: AbortSignal } = {}): Promise<Entry> {
    const input = await buildClipEntry(url, {
      config: this.config,
      provider: this.provider,
      ...(this.fetcher ? { fetcher: this.fetcher } : {}),
      ...opts,
    });
    if (opts.tags?.length) input.tags = [...(input.tags ?? []), ...opts.tags];
    return this.add(input);
  }

  async transcribe(audio: AudioInput, opts: { signal?: AbortSignal } = {}): Promise<string> {
    if (!this.transcriber) {
      throw new PprError(
        'ECONFIG',
        'No transcriber configured',
        'Run `ppr ai setup` and pick a transcription backend (whisper.cpp is local).',
      );
    }
    return this.transcriber.transcribe(audio, opts);
  }

  recap(entries: Entry[], opts: { style?: tasks.RecapStyle; signal?: AbortSignal } = {}) {
    return tasks.recap(entries, { provider: this.provider, ...opts });
  }

  /** Retrieval + answer. Retrieval works with no model; the answer needs one. */
  async ask(
    question: string,
    opts: { limit?: number; signal?: AbortSignal } & ListQuery = {},
  ): Promise<{ text: string; ai: boolean; cited: string[]; used: Entry[] }> {
    const { limit = 12, signal, ...filters } = opts;
    const hits = this.search(question, { ...filters, limit });
    // Thin retrieval still deserves recent context to reason over.
    const used = hits.length ? hits.map((h) => h.entry) : this.list({ ...filters, limit });
    const answer = await tasks.ask(question, used, {
      provider: this.provider,
      ...(signal ? { signal } : {}),
    });
    return { ...answer, used };
  }

  followUps(text: string, opts: { signal?: AbortSignal } = {}) {
    return tasks.followUps(text, { provider: this.provider, ...opts });
  }

  /** Pulls durable facts out of text and stores each as a `memory` entry. */
  async remember(text: string, opts: { signal?: AbortSignal } = {}): Promise<Entry[]> {
    if (!this.provider) throw noAI();
    const facts = await tasks.extractMemories(text, { provider: this.provider, ...opts });
    const existing = new Set(
      this.list({ kind: 'memory' }).map((e) => e.body.trim().toLowerCase()),
    );
    const out: Entry[] = [];
    for (const fact of facts) {
      if (existing.has(fact.toLowerCase())) continue;
      out.push(await this.add({ body: fact, kind: 'memory', title: fact }));
    }
    return out;
  }

  // ------------------------------------------------------------ maintenance

  /**
   * Re-reads the vault from storage. Cheap — unchanged files come from the
   * cache. Interactive views call this after an editor exits, or on demand.
   */
  async refresh(): Promise<void> {
    await this.catalog.load();
  }

  /** Every way to move on from this entry, best first. */
  lenses(entry: Entry) {
    return lenses(this.catalog.entries(), entry);
  }

  async reindex(): Promise<number> {
    await this.catalog.invalidate();
    await this.catalog.load();
    await this.catalog.persist();
    return this.catalog.size();
  }

  /** Flushes the parse cache. Safe to skip; the cache is disposable. */
  async close(): Promise<void> {
    await this.catalog.persist();
  }

  private async write(entry: Entry): Promise<void> {
    await this.storage.write(entry.path, serializeEntry(entry));
    const stat = await this.storage.stat(entry.path);
    this.catalog.upsert(entry, stat ?? undefined);
  }
}
