import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface Document {
  data: Record<string, unknown>;
  body: string;
  /**
   * The frontmatter block exactly as it was written, kept only when it could
   * not be read. `data` is empty in that case, so anything that re-serializes
   * the document would write the block out of existence — including whatever
   * id and third-party keys were in there.
   */
  rawFrontmatter?: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Splits YAML frontmatter from a markdown body. A file with no frontmatter,
 * or with broken YAML, is still readable — it just comes back as all body.
 * Losing a note to a stray colon is not acceptable.
 */
export function parseDocument(raw: string): Document {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text.trim() };

  const body = text.slice(match[0].length).trim();
  const block = match[1]!;
  try {
    const parsed = parseYaml(block) as unknown;
    // A block that is empty, or only comments, is not broken — it says
    // nothing, and an entry written back over it loses nothing either.
    if (parsed === null) return { data: {}, body };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, body, rawFrontmatter: block };
    }
    return { data: parsed as Record<string, unknown>, body };
  } catch {
    return { data: {}, body, rawFrontmatter: block };
  }
}

/**
 * A document whose frontmatter was never read, written back out.
 *
 * The block goes out exactly as it arrived, because ppr holds no reading of it
 * and anything else would be inventing one. The framing lives here next to
 * `serializeDocument` so there is one answer to what a ppr file looks like.
 */
export function serializeRawDocument(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body.trim()}\n`;
}

export function serializeDocument(data: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined && v !== null && !isEmptyArray(v)),
  );
  const yaml = Object.keys(clean).length
    ? stringifyYaml(clean, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' })
    : '';
  return `---\n${yaml}---\n\n${body.trim()}\n`;
}

const isEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length === 0;
