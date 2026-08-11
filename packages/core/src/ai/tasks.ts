import type { AIProvider } from '../ports.js';
import type { Entry } from '../types.js';
import { PprError } from '../errors.js';
import { factKey, factText, parseFactDate, type FactRecurrence } from '../memory.js';
import { plainText, truncate } from '../util/text.js';
import { shortId } from '../util/id.js';
import { byCreatedAsc } from '../util/order.js';
import { countdown, dayKey, formatDay } from '../util/time.js';
import { asStringList, parseJsonLoose } from './json.js';
import {
  GENERIC_FOLLOWUPS,
  heuristicBrief,
  heuristicDistill,
  heuristicRecap,
  heuristicThread,
} from './fallback.js';

/**
 * Every task takes an optional provider. When it is absent — or when the model
 * misbehaves — the offline path runs instead. No command ever hard-fails
 * because the AI was unavailable; that is what "local-first" has to mean.
 */
export interface TaskOptions {
  provider?: AIProvider | undefined;
  signal?: AbortSignal;
}

/**
 * Added to a prompt when `capture.autoLink` is on. Only names are marked: the
 * deterministic pass in `links.ts` handles every later mention, so the model's
 * job is to introduce a subject once, not to decorate the text.
 */
const LINK_RULE = `- Wrap the name of each person, project, place, or product in [[double brackets]]
  the first time it appears. Names only — never verbs, dates, or whole phrases.`;

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
  opts: TaskOptions & { maxTags?: number; context?: string; link?: boolean } = {},
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
    system: opts.link ? `${DISTILL_SYSTEM}\n${LINK_RULE}` : DISTILL_SYSTEM,
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

const THREAD_SYSTEM = `${VOICE}

Tell the story of one line of thought, from the entries that carry it.

The user is picking this up again, not reading a report. Everything below
serves the last rule.

Rules:
- One opening line: what this thread is.
- Then how the thinking moved — what they tried, what changed their mind, what
  they settled. Cite the entry as [id] right after the claim it supports.
- The standing facts are what they have concluded since. Treat them as current,
  and cite them the same way.
- Notice time. Every entry is dated and so is today. A long silence is part of
  the story: say when it was put down and when it came back.
- End with where it left off: the open question, and the direction of travel in
  the last entries. This is the point of the whole summary.
- Never invent a next step they did not write. Never encourage, never advise.
- Prose, in their voice, under 250 words. No headings, no bullets.`;

/**
 * The story so far: what a thread is, how it moved, and where it stopped.
 *
 * The thread itself was decided by the graph before this ran (`thread.ts`), so
 * a missing or broken model costs the reasoning and never the sequence — the
 * fallback is the timeline with its silences marked, which is what the offline
 * command prints anyway (I2).
 */
