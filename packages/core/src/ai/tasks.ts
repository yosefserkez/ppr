import type { AIProvider } from '../ports.js';
import type { Entry } from '../types.js';
import { PprError } from '../errors.js';
import { plainText, truncate } from '../util/text.js';
import { shortId } from '../util/id.js';
import { formatDay } from '../util/time.js';
import { asStringList, parseJsonLoose } from './json.js';
import { GENERIC_FOLLOWUPS, heuristicDistill, heuristicRecap } from './fallback.js';

/**
 * Every task takes an optional provider. When it is absent — or when the model
 * misbehaves — the offline path runs instead. No command ever hard-fails
 * because the AI was unavailable; that is what "local-first" has to mean.
 */
export interface TaskOptions {
  provider?: AIProvider | undefined;
  signal?: AbortSignal;
}

const VOICE = `You are the user's own note-taking system. You never add commentary,
never address the user, and never invent facts. You preserve their voice, their
technical terms, and their conclusions exactly as given.`;

export interface Distilled {
  title: string;
  body: string;
  tags: string[];
  /** True when a model produced this, false when the offline path did. */
  ai: boolean;
}

const DISTILL_SYSTEM = `${VOICE}

Rewrite a raw brain dump as a clean note.

Rules:
- Keep every fact, name, number, decision, and open question. Losing content is the only unacceptable outcome.
- Cut filler, false starts, repetition, and transcription noise.
- Use short paragraphs, or bullets when the dump lists several things.
- Keep the user's first person. Do not summarise them in the third person.
- Do not add conclusions, encouragement, or anything not in the source.
- Markdown only. No headings. No preamble.

Return JSON: {"title": string, "body": string, "tags": string[]}
- title: under 70 characters, specific, no trailing period.
- tags: lowercase single words or slash/paths, only genuinely recurring themes. Fewer is better.`;

