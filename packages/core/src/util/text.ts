/** Dependency-free text handling. Runs unchanged in Node, RN, and the browser. */

export const collapse = (s: string): string => s.replace(/[ \t]+/g, ' ').replace(/\s+$/gm, '');

export function slugify(input: string, maxLength = 48): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug;
  // Cut on a word boundary so slugs stay readable.
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > maxLength * 0.6 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

export function truncate(s: string, max: number, ellipsis = '…'): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + ellipsis;
}

/** Body text with code fences, frontmatter-ish noise, and markup removed. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const CODE_SPANS = /```[\s\S]*?```|`[^`\n]*`/g;
/** Blanks out code so tag/link scanners never match inside it, keeping offsets intact. */
const withoutCode = (s: string): string => s.replace(CODE_SPANS, (m) => ' '.repeat(m.length));

/** `#tag`, `#nested/tag`. Markdown headings (`# `) and URL fragments are ignored. */
export function extractTags(body: string): string[] {
  const out = new Set<string>();
  for (const m of withoutCode(body).matchAll(/(^|[\s(\[])#([a-z0-9][\w/-]*)/gi)) {
    out.add(m[2]!.toLowerCase());
  }
  return [...out];
}

/** `[[target]]` or `[[target|alias]]`. */
export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of withoutCode(body).matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const target = m[1]!.trim();
    if (target) out.add(target.toLowerCase());
  }
  return [...out];
}

export function extractUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>()\[\]"']+/gi)) {
    out.add(m[0]!.replace(/[.,;:!?]+$/, ''));
  }
  return [...out];
}

/** Tags carry their own column in every view; a title should not repeat them. */
const stripTags = (s: string): string =>
  s.replace(/(^|\s)#[a-z0-9][\w/-]*/gi, '$1').replace(/\s{2,}/g, ' ').trim();

/** First heading, else first sentence, else empty. Never longer than `max`. */
export function titleFromBody(body: string, max = 72): string {
  const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(body);
  if (heading) return truncate(plainText(heading[1]!), max);
  const text = stripTags(plainText(body)).replace(/[,\s]+$/, '');
  if (!text) return '';
  const sentence = /^.*?[.!?](?=\s|$)/.exec(text);
  const candidate = sentence && sentence[0].length > 12 ? sentence[0] : text;
  return truncate(candidate.replace(/[.!?]+$/, ''), max);
}

export function wordCount(text: string): number {
  const t = plainText(text);
  return t ? t.split(/\s+/).length : 0;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(html: string): string {
  return html.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

const DROP_TAGS = 'script|style|noscript|nav|header|footer|aside|form|svg|iframe|template|button';

export interface ExtractedPage {
  title: string;
  text: string;
  /** Best-effort author/site description from meta tags. */
  description?: string;
}

/**
 * A small readability pass: prefer <article>/<main>, drop chrome, unwrap to text.
 * Not a full DOM parse — deliberately. It runs anywhere and is good enough to
 * hand to a model or to read as a fallback.
 */
export function extractFromHtml(html: string): ExtractedPage {
  const titleMatch =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const descMatch =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html) ??
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i.exec(html);

  let scope = html;
  const article =
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html) ??
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (article && article[1]!.length > 400) scope = article[1]!;

  const text = decodeEntities(
    scope
      .replace(new RegExp(`<(${DROP_TAGS})\\b[\\s\\S]*?</\\1>`, 'gi'), ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|section|li|h[1-6]|tr|blockquote|pre)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();

  const result: ExtractedPage = {
    title: titleMatch ? decodeEntities(titleMatch[1]!).trim() : '',
    text,
  };
  const description = descMatch ? decodeEntities(descMatch[1]!).trim() : '';
  if (description) result.description = description;
  return result;
}
