import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface Document {
  data: Record<string, unknown>;
  body: string;
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
  try {
    const parsed = parseYaml(match[1]!) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, body };
    }
    return { data: parsed as Record<string, unknown>, body };
  } catch {
    return { data: {}, body };
  }
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
