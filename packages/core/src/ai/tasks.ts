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

Answer a question using only the user's journal entries below.

Rules:
- Cite the entries you used as [id] right after the claim they support.
- If the entries do not answer it, say so in one line. Do not guess.
- Quote the user's own words when they said it better than a paraphrase would.
- Be brief. This is a lookup, not an essay.`;

export async function ask(
  question: string,
  entries: Entry[],
  opts: TaskOptions = {},
): Promise<{ text: string; ai: boolean; cited: string[] }> {
  if (!opts.provider) {
    return {
      text: entries.length
        ? `No model configured. Closest entries:\n\n${entries
            .map((e) => `- [${shortId(e.id)}] ${e.title}`)
            .join('\n')}`
        : 'No matching entries.',
      ai: false,
      cited: entries.map((e) => e.id),
    };
  }

  const text = await opts.provider.generate({
    system: ASK_SYSTEM,
    prompt: `Question: ${question}\n\nEntries:\n\n${transcript(entries, 2400)}`,
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
- Never ask what the entry already answers.

Return JSON: {"questions": string[]}`;

export async function followUps(text: string, opts: TaskOptions = {}): Promise<string[]> {
  if (!opts.provider) return GENERIC_FOLLOWUPS.slice(0, 1);
  const raw = await opts.provider.generate({
    system: FOLLOWUP_SYSTEM,
    prompt: text,
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

Return JSON: {"memories": string[]}`;

export async function extractMemories(text: string, opts: TaskOptions = {}): Promise<string[]> {
  if (!opts.provider) return [];
  const raw = await opts.provider.generate({
    system: MEMORY_SYSTEM,
    prompt: text,
    json: true,
    maxTokens: 500,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const parsed = parseJsonLoose<{ memories?: unknown }>(raw);
  return Array.isArray(parsed?.memories)
    ? parsed.memories.map(String).map((m) => m.trim()).filter(Boolean).slice(0, 10)
    : [];
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