export async function threadRecap(
  entries: Entry[],
  facts: Entry[] = [],
  opts: TaskOptions & { now?: Date } = {},
): Promise<{ text: string; ai: boolean }> {
  if (!entries.length) return { text: 'No thread here.', ai: false };
  if (!opts.provider) return { text: heuristicThread(entries, facts), ai: false };

  const now = opts.now;
  const text = await opts.provider.generate({
    system: THREAD_SYSTEM,
    prompt: [
      // Without today's date "eight months later" is unsayable, and a model
      // that cannot date the last entry will describe a dead thread as live.
      now ? `Today is ${formatDay(now)} ${now.getFullYear()}.` : '',
      facts.length ? `\nWhat the user has concluded since:\n${factBlock(facts)}` : '',
      `\nThe thread, oldest first:\n\n${transcript(entries, 1200, { year: true })}`,
    ]
      .filter(Boolean)
      .join('\n'),
    maxTokens: 900,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return text.trim()
    ? { text: text.trim(), ai: true }
    : { text: heuristicThread(entries, facts), ai: false };
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
  facts.map((f) => `[${f.id}] ${factText(f.body)}`).join('\n');

export async function ask(
  question: string,
  entries: Entry[],
  opts: TaskOptions & { facts?: Entry[]; now?: Date } = {},
): Promise<{ text: string; ai: boolean; cited: string[] }> {
  const facts = opts.facts ?? [];

  if (!opts.provider) {
    const lines = [
      facts.length ? `What ppr knows:\n\n${facts.map((f) => `- [${shortId(f.id)}] ${factText(f.body)}`).join('\n')}` : '',
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
- Split a sentence that holds more than one property of its subject. "My
  girlfriend Emily's birthday is 20 October and she likes chocolate" is three
  facts: who Emily is, when her birthday is, and what she likes. Three
  different things about her, each useful on its own.
- Do not split one property into its parts. "My financial goals are to save
  aggressively, invest in index funds, and grow long-term wealth" is one fact
  that lists three things, not three facts — as fragments each one says less
  than the sentence did. Ask whether the pieces are different properties or
  items of the same one.
- Say each thing once. A fact that restates another in different words, or
  that only follows from it, is not a second fact.
- Every fact must stand on its own, read cold, a year from now. Name the
  subject in each one — never "she", "it", "that project".
- Refer to the writer as "the user". "My sister" becomes "the user's sister".
- Keep names, numbers, and dates exactly as given. Never round or infer a year.
- Skip anything transient: today's mood, current status, work in progress,
  anything that is only true this week.
- If there is genuinely nothing durable, return an empty list. That is a valid
  answer, and a better one than a vague fact.

Return JSON: {"memories": [{"fact": string, "from": string[], "date": string, "recurs": string}]}
- fact: one sentence, the fact itself and nothing else.
- from: the ids of the sources it came from, copied exactly from their headings.
- date: the calendar date the fact is about, as YYYY-MM-DD. Always include it
  for a birthday, an anniversary, or a deadline. Leave it out only when the
  fact is not about a date at all.
  Take the year from the source even when it is in a different sentence. If the
  source never gives a year, write 0000 as the year. Never invent one.
- recurs: "yearly" for anything that comes round every year, a birthday or an
  anniversary. Leave it out otherwise.`;

/**
 * Output budget for a task whose reply grows with its input.
 *
 * Generous on purpose: an over-large ceiling costs nothing (models stop when
 * they are done), while an under-sized one truncates the JSON and throws the
 * whole batch away.
 */
const budgetFor = (inputChars: number): number =>
  Math.min(8000, Math.max(1200, Math.ceil(inputChars / 2)));

/** One source of text to mine for facts. `id` is an entry id when there is one. */
export interface FactSource {
  id?: string;
  text: string;
}

export interface FactCandidate {
  text: string;
  /** Entry ids this fact came from. Empty when the text was piped in. */
  from: string[];
  /** `YYYY-MM-DD`, validated. Absent when the fact carries no date. */
  date?: string;
  recurs?: FactRecurrence;
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
  opts: TaskOptions & { max?: number; link?: boolean } = {},
): Promise<FactBatch> {
  const batch = sources.filter((s) => s.text.trim());
  if (!batch.length) return { facts: [], ok: true };
  if (!opts.provider) return { facts: [], ok: false };
  const ids = batch.map((s) => s.id).filter((id): id is string => Boolean(id));

  const labelled = batch
    .map((s, i) => `[${s.id ?? `source-${i + 1}`}]\n${s.text.trim()}`)
    .join('\n\n---\n\n');

  const raw = await opts.provider.generate({
    system: opts.link ? `${MEMORY_SYSTEM}\n${LINK_RULE}` : MEMORY_SYSTEM,
    prompt: `Sources, each headed by its id:\n\n${labelled}`,
    json: true,
    // Scaled to the batch. A fixed ceiling truncated the JSON on a full day of
    // entries, and a half-written object is indistinguishable from a model
    // that failed — so a backfill reported "nothing durable" over and over
    // while the model was answering correctly every time (L22).
    maxTokens: budgetFor(labelled.length),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const parsed = parseJsonLoose<{ memories?: unknown }>(raw);
  if (!Array.isArray(parsed?.memories)) return { facts: [], ok: false };

  const facts: FactCandidate[] = [];
  for (const item of parsed.memories.slice(0, opts.max ?? 20)) {
    const text = typeof item === 'string' ? item.trim() : String((item as { fact?: unknown })?.fact ?? '').trim();
    if (!looksLikeAFact(text)) continue;
    const claimed = asStringList((item as { from?: unknown })?.from, 5).map((s) => s.trim());
    // An unrecognised id is not provenance. Fall back to the whole batch,
    // which is true — the fact did come from somewhere in it.
    const from = claimed.filter((id) => ids.includes(id));
    const date = parseFactDate((item as { date?: unknown })?.date);
    facts.push({
      text,
      from: from.length ? from : ids,
      ...(date ? { date } : {}),
      ...(date && (item as { recurs?: unknown })?.recurs === 'yearly' ? { recurs: 'yearly' as const } : {}),
    });
  }
  return { facts, ok: true };
}

/**
 * Whether a string is a sentence or a piece of the schema that was meant to
 * carry it.
 *
 * A half-parsed reply yields shards like `"from": ["` — they arrive in the
 * right place, read as facts, and would be stored as facts. What this must not
 * do is reject real facts for looking structured: with `capture.autoLink` on,
 * every fact about a person *starts* with `[[Their Name]]`, and an earlier
 * version of this check threw all of them away.
 */
function looksLikeAFact(text: string): boolean {
  if (text.length < 8) return false;
  if (text.trim().split(/\s+/).length < 2) return false;
  // Quote and brace debris. `[` is deliberately absent: `[[Emily]]` is a name.
  return !/^["'{]|["{[]$|\\"|"\s*:/.test(text);
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
  /**
   * Says what an *earlier candidate in the same batch* says. `ofCandidate` is
   * a 0-based index into the candidate list — the prompt numbers candidates
   * from 1, this does not — and always points backwards, so the caller can
   * resolve it against something it has already dealt with.
   */
  | { verdict: 'duplicate-of-candidate'; ofCandidate: number }
  | { verdict: 'refines'; of: string; text: string }
  | { verdict: 'contradicts'; of: string };

const RECONCILE_SYSTEM = `${VOICE}

Decide how each candidate fact relates to the facts already known, and to the
candidates before it.

For each candidate, exactly one verdict:
- "new" — nothing known covers this, and no earlier candidate says it either.
- "duplicate" — a known fact already says this, even in different words. Give its id.
- "duplicate-of-candidate" — an earlier candidate in this same list already
  says this, even in different words. Give its number in "ofCandidate".
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
- The candidates come from one pass over several entries, so the same thing
  said on two different days appears twice, worded differently. "ofCandidate"
  must always be a smaller number than "i" — point backwards, never forwards,
  and never at the candidate itself.

Return JSON: {"verdicts": [{"i": number, "verdict": string, "of": string, "ofCandidate": number, "text": string}]}
- i is the candidate's number. Omit "of", "ofCandidate", and "text" when they
  do not apply.`;

/**
 * One verdict per candidate, index-aligned, against the known facts *and*
 * against the earlier candidates in the same batch.
 *
 * Both questions ride in the one call because both are already in the one
 * prompt: asking whether a candidate repeats a sibling costs nothing extra,
 * and without it a backfill that meets the same fact twice in two different
 * chunks stores it twice.
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
  const out: FactVerdict[] = candidates.map((text) => {
    const hit = known.find((k) => factKey(k.text) === factKey(text));
    return hit ? { verdict: 'duplicate' as const, of: hit.id } : { verdict: 'new' as const };
  });

  // With an empty store a lone candidate can only be "new", so the call is
  // skipped — but two candidates can still say one thing in two ways, which is
  // exactly what a first backfill produces and what nothing else here catches.
  if (!opts.provider || (!known.length && candidates.length < 2)) return out;

  const raw = await opts.provider.generate({
    system: RECONCILE_SYSTEM,
    prompt: [
      known.length
        ? `Known facts:\n${known.map((k) => `[${k.id}] ${k.text}`).join('\n')}`
        : 'Known facts: none yet.',
      '',
      'Candidates:',
      candidates.map((c, i) => `${i + 1}. ${c}`).join('\n'),
    ].join('\n'),
    json: true,
    maxTokens: Math.min(4000, 400 + candidates.length * 140),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const parsed = parseJsonLoose<{ verdicts?: unknown }>(raw);
  if (!Array.isArray(parsed?.verdicts)) return out;

  const byId = new Map(known.map((k) => [k.id, k]));
  for (const item of parsed.verdicts) {
    const row = item as {
      i?: unknown;
      verdict?: unknown;
      of?: unknown;
      ofCandidate?: unknown;
      text?: unknown;
    };
    const index = Number(row.i) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue;
    const of = typeof row.of === 'string' ? row.of.trim() : '';
    // A sibling verdict may only point at a candidate that has already been
    // decided. A forward reference has no answer yet, and a pair pointing at
    // each other would leave nothing standing — so anything but an earlier
    // candidate is not a verdict at all, and the floor below it holds.
    const sibling = Number(row.ofCandidate) - 1;
    const earlier =
      Number.isInteger(sibling) && sibling >= 0 && sibling < index ? sibling : null;

    switch (row.verdict) {
      case 'duplicate':
        // A verdict that points at a fact which does not exist decides
        // nothing — unless it gave a candidate number instead, which is the
        // same answer written under the other label.
        if (byId.has(of)) out[index] = { verdict: 'duplicate', of };
        else if (earlier !== null) out[index] = { verdict: 'duplicate-of-candidate', ofCandidate: earlier };
        break;
      case 'duplicate-of-candidate':
        if (earlier !== null) out[index] = { verdict: 'duplicate-of-candidate', ofCandidate: earlier };
        break;
      case 'contradicts':
        if (byId.has(of)) out[index] = { verdict: 'contradicts', of };
        break;
      case 'refines': {
        if (!byId.has(of)) break;
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

const REMINDER_SYSTEM = `${VOICE}

The user typed one line asking to be reminded of something. Separate *when* it
is from *what* it is.

Rules:
- Answer with the day only, as YYYY-MM-DD. Today's date is given; do the
  arithmetic from it.
- A weekday with no other qualification means the next such day, never today.
- text: what they want to be reminded of, with the when-phrase and any
  "remind me to" removed. Their words, not a rewrite of them.
- If there is genuinely no date in the line, leave "date" out. That is a valid
  answer and a better one than a guess — the line is kept either way, and a
  wrong date is worse than none.

Return JSON: {"text": string, "date": "YYYY-MM-DD", "recurs": "yearly"}
- recurs: "yearly" only when the line says it repeats every year. Otherwise omit.`;

/**
 * The one model call in the reminder path, and only when the deterministic
 * read found no date at all.
 *
 * Returns nothing rather than throwing on anything it cannot use: the caller's
 * fallback is to keep the words as a todo, which must happen whether the model
 * is missing, slow, or wrong (I2).
 */
export interface ReminderDraft {
  text: string;
  /** `YYYY-MM-DD`, validated. A draft with no date is not a draft at all. */
  date: string;
  recurs?: FactRecurrence;
}

export async function extractReminder(
  input: string,
  opts: TaskOptions & { now?: Date } = {},
): Promise<ReminderDraft | null> {
  if (!opts.provider) return null;
  const now = opts.now ?? new Date();

  const raw = await opts.provider.generate({
    system: REMINDER_SYSTEM,
    // Without the date a model invents one, and a reminder for the wrong day
    // is worse than the log it would otherwise have been.
    prompt: `Today is ${formatDay(now)} ${now.getFullYear()} (${dayKey(now)}).\n\nLine: ${input}`,
    json: true,
    maxTokens: 200,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const parsed = parseJsonLoose<{ text?: unknown; date?: unknown; recurs?: unknown }>(raw);
  const date = parseFactDate(parsed?.date);
  if (!date) return null;
  const text = String(parsed?.text ?? '').trim();
  return {
    // A model that dropped the words is not allowed to cost them.
    text: text || input,
    date,
    ...(parsed?.recurs === 'yearly' ? { recurs: 'yearly' as const } : {}),
  };
}

const BRIEF_SYSTEM = `${VOICE}

Write a short heads-up from facts that are about to come round.

Rules:
- One short line per item, in the order given. No preamble, no sign-off.
- Say when it is, in days or weeks. The number of days is given; use it.
- An item marked overdue was meant to happen and did not. Say so plainly and
  say how late it is. Never congratulate, never scold.
- When nothing has been logged about an item, that is the point of mentioning
  it — say so plainly, and ask the one question worth asking.
- Use what else is known about the person or thing when it is relevant to that
  question. Do not restate facts for their own sake.
- Never invent a suggestion that needs information you were not given. No
  shopping lists, no links, no prices.
- Under 15 words per line where you can.`;

export interface BriefItem {
  /** The fact itself, one line. */
  text: string;
  days: number;
  /** `Mon 20 Oct`, already formatted for the user's locale-independent view. */
  when: string;
  ordinal?: number;
  /** Titles of entries that have touched this since it last came round. */
  mentions: string[];
  /** Other facts about the same subject, for a question worth asking. */
  related: string[];
}

/**
 * Phrasing only. Which items are due was decided by arithmetic before this ran,
 * so a missing or broken model costs the wording and never the heads-up.
 */
export async function brief(
  items: BriefItem[],
  opts: TaskOptions = {},
): Promise<{ text: string; ai: boolean }> {
  if (!items.length) return { text: 'Nothing coming up.', ai: false };
  if (!opts.provider) return { text: heuristicBrief(items), ai: false };

  const text = await opts.provider.generate({
    system: BRIEF_SYSTEM,
    prompt: items
      .map((item) =>
        [
          `- ${item.text}`,
          `  when: ${item.when}, ${countdown(item.days)}`,
          item.ordinal ? `  this will be number ${item.ordinal}` : '',
          `  logged since last time: ${item.mentions.length ? item.mentions.join('; ') : 'nothing'}`,
          item.related.length ? `  also known: ${item.related.join('; ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n'),
    maxTokens: Math.min(2000, 300 + items.length * 90),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return text.trim() ? { text: text.trim(), ai: true } : { text: heuristicBrief(items), ai: false };
}

/**
 * Entries rendered for a model: oldest first, id-tagged so answers can cite.
 *
 * The year is optional because most callers hand over a week and saying "2026"
 * five times is noise — but a thread can span years, and "Mon 06 Feb" twice
 * eighteen months apart is not a date at all.
 */
function transcript(entries: Entry[], perEntryChars = 1200, opts: { year?: boolean } = {}): string {
  return [...entries]
    .sort(byCreatedAsc)
    .map((e) => {
      const date = new Date(e.created);
      const when = opts.year ? `${formatDay(date)} ${date.getFullYear()}` : formatDay(date);
      const body = truncate(plainText(e.body), perEntryChars);
      const tags = e.tags.length ? ` (${e.tags.map((t) => `#${t}`).join(' ')})` : '';
      return `[${e.id}] ${when} — ${e.title}${tags}\n${body}`;
    })
    .join('\n\n');
}