export async function distill(
  text: string,
  opts: TaskOptions & { maxTags?: number; context?: string } = {},
): Promise<Distilled> {
  const source = text.trim();
  if (!source) throw new PprError('EINVALID', 'Nothing to distill');
  const maxTags = opts.maxTags ?? 5;

  if (!opts.provider) return { ...heuristicDistill(source, { maxTags }), ai: false };

  const prompt = [
    opts.context ? `Existing tags in this vault (reuse when they fit): ${opts.context}` : '',
    'Raw dump:',
    '"""',
    source,
    '"""',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await opts.provider.generate({
    system: DISTILL_SYSTEM,
    prompt,
    json: true,
    maxTokens: Math.min(4096, Math.max(512, Math.ceil(source.length / 2))),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const parsed = parseJsonLoose<{ title?: string; body?: string; tags?: unknown }>(raw);
  const body = parsed?.body?.trim();
  // A model that returns nothing usable must not cost the user their dump.
  if (!body) return { ...heuristicDistill(source, { maxTags }), ai: false };

  return {
    title: (parsed?.title ?? '').trim() || heuristicDistill(source).title,
    body,
    tags: asStringList(parsed?.tags, maxTags),
    ai: true,
  };
}

const CLIP_SYSTEM = `${VOICE}

Summarise a saved web page for the user's own reference.

Rules:
- Lead with what the page actually says, not what it is about.
- Keep concrete specifics: numbers, names, APIs, claims, prices, dates.
- 3 to 8 bullets, or short paragraphs if the page is an argument.
- No marketing language. No "this article discusses".
- Markdown only.

Return JSON: {"title": string, "body": string, "tags": string[]}`;

export async function summarizePage(
  page: { url: string; title: string; text: string },
  opts: TaskOptions & { maxTags?: number; maxChars?: number } = {},
): Promise<Distilled> {
  const maxTags = opts.maxTags ?? 5;
  const clipped = truncate(page.text, opts.maxChars ?? 24_000, '\n\n[truncated]');

  if (!opts.provider) {
    return {
      title: page.title || page.url,
      body: truncate(page.text, 1200),
      tags: [],
      ai: false,
    };
  }

  const raw = await opts.provider.generate({
    system: CLIP_SYSTEM,
    prompt: `URL: ${page.url}\nPage title: ${page.title}\n\n"""\n${clipped}\n"""`,
    json: true,
    maxTokens: 1500,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const parsed = parseJsonLoose<{ title?: string; body?: string; tags?: unknown }>(raw);
  if (!parsed?.body?.trim()) {
    return { title: page.title || page.url, body: truncate(page.text, 1200), tags: [], ai: false };
  }
  return {
    title: (parsed.title ?? '').trim() || page.title || page.url,
    body: parsed.body.trim(),
    tags: asStringList(parsed.tags, maxTags),
    ai: true,
  };
}

const RECAP_STYLES = {
  standup: 'A standup update. What moved, what is blocked, what is next. Terse. Bullets only.',
  weekly: 'A weekly review. Themes, decisions made, what changed, what is still open.',
  narrative: 'A short narrative of the period, in the user\'s own voice. Two or three paragraphs.',
} as const;

export type RecapStyle = keyof typeof RECAP_STYLES;

export async function recap(
  entries: Entry[],
  opts: TaskOptions & { style?: RecapStyle } = {},
): Promise<{ text: string; ai: boolean }> {
  if (!entries.length) return { text: 'Nothing logged in this window.', ai: false };
  if (!opts.provider) return { text: heuristicRecap(entries), ai: false };

  const style = RECAP_STYLES[opts.style ?? 'standup'];
  const text = await opts.provider.generate({
    system: `${VOICE}\n\nWrite from journal entries only. Every claim must come from an entry.
Never pad. If a day is thin, say less.\n\nStyle: ${style}`,
    prompt: `Entries, oldest first:\n\n${transcript(entries)}`,
    maxTokens: 1200,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return text.trim() ? { text: text.trim(), ai: true } : { text: heuristicRecap(entries), ai: false };
}

const ASK_SYSTEM = `${VOICE}

Answer a question using only what is given below: the user's standing facts,
and their journal entries.

Rules:
- Cite the entries and facts you used as [id] right after the claim they support.
- Facts are current. When an entry and a fact disagree, the fact wins — it is
  what the user has settled on since.
- If neither answers it, say so in one line. Do not guess.
- Quote the user's own words when they said it better than a paraphrase would.
- Be brief. This is a lookup, not an essay.`;

/** Facts rendered for a model: id-tagged, so an answer can cite one. */
const factBlock = (facts: Entry[]): string =>
  facts.map((f) => `[${f.id}] ${f.body.split('\n')[0]}`).join('\n');

export async function ask(
  question: string,
  entries: Entry[],
  opts: TaskOptions & { facts?: Entry[]; now?: Date } = {},
): Promise<{ text: string; ai: boolean; cited: string[] }> {
  const facts = opts.facts ?? [];

  if (!opts.provider) {
    const lines = [
      facts.length ? `What ppr knows:\n\n${facts.map((f) => `- [${shortId(f.id)}] ${f.body.split('\n')[0]}`).join('\n')}` : '',
      entries.length
        ? `Closest entries:\n\n${entries.map((e) => `- [${shortId(e.id)}] ${e.title}`).join('\n')}`
        : '',
    ].filter(Boolean);
    return {
      text: lines.length ? `No model configured.\n\n${lines.join('\n\n')}` : 'Nothing matching.',
      ai: false,
      cited: [...facts, ...entries].map((e) => e.id),
    };
  }

  const text = await opts.provider.generate({
    system: ASK_SYSTEM,
    prompt: [
      // "Is anything coming up?" is unanswerable without it, and a model that
      // does not know the date will invent one rather than say so.
      opts.now ? `Today is ${formatDay(opts.now)} ${opts.now.getFullYear()}.` : '',
      `Question: ${question}`,
      facts.length ? `\nStanding facts:\n${factBlock(facts)}` : '',
      `\nEntries:\n\n${transcript(entries, 2400)}`,
    ]
      .filter(Boolean)
      .join('\n'),
    maxTokens: 900,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const cited = [...new Set([...text.matchAll(/\[([0-9a-z]{6,16})\]/g)].map((m) => m[1]!))];
  return { text: text.trim(), ai: true, cited };
}

const FOLLOWUP_SYSTEM = `${VOICE}

The user just logged something. Ask what a sharp colleague would ask to surface
the reasoning they left out — the tradeoff, the doubt, the thing they assumed.

Rules:
- 1 to 3 questions, one line each.
- Specific to what they wrote. Never generic.
- Never ask what the entry already answers, or what the known facts already say.
- A known fact that bears on this is worth asking *about*: connect it, do not
  repeat it back.

Return JSON: {"questions": string[]}`;

export async function followUps(
  text: string,
  opts: TaskOptions & { facts?: Entry[] } = {},
): Promise<string[]> {
  if (!opts.provider) return GENERIC_FOLLOWUPS.slice(0, 1);
  const facts = opts.facts ?? [];
  const raw = await opts.provider.generate({
    system: FOLLOWUP_SYSTEM,
    prompt: facts.length ? `Known facts:\n${factBlock(facts)}\n\nJust written:\n${text}` : text,
    json: true,
    maxTokens: 300,
    temperature: 0.5,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const parsed = parseJsonLoose<{ questions?: unknown }>(raw);
  const questions = Array.isArray(parsed?.questions)
    ? parsed.questions.map(String).map((q) => q.trim()).filter(Boolean)
    : [];
  return questions.length ? questions.slice(0, 3) : GENERIC_FOLLOWUPS.slice(0, 1);
}

const MEMORY_SYSTEM = `${VOICE}

Pull out the durable facts — things that will still be true and useful in six
months. People and how they relate to the user, preferences, decisions,
commitments, dates that repeat, stable context about projects and tools.

Rules:
- Split compound sentences. "My girlfriend Emily's birthday is 20 October and
  she likes chocolate" is three facts: who Emily is, when her birthday is, and
  what she likes. One idea per fact, always.
- Every fact must stand on its own, read cold, a year from now. Name the
  subject in each one — never "she", "it", "that project".
- Refer to the writer as "the user". "My sister" becomes "the user's sister".
- Keep names, numbers, and dates exactly as given. Never round or infer a year.
- Skip anything transient: today's mood, current status, work in progress,
  anything that is only true this week.
- If there is genuinely nothing durable, return an empty list. That is a valid
  answer, and a better one than a vague fact.

Return JSON: {"memories": [{"fact": string, "from": string[]}]}
- fact: one sentence, the fact itself and nothing else.
- from: the ids of the sources it came from, copied exactly from their headings.`;

/** One source of text to mine for facts. `id` is an entry id when there is one. */
export interface FactSource {
  id?: string;
  text: string;
}

export interface FactCandidate {
  text: string;
  /** Entry ids this fact came from. Empty when the text was piped in. */
  from: string[];
}

export interface FactBatch {
  facts: FactCandidate[];
  /**
   * Whether the model was understood at all.
   *
   * "These entries hold nothing durable" and "the model returned junk" both
   * produce no facts, and the caller must not confuse them: the first means
   * the entries are done with, the second means they still need reading.
   */
  ok: boolean;
}

/**
 * Pulls candidate facts out of a batch of entries.
 *
 * Sources are labelled so the model can say which entry each fact came from,
 * and the attribution is checked against the batch rather than trusted: a made
 * up id would put a fact's provenance somewhere it never appeared, and
 * `ppr memory why` exists precisely so that link can be relied on.
 */
export async function extractFacts(
  sources: FactSource[],
  opts: TaskOptions & { max?: number } = {},
): Promise<FactBatch> {
  const batch = sources.filter((s) => s.text.trim());
  if (!batch.length) return { facts: [], ok: true };
  if (!opts.provider) return { facts: [], ok: false };
  const ids = batch.map((s) => s.id).filter((id): id is string => Boolean(id));

  const labelled = batch
    .map((s, i) => `[${s.id ?? `source-${i + 1}`}]\n${s.text.trim()}`)
    .join('\n\n---\n\n');

  const raw = await opts.provider.generate({
    system: MEMORY_SYSTEM,
    prompt: `Sources, each headed by its id:\n\n${labelled}`,
    json: true,
    maxTokens: 1200,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const parsed = parseJsonLoose<{ memories?: unknown }>(raw);
  if (!Array.isArray(parsed?.memories)) return { facts: [], ok: false };

  const facts: FactCandidate[] = [];
  for (const item of parsed.memories.slice(0, opts.max ?? 20)) {
    const text = typeof item === 'string' ? item.trim() : String((item as { fact?: unknown })?.fact ?? '').trim();
    // A half-parsed response yields shards of the schema rather than sentences.
    // They read as facts and would be stored as facts, so drop them.
    if (text.length < 8 || /^["'{[]|["{[]$/.test(text)) continue;
    const claimed = asStringList((item as { from?: unknown })?.from, 5).map((s) => s.trim());
    // An unrecognised id is not provenance. Fall back to the whole batch,
    // which is true — the fact did come from somewhere in it.
    const from = claimed.filter((id) => ids.includes(id));
    facts.push({ text, from: from.length ? from : ids });
  }
  return { facts, ok: true };
}

/**
 * What to do with a candidate fact given what is already known.
 *
 * `contradicts` never resolves itself. A cron job may not overwrite something
 * you told it, and it may not quietly keep two facts that disagree either —
 * so it records both and leaves the choice to `ppr memory review` (L17).
 */
export type FactVerdict =
  | { verdict: 'new' }
  | { verdict: 'duplicate'; of: string }
  | { verdict: 'refines'; of: string; text: string }
  | { verdict: 'contradicts'; of: string };

const RECONCILE_SYSTEM = `${VOICE}

Decide how each candidate fact relates to the facts already known.

For each candidate, exactly one verdict:
- "new" — nothing known covers this.
- "duplicate" — a known fact already says this, even in different words. Give its id.
- "refines" — a known fact says this less precisely, and the candidate is a
  strictly better version of the same fact. Give its id and the text to keep.
  Only when the two are about the same subject and the same property.
- "contradicts" — a known fact says something incompatible: a different date,
  a reversed decision, an opposite preference. Give its id.

Rules:
- A fact about a different person, project, or property is "new", never a
  refinement. When two facts can both be true at once, they do not contradict.
- When unsure between "refines" and "new", answer "new". Losing a fact is worse
  than keeping two.

Return JSON: {"verdicts": [{"i": number, "verdict": string, "of": string, "text": string}]}
- i is the candidate's number. Omit "of" and "text" when they do not apply.`;

/**
 * One verdict per candidate, index-aligned.
 *
 * With no model — or a model that returns nonsense — this degrades to exact
 * text matching, which is weak but never wrong in a way that loses a fact (I2).
 */
export async function reconcileFacts(
  candidates: string[],
  known: Array<{ id: string; text: string }>,
  opts: TaskOptions = {},
): Promise<FactVerdict[]> {
  if (!candidates.length) return [];

  // Exact repeats are caught with no model involved, always. This is the floor
  // the model builds on rather than an alternative to it: a provider that
  // returns an empty list, or nonsense, must not be able to double the store.
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
  const out: FactVerdict[] = candidates.map((text) => {
    const hit = known.find((k) => norm(k.text) === norm(text));
    return hit ? { verdict: 'duplicate' as const, of: hit.id } : { verdict: 'new' as const };
  });

  if (!opts.provider || !known.length) return out;

  const raw = await opts.provider.generate({
    system: RECONCILE_SYSTEM,
    prompt: [
      'Known facts:',
      known.map((k) => `[${k.id}] ${k.text}`).join('\n'),
      '',
      'Candidates:',
      candidates.map((c, i) => `${i + 1}. ${c}`).join('\n'),
    ].join('\n'),
    json: true,
    maxTokens: 900,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const parsed = parseJsonLoose<{ verdicts?: unknown }>(raw);
  if (!Array.isArray(parsed?.verdicts)) return out;

  const byId = new Map(known.map((k) => [k.id, k]));
  for (const item of parsed.verdicts) {
    const row = item as { i?: unknown; verdict?: unknown; of?: unknown; text?: unknown };
    const index = Number(row.i) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue;
    const of = typeof row.of === 'string' ? row.of.trim() : '';
    // A verdict that points at a fact which does not exist decides nothing.
    if (!byId.has(of)) continue;

    switch (row.verdict) {
      case 'duplicate':
        out[index] = { verdict: 'duplicate', of };
        break;
      case 'contradicts':
        out[index] = { verdict: 'contradicts', of };
        break;
      case 'refines': {
        const text = typeof row.text === 'string' ? row.text.trim() : '';
        out[index] = text ? { verdict: 'refines', of, text } : { verdict: 'new' };
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Entries rendered for a model: oldest first, id-tagged so answers can cite. */
function transcript(entries: Entry[], perEntryChars = 1200): string {
  return [...entries]
    .sort((a, b) => (a.created < b.created ? -1 : 1))
    .map((e) => {
      const when = formatDay(new Date(e.created));
      const body = truncate(plainText(e.body), perEntryChars);
      const tags = e.tags.length ? ` (${e.tags.map((t) => `#${t}`).join(' ')})` : '';
      return `[${e.id}] ${when} — ${e.title}${tags}\n${body}`;
    })
    .join('\n\n');
}
