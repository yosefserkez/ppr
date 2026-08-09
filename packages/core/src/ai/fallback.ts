import type { Entry } from '../types.js';
import { factText } from '../memory.js';
import { gapWords, threadGaps } from '../thread.js';
import { countdown, dayKey, formatDay } from '../util/time.js';
import { extractTags, plainText, titleFromBody, truncate } from '../util/text.js';
import { shortId } from '../util/id.js';

/**
 * Verbal scaffolding that carries no information once it is written down.
 *
 * Split by shape: words safe to drop anywhere, phrases, and words that are only
 * filler when a comma follows them — "things like this" must survive, "like,
 * we should" must not.
 */
const FILLER_PATTERNS = [
  /\b(?:um+|uh+|erm+|hmm+)\b[,.]?\s*/gi,
  /\b(?:you know|i mean|sort of|kind of|let me think|let's see|so yeah)\b[,.]?\s*/gi,
  /\b(?:like|actually|basically|literally|anyway|right|okay|ok|so)\s*,\s*/gi,
  /^\s*(?:so|and|but|well)\b[,]?\s+/gim,
];

const stripFiller = (line: string): string =>
  FILLER_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, ''), line);

/** Transcripts come back with a lowercase "i". Nothing else is touched. */
const fixPronoun = (s: string): string => s.replace(/\bi\b/g, 'I');

/**
 * The no-model path for `ppr dump`. Conservative on purpose: it removes filler
 * and tidies shape, and never invents or drops content. A local heuristic that
 * silently ate half a brain dump would be worse than no feature at all.
 */
export function heuristicDistill(
  text: string,
  opts: { maxTags?: number } = {},
): { title: string; body: string; tags: string[] } {
  const cleaned = fixPronoun(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => stripFiller(line).replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const sentences = splitSentences(capitalizeSentences(cleaned));
  // Several sentences on one line read better as bullets; one thought stays prose.
  const body =
    sentences.length >= 3 && !cleaned.includes('\n')
      ? sentences.map((s) => `- ${s}`).join('\n')
      : capitalizeSentences(cleaned);

  return {
    title: titleFromBody(body) || truncate(plainText(body), 60) || 'Untitled',
    body,
    tags: extractTags(body).slice(0, opts.maxTags ?? 5),
  };
}

/** Speech-to-text and fast typing both skip capitals; this puts them back. */
const capitalizeSentences = (s: string): string =>
  s.replace(/(^|[.!?]\s+|\n\s*)([a-z])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase());

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Offline recap: the shape of the week, straight from the entries. */
export function heuristicRecap(entries: Entry[]): string {
  if (!entries.length) return 'Nothing logged in this window.';
  const byDay = new Map<string, Entry[]>();
  for (const entry of [...entries].reverse()) {
    const key = dayKey(new Date(entry.created));
    let list = byDay.get(key);
    if (!list) byDay.set(key, (list = []));
    list.push(entry);
  }
  const lines: string[] = [];
  for (const [day, dayEntries] of byDay) {
    lines.push(`## ${formatDay(new Date(`${day}T12:00:00`))}`);
    for (const entry of dayEntries) lines.push(`- ${entry.title}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * The no-model story of a thread: the entries themselves, in order, with the
 * silences marked.
 *
 * What a model adds here is the reasoning — what changed, what was decided,
 * where it stopped. What it cannot add is the *shape*, which is arithmetic and
 * already known (`threadGaps`), so an offline reader still sees that this was
 * picked up again after eight months rather than a flat list of dates.
 *
 * Facts go underneath rather than in the sequence: they are conclusions, not
 * moments, and putting one between two entries would date a thing that is not
 * about a day (I12).
 */
export function heuristicThread(entries: Entry[], facts: Entry[] = []): string {
  if (!entries.length) return 'No thread here.';
  const ordered = [...entries].sort((a, b) => (a.created < b.created ? -1 : 1));
  const gaps = new Map(threadGaps(ordered).map((g) => [g.before, g.days]));

  const lines: string[] = [];
  for (const entry of ordered) {
    const gap = gaps.get(entry.id);
    if (gap !== undefined) lines.push('', `— ${gapWords(gap)} —`, '');
    const date = new Date(entry.created);
    lines.push(`${formatDay(date)} ${date.getFullYear()} — [${shortId(entry.id)}] ${entry.title}`);
  }
  if (facts.length) {
    lines.push('', 'What you concluded:');
    for (const fact of facts) lines.push(`- [${shortId(fact.id)}] ${factText(fact.body)}`);
  }
  return lines.join('\n');
}

/** Questions worth answering about almost any entry — used when no model is set. */
export const GENERIC_FOLLOWUPS = [
  'What made you choose this over the alternative?',
  'What would you check first if this turns out to be wrong?',
  'What did you learn that you did not know this morning?',
];

/**
 * The no-model brief. Everything that matters — which facts are due, how soon,
 * and whether they have been thought about — was decided by arithmetic, so
 * this loses only the phrasing.
 */
export function heuristicBrief(
  items: Array<{ text: string; days: number; when: string; mentions: string[] }>,
): string {
  return items
    .map((item) => {
      const quiet = item.mentions.length ? '' : '\n  nothing logged about it';
      return `${item.text}\n  ${item.when} — ${countdown(item.days)}${quiet}`;
    })
    .join('\n\n');
}
