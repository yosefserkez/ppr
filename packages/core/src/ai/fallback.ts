import type { Entry } from '../types.js';
import { dayKey, formatDay } from '../util/time.js';
import { extractTags, plainText, titleFromBody, truncate } from '../util/text.js';

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

/** Questions worth answering about almost any entry — used when no model is set. */
export const GENERIC_FOLLOWUPS = [
  'What made you choose this over the alternative?',
  'What would you check first if this turns out to be wrong?',
  'What did you learn that you did not know this morning?',
];
