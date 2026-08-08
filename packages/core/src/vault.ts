import type { Clock, AIProvider, Fetcher, Storage, Transcriber, AudioInput } from './ports.js';
import type { Config } from './config.js';
import {
  MEMORY_KIND,
  type Entry,
  type EntryInput,
  type EntryPatch,
  type ListQuery,
  type SearchHit,
  type VaultStats,
} from './types.js';
import { Catalog } from './catalog.js';
import { applyPatch, createEntry, entryPath, serializeEntry, ENTRIES_DIR } from './entry.js';
import { PprError, noAI } from './errors.js';
import { autoLink, backlinks, forwardLinks, graph, related, tagCounts } from './links.js';
import {
  factExtra,
  factTerms,
  FACT_KEYS,
  mentionScore,
  nextOccurrence,
  parseState,
  toFact,
  STATE_PATH,
  type Fact,
  type Occurrence,
  type VaultState,
} from './memory.js';
import { filterEntries, searchEntries } from './search.js';
import { lenses } from './navigate.js';
import { systemClock } from './ports.js';
import { truncate, wordCount } from './util/text.js';
import { formatDay } from './util/time.js';
import { buildClipEntry, buildDumpEntry } from './capture.js';
import * as tasks from './ai/tasks.js';

export interface LearnOptions {
  /** Explicit entries to read. Overrides the incremental window. */
  entries?: Entry[];
  /** Loose text, for the piped path. Read in addition to `entries`. */
  text?: string;
  since?: Date;
  /** Re-read the whole journal, ignoring the high-water mark. */
  all?: boolean;
  signal?: AbortSignal;
}

export interface LearnResult {
  /** Entries read this run. Zero means there was nothing new, not a failure. */
  scanned: number;
  learned: Entry[];
  refined: Entry[];
  /** Pairs that disagree. `ppr memory review` is where they get settled. */
  conflicts: Array<{ fact: Entry; with: Entry }>;
  duplicates: number;
  /** Entries the model returned nothing usable for. They stay in the window. */
  unreadable: number;
}

export interface UpcomingFact extends Occurrence {
  /** Entries that have touched this since it last came round. */
  mentions: Entry[];
}

/** How many known facts a reconcile prompt carries. One-liners are cheap. */
const FACTS_IN_PROMPT = 150;

/** Characters of source text per extraction call. */
const EXTRACT_CHUNK_CHARS = 8000;

const mergeIds = (...lists: string[][]): string[] => [...new Set(lists.flat())].filter(Boolean);

