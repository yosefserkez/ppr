import type { Config } from './config.js';
import { PprError } from './errors.js';
import type { AIProvider, Fetcher } from './ports.js';
import type { EntryInput } from './types.js';
import { distill, summarizePage } from './ai/tasks.js';
import { extractFromHtml, extractUrls, truncate } from './util/text.js';

export interface Page {
  url: string;
  title: string;
  text: string;
  description?: string;
}

const USER_AGENT = 'ppr/0.1 (+https://github.com/ppr-sh/ppr)';
const MAX_PAGE_BYTES = 2_000_000;

/** Default fetcher: plain `fetch`, available in Node, RN, and browsers alike. */
export const defaultFetcher: Fetcher = async (url, opts) => {
  const signal = opts?.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(20_000)])
    : AbortSignal.timeout(20_000);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain,*/*' },
    signal,
  });
  const body = truncate(await res.text(), MAX_PAGE_BYTES, '');
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body,
    url: res.url || url,
  };
};

export async function fetchPage(
  url: string,
  fetcher: Fetcher = defaultFetcher,
  opts: { signal?: AbortSignal } = {},
): Promise<Page> {
  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(url, opts);
  } catch (err) {
    throw new PprError('ENETWORK', `Could not fetch ${url}: ${(err as Error).message}`);
  }
  if (res.status >= 400) throw new PprError('ENETWORK', `${url} returned ${res.status}`);

  if (/json/.test(res.contentType)) {
    return { url: res.url, title: url, text: res.body };
  }
  if (!/html/.test(res.contentType)) {
    return { url: res.url, title: url, text: res.body };
  }
  const page = extractFromHtml(res.body);
  const out: Page = { url: res.url, title: page.title || res.url, text: page.text };
  if (page.description) out.description = page.description;
  return out;
}

export interface CaptureDeps {
  config: Config;
  provider?: AIProvider | undefined;
  fetcher?: Fetcher;
  /** Existing vault tags, so the model reuses them instead of inventing near-duplicates. */
  knownTags?: string[];
  signal?: AbortSignal;
}

const isBareUrl = (text: string): boolean => /^https?:\/\/\S+$/i.test(text.trim());

/**
 * The brain-dump pipeline: raw text in, a clean entry out.
 *
 * A dump that is nothing but a URL is a clip — no reason to make the user
 * remember which command they wanted.
 */
export async function buildDumpEntry(
  text: string,
  deps: CaptureDeps & { kind?: string; distill?: boolean; keepRaw?: boolean },
): Promise<EntryInput> {
  const source = text.trim();
  if (!source) throw new PprError('EINVALID', 'Nothing to capture');
  if (isBareUrl(source)) return buildClipEntry(source, deps);

  const shouldDistill = deps.distill ?? deps.config.capture.distill;
  const keepRaw = deps.keepRaw ?? deps.config.capture.keepRaw;

  if (!shouldDistill) {
    return { body: source, kind: deps.kind ?? 'dump' };
  }

  const result = await distill(source, {
    provider: deps.provider,
    maxTags: deps.config.capture.maxTags,
    ...(deps.config.capture.autoLink ? { link: true } : {}),
    ...(deps.knownTags?.length ? { context: deps.knownTags.slice(0, 40).join(', ') } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });

  let body = result.body;
  if (deps.config.capture.followUrls) {
    const attached = await attachLinks(source, deps);
    if (attached) body += `\n\n${attached}`;
  }
  if (keepRaw && result.ai) {
    body += `\n\n<details><summary>raw</summary>\n\n${source}\n\n</details>`;
  }

  return {
    body,
    title: result.title,
    tags: result.tags,
    kind: deps.kind ?? 'dump',
    extra: result.ai ? {} : { distilled: false },
  };
}

export async function buildClipEntry(url: string, deps: CaptureDeps): Promise<EntryInput> {
  const page = await fetchPage(url, deps.fetcher ?? defaultFetcher, deps.signal ? { signal: deps.signal } : {});
  const result = await summarizePage(page, {
    provider: deps.provider,
    maxTags: deps.config.capture.maxTags,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  return {
    body: `${result.body}\n\n[${page.title || url}](${page.url})`,
    title: result.title,
    tags: result.tags,
    kind: 'clip',
    source: page.url,
  };
}

/** Fetches URLs mentioned in a dump and appends a compact link list. */
async function attachLinks(text: string, deps: CaptureDeps): Promise<string | null> {
  const urls = extractUrls(text).slice(0, 3);
  if (!urls.length) return null;

  const lines = await Promise.all(
    urls.map(async (url) => {
      try {
        const page = await fetchPage(url, deps.fetcher ?? defaultFetcher, deps.signal ? { signal: deps.signal } : {});
        const gist = page.description || truncate(page.text, 140);
        return `- [${page.title || url}](${url})${gist ? ` — ${gist}` : ''}`;
      } catch {
        // An unreachable link is worth noting, not worth failing over.
        return `- <${url}>`;
      }
    }),
  );
  return `## Links\n${lines.join('\n')}`;
}
