import pc from 'picocolors';
import type { Entry, SearchHit, Thread } from '@ppr/core';
import {
  entryJson,
  formatDay,
  formatTime,
  gapWords,
  plainText,
  relativeAge,
  shortId,
  truncate,
} from '@ppr/core';

export interface RenderOptions {
  json?: boolean;
  color?: boolean;
  quiet?: boolean;
}

let colorEnabled = true;

export function setColor(enabled: boolean): void {
  colorEnabled = enabled && !process.env.NO_COLOR && process.stdout.isTTY === true;
}

/** Colour helpers that collapse to identity when colour is off or piped. */
const c = {
  dim: (s: string) => (colorEnabled ? pc.dim(s) : s),
  bold: (s: string) => (colorEnabled ? pc.bold(s) : s),
  cyan: (s: string) => (colorEnabled ? pc.cyan(s) : s),
  green: (s: string) => (colorEnabled ? pc.green(s) : s),
  yellow: (s: string) => (colorEnabled ? pc.yellow(s) : s),
  red: (s: string) => (colorEnabled ? pc.red(s) : s),
  magenta: (s: string) => (colorEnabled ? pc.magenta(s) : s),
};

export { c as color };

export const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

export const errline = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export const json = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

/**
 * Machine-friendly projection of an entry. Stable: other tools depend on it.
 *
 * Defined in core, not here, because it is the same shape an event carries on
 * a hook's stdin — one definition, so `--json` (pull) and events (push) can
 * never describe an entry differently.
 */
export { entryJson };

const KIND_COLOR: Record<string, (s: string) => string> = {
  log: c.green,
  note: c.cyan,
  dump: c.magenta,
  clip: c.yellow,
  voice: c.magenta,
  memory: c.yellow,
  reminder: c.yellow,
};

const kindTag = (kind: string): string => (KIND_COLOR[kind] ?? c.dim)(kind.padEnd(6).slice(0, 6));

export { shortId };

/** Rewrites the full ids a model cites into the short form shown everywhere else. */
export const shortenCitations = (text: string): string =>
  text.replace(/\[([0-9a-hjkmnp-tv-z]{16})\]/g, (_, id: string) => `[${shortId(id)}]`);

/** `2h ago`, or `just now` — never the nonsense `now ago`. */
export function ago(date: Date, now: Date): string {
  const age = relativeAge(date, now);
  return age === 'now' ? 'just now' : `${age} ago`;
}

/** One entry, one line: `x7k2m1qp  log     2h   Fixed the deploy  #infra` */
export function entryLine(entry: Entry, now: Date): string {
  const age = relativeAge(new Date(entry.created), now).padStart(4);
  const tags = entry.tags.length ? c.dim(` ${entry.tags.map((t) => `#${t}`).join(' ')}`) : '';
  const pin = entry.pinned ? c.yellow('* ') : '';
  return `${c.dim(shortId(entry.id))}  ${kindTag(entry.kind)}  ${c.dim(age)}  ${pin}${truncate(entry.title, 64)}${tags}`;
}

/** Entries grouped under day headings — how a journal actually reads. */
export function entryList(entries: Entry[], now: Date): string {
  if (!entries.length) return c.dim('No entries.');
  const lines: string[] = [];
  let currentDay = '';
  for (const entry of entries) {
    const date = new Date(entry.created);
    const day = formatDay(date);
    if (day !== currentDay) {
      if (lines.length) lines.push('');
      lines.push(c.bold(day));
      currentDay = day;
    }
    lines.push(`  ${entryLine(entry, now)}`);
  }
  return lines.join('\n');
}

export function entryDetail(entry: Entry, now: Date): string {
  const date = new Date(entry.created);
  const head = [
    c.bold(entry.title),
    c.dim(
      [
        shortId(entry.id),
        entry.kind,
        `${formatDay(date)} ${formatTime(date)}`,
        ago(date, now),
      ].join('  ·  '),
    ),
  ];
  if (entry.tags.length) head.push(c.cyan(entry.tags.map((t) => `#${t}`).join(' ')));
  if (entry.source) head.push(c.dim(entry.source));
  return `${head.join('\n')}\n\n${entry.body}`;
}

/** `Fri 06 Feb 2026` — a thread can span years, so the year is not optional. */
const threadDay = (entry: Entry): string => {
  const date = new Date(entry.created);
  return `${formatDay(date)} ${date.getFullYear()}`;
};

/**
 * A thread as a timeline: one line per entry, with the silences marked.
 *
 * Dates rather than ages, because "3mo" twice does not tell you the two
 * entries are eighteen months apart — and the shape of time is the thing this
 * view exists to show. Facts sit underneath in their own block: they are
 * conclusions, not moments, and a fact given a position in a timeline is the
 * mistake I12 is about.
 */
export function threadTimeline(thread: Thread): string {
  if (!thread.entries.length) return c.dim('No thread here.');
  const gaps = new Map(thread.gaps.map((g) => [g.before, g.days]));
  // Padded on the visible text, coloured after: a width measured on a string
  // that already holds escape codes is not a width (L3).
  const width = thread.entries.reduce((w, m) => Math.max(w, truncate(m.entry.title, 52).length), 0);
  const indent = ' '.repeat(threadDay(thread.entries[0]!.entry).length);

  const lines: string[] = [];
  for (const member of thread.entries) {
    const gap = gaps.get(member.entry.id);
    if (gap !== undefined) lines.push('', `${indent}  ${c.dim(`·  ${gapWords(gap)}`)}`, '');
    lines.push(
      [
        c.dim(threadDay(member.entry)),
        kindTag(member.entry.kind),
        c.dim(shortId(member.entry.id)),
        truncate(member.entry.title, 52).padEnd(width),
        c.dim(member.why),
      ].join('  '),
    );
  }

  if (thread.facts.length) {
    lines.push('', c.bold('What you concluded'));
    for (const { fact } of thread.facts) {
      lines.push(`  ${c.dim(shortId(fact.id))}  ${truncate(fact.text, 70)}`);
    }
  }
  return lines.join('\n');
}

export function searchList(hits: SearchHit[], now: Date): string {
  if (!hits.length) return c.dim('No matches.');
  return hits
    .map((hit) => `${entryLine(hit.entry, now)}\n    ${c.dim(truncate(hit.excerpt, 120))}`)
    .join('\n');
}

/** Aligned two-column output, used by config/ai/stats listings. */
export function table(rows: Array<[string, string]>, gap = 2): string {
  const width = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  return rows.map(([k, v]) => `${k.padEnd(width + gap)}${v}`).join('\n');
}

export const preview = (entry: Entry, width = 100): string => truncate(plainText(entry.body), width);
