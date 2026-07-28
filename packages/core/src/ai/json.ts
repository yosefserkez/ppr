/**
 * Models wrap JSON in prose, fences, or both. This gets the object out without
 * making the caller care which model produced it.
 */
export function parseJsonLoose<T>(text: string): T | null {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1],
    sliceBalanced(trimmed, '{', '}'),
    sliceBalanced(trimmed, '[', ']'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

/** First balanced {...} or [...] run, ignoring braces inside strings. */
function sliceBalanced(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export const asStringList = (v: unknown, max = 10): string[] => {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return list
    .map((x) => String(x).trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean)
    .slice(0, max);
};