/** Groups entries into prompt-sized batches, keeping each entry whole. */
function chunkEntries(entries: Entry[]): Entry[][] {
  const chunks: Entry[][] = [];
  let current: Entry[] = [];
  let size = 0;
  for (const entry of entries) {
    const length = entry.title.length + entry.body.length;
    if (current.length && size + length > EXTRACT_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

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

  /**
   * Auto-linking happens here and only here, so every kind gets it and no two
   * capture paths can drift (L18). It is deliberately not applied on `update`:
   * a link you removed by hand should stay removed.
   */
  async add(input: EntryInput): Promise<Entry> {
    const body = this.config.capture.autoLink
      ? autoLink(input.body, this.linkVocabulary())
      : input.body;
    const entry = createEntry({ ...input, body }, this.clock.now());
    await this.write(entry);
    return entry;
  }

  /**
   * The names worth linking: everything already written as `[[a link]]`, plus
   * titles short enough to be about a thing rather than an event. A sentence
   * of a title — "Decided to drop redis, memcached is faster" — names no
   * entity, and linking it would be noise.
   */
  private linkVocabulary(): string[] {
    const out = new Set<string>();
    for (const entry of this.catalog.entries()) {
      for (const link of entry.links) out.add(link);
      if (entry.kind !== MEMORY_KIND && entry.title.split(/\s+/).length <= 3) {
        out.add(entry.title.toLowerCase());
      }
    }
    return [...out];
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

  /**
   * What is about to come round, phrased.
   *
   * Which facts are due is arithmetic and already decided by `upcoming()`, so
   * a missing model costs the wording and nothing else (I2).
   */
  async brief(
    opts: { withinDays?: number; signal?: AbortSignal } = {},
  ): Promise<{ text: string; ai: boolean; items: UpcomingFact[] }> {
    const items = this.upcoming(opts.withinDays !== undefined ? { withinDays: opts.withinDays } : {});
    const result = await tasks.brief(
      items.map((item) => ({
        text: item.fact.text,
        days: item.days,
        when: formatDay(item.date),
        ...(item.ordinal ? { ordinal: item.ordinal } : {}),
        mentions: item.mentions.map((e) => e.title),
        related: this.relatedFacts(item.fact).map((f) => f.text),
      })),
      { provider: this.provider, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    return { ...result, items };
  }

  /** Other facts that look like they are about the same subject. */
  private relatedFacts(fact: Fact, limit = 4): Fact[] {
    const others = this.facts().filter((f) => f.id !== fact.id);
    if (!others.length) return [];
    return searchEntries(others.map((f) => f.entry), fact.text, { limit, now: this.clock.now() })
      .map((hit) => toFact(hit.entry));
  }

  /**
   * Retrieval + answer. Retrieval works with no model; the answer needs one.
   *
   * Standing facts go in unconditionally rather than being left to lexical
   * search: "is Emily's birthday soon" shares no word with "Emily's birthday
   * is 20 October" beyond the name, and a memory layer you have to phrase your
   * way into is not one you can rely on. A few hundred one-line facts is a
   * small prompt — that is the whole reason facts are one line.
   */
  async ask(
    question: string,
    opts: { limit?: number; signal?: AbortSignal } & ListQuery = {},
  ): Promise<{ text: string; ai: boolean; cited: string[]; used: Entry[]; facts: Entry[] }> {
    const { limit = 12, signal, ...filters } = opts;
    const hits = this.search(question, { ...filters, limit });
    // Thin retrieval still deserves recent context to reason over.
    const used = hits.length ? hits.map((h) => h.entry) : this.list({ ...filters, limit });
    const facts = this.relevantFacts([question]).map((f) => f.entry);
    const answer = await tasks.ask(question, used, {
      provider: this.provider,
      now: this.clock.now(),
      ...(facts.length ? { facts } : {}),
      ...(signal ? { signal } : {}),
    });
    return { ...answer, used, facts };
  }

  /** A question about what was just written, informed by what is already known. */
  followUps(text: string, opts: { signal?: AbortSignal } = {}) {
    const facts = this.relevantFacts([text]).map((f) => f.entry);
    return tasks.followUps(text, {
      provider: this.provider,
      ...(facts.length ? { facts } : {}),
      ...opts,
    });
  }

  // ----------------------------------------------------------------- memory

  /** Standing facts, newest first. Retired ones are kept but not returned. */
  facts(opts: { includeRetired?: boolean } = {}): Fact[] {
    const all = filterEntries(this.catalog.entries(), { kind: MEMORY_KIND }).map(toFact);
    return opts.includeRetired ? all : all.filter((f) => f.status === 'current');
  }

  /** Every entry a fact was drawn from, for `ppr memory why`. */
  sourcesOf(fact: Fact): Entry[] {
    return fact.from.map((id) => this.catalog.get(id)).filter((e): e is Entry => Boolean(e));
  }

  /**
   * Dated facts falling inside a window, soonest first. No model involved.
   *
   * Each carries what the journal has said about it since it last came round,
   * because "her birthday is in two weeks" and "her birthday is in two weeks
   * and you have not mentioned a present" are different notifications, and
   * only the second is worth being interrupted by.
   */
  upcoming(opts: { withinDays?: number; now?: Date } = {}): UpcomingFact[] {
    const now = opts.now ?? this.clock.now();
    const within = opts.withinDays ?? 30;

    return this.facts()
      .map((fact) => nextOccurrence(fact, now))
      .filter((o): o is Occurrence => Boolean(o) && o!.days <= within)
      .sort((a, b) => a.days - b.days)
      .map((occurrence) => ({ ...occurrence, mentions: this.mentionsSince(occurrence) }));
  }

  /**
   * Entries touching this fact since it last came round.
   *
   * Deliberately not ranked search: a brief that claims you have been thinking
   * about someone's birthday because an unrelated note shared a common word is
   * worse than one that says nothing. Two distinctive words, or one for a fact
   * that only has one to give.
   */
  private mentionsSince(occurrence: Occurrence): Entry[] {
    const since = new Date(occurrence.date);
    since.setFullYear(since.getFullYear() - (occurrence.fact.recurs === 'yearly' ? 1 : 5));
    const needed = Math.min(2, factTerms(occurrence.fact.text).length);
    if (!needed) return [];

    return filterEntries(this.catalog.timeline(), { since })
      .filter((entry) => !occurrence.fact.from.includes(entry.id))
      .map((entry) => ({ entry, score: mentionScore(`${entry.title} ${entry.body}`, occurrence.fact) }))
      .filter((hit) => hit.score >= needed)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((hit) => hit.entry);
  }

  /**
   * Facts that disagree, as unique pairs.
   *
   * Learning records these and settles none of them, so this is the queue
   * `ppr memory review` works through. A pair with a missing side is dropped
   * rather than reported: deleting one of two conflicting facts *is* an answer.
   */
  conflicts(): Array<[Fact, Fact]> {
    const byId = new Map(this.facts({ includeRetired: true }).map((f) => [f.id, f]));
    const seen = new Set<string>();
    const pairs: Array<[Fact, Fact]> = [];

    for (const fact of byId.values()) {
      if (fact.status !== 'current') continue;
      for (const otherId of fact.conflicts) {
        const other = byId.get(otherId);
        if (!other || other.status !== 'current') continue;
        const key = [fact.id, other.id].sort().join(':');
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([fact, other]);
      }
    }
    return pairs;
  }

  /**
   * Settles a disagreement by keeping one side.
   *
   * The loser is retired, not deleted: it stays on disk, in git, and in
   * `ppr memory ls --all`, because "we used to think her birthday was the
   * 22nd" is sometimes the thing you need to see.
   */
  async keepFact(keepId: string, dropId: string): Promise<{ kept: Entry; retired: Entry }> {
    const keep = toFact(this.catalog.resolve(keepId));
    const drop = toFact(this.catalog.resolve(dropId));

    const retired = await this.update(
      drop.id,
      this.factPatch({
        ...drop,
        status: 'retired',
        supersededBy: keep.id,
        conflicts: drop.conflicts.filter((id) => id !== keep.id),
      }),
    );
    const kept = await this.update(
      keep.id,
      this.factPatch({ ...keep, conflicts: keep.conflicts.filter((id) => id !== drop.id) }),
    );
    return { kept, retired };
  }

  /** Both are true after all. Unlinks the pair and leaves them alone. */
  async keepBoth(aId: string, bId: string): Promise<[Entry, Entry]> {
    const a = toFact(this.catalog.resolve(aId));
    const b = toFact(this.catalog.resolve(bId));
    return [
      await this.update(a.id, this.factPatch({ ...a, conflicts: a.conflicts.filter((id) => id !== b.id) })),
      await this.update(b.id, this.factPatch({ ...b, conflicts: b.conflicts.filter((id) => id !== a.id) })),
    ];
  }

  /** Records a fact the user wrote themselves. Nothing automatic rewrites it. */
  async addFact(text: string): Promise<Entry> {
    const line = text.trim();
    if (!line) throw new PprError('EINVALID', 'Nothing to remember');
    return this.add({ body: line, kind: MEMORY_KIND, title: truncate(line, 70), source: 'manual' });
  }

  /**
   * Reads entries and folds what they say into the fact store.
   *
   * Incremental by default: everything written since the last run, so this is
   * the command a cron job invokes. The high-water mark is a convenience —
   * `--since` and `--all` override it, and losing it costs a re-scan rather
   * than correctness, because reconciliation absorbs the repeats.
   */
  async learn(opts: LearnOptions = {}): Promise<LearnResult> {
    if (!this.provider) throw noAI();
    const signal = opts.signal ? { signal: opts.signal } : {};

    const sources = await this.learnSources(opts);
    const result: LearnResult = {
      scanned: sources.length,
      learned: [],
      refined: [],
      conflicts: [],
      duplicates: 0,
      unreadable: 0,
    };
    if (!sources.length && !opts.text) return result;

    const candidates: tasks.FactCandidate[] = [];
    // Only entries the model actually understood may advance the mark. A
    // garbled reply looks exactly like "nothing durable here", and treating it
    // as such would drop those entries out of the window for good — the one
    // way an incremental learner can quietly lose your words.
    const read: Entry[] = [];
    let stalled = false;
    for (const chunk of chunkEntries(sources)) {
      const batch = await tasks.extractFacts(
        chunk.map((e) => ({ id: e.id, text: `${e.title}\n${e.body}` })),
        { provider: this.provider, ...this.linkOption(), ...signal },
      );
      if (!batch.ok) {
        result.unreadable += chunk.length;
        stalled = true;
        continue;
      }
      candidates.push(...batch.facts);
      if (!stalled) read.push(...chunk);
    }
    if (opts.text?.trim()) {
      const batch = await tasks.extractFacts([{ text: opts.text }], {
        provider: this.provider,
        ...this.linkOption(),
        ...signal,
      });
      candidates.push(...batch.facts);
    }
    if (!candidates.length) {
      await this.markLearned(read);
      return result;
    }

    // Reconcile against what is already known, so a second run over the same
    // week does not double the store. Only the facts a candidate could
    // plausibly be about are sent: a few hundred one-liners is a small prompt,
    // but a vault that has been running for a year is not.
    const known = this.relevantFacts(candidates.map((c) => c.text));
    const verdicts = await tasks.reconcileFacts(
      candidates.map((c) => c.text),
      known.map((f) => ({ id: f.id, text: f.text })),
      { provider: this.provider, ...signal },
    );

    for (const [i, candidate] of candidates.entries()) {
      const verdict = verdicts[i] ?? { verdict: 'new' as const };
      const target = verdict.verdict === 'new' ? undefined : this.catalog.get(verdict.of);

      if (!target || verdict.verdict === 'new') {
        result.learned.push(await this.writeFact(candidate));
        continue;
      }
      if (verdict.verdict === 'duplicate') {
        result.duplicates++;
        // The fact was said again, which is worth recording even when the
        // wording adds nothing: provenance is what `why` has to answer with.
        await this.addSources(target, candidate.from);
        continue;
      }
      if (verdict.verdict === 'refines') {
        const fact = toFact(target);
        // A person's own words are not the model's to improve on.
        if (fact.origin === 'manual') {
          result.learned.push(await this.writeFact(candidate));
          continue;
        }
        result.refined.push(
          await this.update(target.id, {
            body: verdict.text,
            title: truncate(verdict.text, 70),
            // `extra` merges, so a date the refinement did not mention is kept
            // rather than dropped — a better wording must not lose structure.
            // Spread the existing fact first: a better wording must not drop
            // a date or a provenance trail it simply did not mention.
            ...this.factPatch({
              ...fact,
              from: mergeIds(fact.from, candidate.from),
              ...(candidate.date ? { date: candidate.date, ...(candidate.recurs ? { recurs: candidate.recurs } : {}) } : {}),
            }),
          }),
        );
        continue;
      }
      // Contradiction: keep both, flag the pair, decide nothing.
      const added = await this.writeFact(candidate, { conflicts: [target.id] });
      const marked = await this.update(
        target.id,
        this.factPatch({ ...toFact(target), conflicts: mergeIds(toFact(target).conflicts, [added.id]) }),
      );
      result.conflicts.push({ fact: added, with: marked });
    }

    await this.markLearned(read);
    return result;
  }

  /** Pulls durable facts out of loose text — the piped path into `learn`. */
  async remember(text: string, opts: { signal?: AbortSignal } = {}): Promise<Entry[]> {
    const result = await this.learn({ text, entries: [], ...opts });
    return [...result.learned, ...result.refined];
  }

  private async writeFact(
    candidate: tasks.FactCandidate,
    fields: { conflicts?: string[] } = {},
  ): Promise<Entry> {
    return this.add({
      body: candidate.text,
      kind: MEMORY_KIND,
      title: truncate(candidate.text, 70),
      source: 'learned',
      extra: factExtra({
        from: candidate.from,
        ...(candidate.date ? { date: candidate.date } : {}),
        ...(candidate.recurs ? { recurs: candidate.recurs } : {}),
        ...fields,
      }),
    });
  }

  /**
   * A patch that makes the memory fields say exactly what is passed, rather
   * than merging over what was there. Without this, clearing a settled
   * conflict would leave the old pointer behind.
   */
  private factPatch(fields: Parameters<typeof factExtra>[0]): EntryPatch {
    const cleared: Record<string, unknown> = {};
    for (const key of FACT_KEYS) cleared[key] = undefined;
    return { extra: { ...cleared, ...factExtra(fields) } };
  }

  private linkOption(): { link?: true } {
    return this.config.capture.autoLink ? { link: true } : {};
  }

  private async addSources(entry: Entry, from: string[]): Promise<Entry> {
    const fact = toFact(entry);
    const merged = mergeIds(fact.from, from);
    if (merged.length === fact.from.length) return entry;
    return this.update(entry.id, this.factPatch({ ...fact, from: merged }));
  }

  /** Which entries this run should read, oldest first. */
  private async learnSources(opts: LearnOptions): Promise<Entry[]> {
    if (opts.entries) return opts.entries.filter((e) => e.kind !== MEMORY_KIND);
    const timeline = this.catalog.timeline();
    if (opts.since) return filterEntries(timeline, { since: opts.since, order: 'asc' });
    if (opts.all) return filterEntries(timeline, { order: 'asc' });

    const mark = (await this.readState()).learnedThrough;
    return filterEntries(mark ? timeline.filter((e) => e.id > mark) : timeline, { order: 'asc' });
  }

  /**
   * The known facts worth showing the model. All of them while the store is
   * small — that is the whole point of one-line facts — and the best matches
   * once it is not.
   */
  private relevantFacts(candidates: string[]): Fact[] {
    const all = this.facts();
    if (all.length <= FACTS_IN_PROMPT) return all;
    const entries = all.map((f) => f.entry);
    const picked = new Map<string, Entry>();
    const perCandidate = Math.max(3, Math.floor(FACTS_IN_PROMPT / Math.max(candidates.length, 1)));
    for (const text of candidates) {
      for (const hit of searchEntries(entries, text, { limit: perCandidate, now: this.clock.now() })) {
        picked.set(hit.entry.id, hit.entry);
      }
    }
    return [...picked.values()].slice(0, FACTS_IN_PROMPT).map(toFact);
  }

  private async readState(): Promise<VaultState> {
    return parseState(await this.storage.read(STATE_PATH));
  }

  /** Advances the high-water mark past everything this run read. */
  private async markLearned(sources: Entry[]): Promise<void> {
    if (!sources.length) return;
    const newest = sources.reduce((max, e) => (e.id > max ? e.id : max), sources[0]!.id);
    const state = await this.readState();
    if (state.learnedThrough && state.learnedThrough >= newest) return;
    await this.storage
      .write(STATE_PATH, `${JSON.stringify({ ...state, learnedThrough: newest }, null, 2)}\n`)
      .catch(() => {
        /* a lost marker costs a re-scan, never a fact */
      });
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
    await this.relocateFacts();
    await this.catalog.persist();
    return this.catalog.size();
  }

  /**
   * Moves facts written before `memory/` existed out of the journal tree.
   *
   * Deliberately narrow: only `kind: memory` files still sitting under
   * `entries/`. A hand-made file anywhere else is where its author put it, and
   * "it is just markdown" would mean very little if ppr tidied the tree.
   */
  private async relocateFacts(): Promise<Entry[]> {
    const moved: Entry[] = [];
    for (const entry of this.catalog.entries()) {
      if (entry.kind !== MEMORY_KIND || !entry.path.startsWith(`${ENTRIES_DIR}/`)) continue;
      const next = { ...entry, path: entryPath(entry) };
      await this.storage.write(next.path, serializeEntry(next));
      await this.storage.remove(entry.path).catch(() => {});
      this.catalog.forget(entry);
      this.catalog.upsert(next, (await this.storage.stat(next.path)) ?? undefined);
      moved.push(next);
    }
    return moved;
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
