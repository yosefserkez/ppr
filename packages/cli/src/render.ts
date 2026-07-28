import pc from 'picocolors';
import type { Entry, SearchHit } from '@ppr/core';
import { formatDay, formatTime, plainText, relativeAge, shortId, truncate } from '@ppr/core';

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

/** Machine-friendly projection of an entry. Stable: other tools depend on it. */
export const entryJson = (entry: Entry) => ({
  id: entry.id,
  kind: entry.kind,
  title: entry.title,
  created: entry.created,
  updated: entry.updated,
  tags: entry.tags,
  links: entry.links,
  ...(entry.source ? { source: entry.source } : {}),
  ...(entry.pinned ? { pinned: true } : {}),
  path: entry.path,
  body: entry.body,
});

const KIND_COLOR: Record<string, (s: string) => string> = {
  log: c.green,
  note: c.cyan,
  dump: c.magenta,
  clip: c.yellow,
  voice: c.magenta,
  memory: c.yellow,
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
