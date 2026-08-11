import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PprError } from '../errors.js';

/** Models are expensive to refetch, so they live in the data dir, not the cache. */
export const modelsDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'ppr', 'models');

export interface DownloadProgress {
  received: number;
  total: number;
  /** 0–1, or null when the server did not send a length. */
  fraction: number | null;
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Return the existing file untouched if it is already there. Default true. */
  skipExisting?: boolean;
  /**
   * Expected SHA-256 of the bytes, lowercase hex. A model URL is a mutable ref
   * on somebody else's server, so "the file at this address" is not a
   * description of any particular bytes. When a digest is declared nothing is
   * allowed under the real filename until the bytes match it.
   */
  sha256?: string;
}

/** Streamed, because a model is gigabytes and reading it into memory is not. */
async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const digestMismatch = (what: string, expected: string, actual: string, hint: string): PprError =>
  new PprError(
    'ENETWORK',
    `Checksum mismatch for ${what}: expected sha256 ${expected}, got ${actual}`,
    hint,
  );

/**
 * Downloads to a temp file and renames on success, so an interrupted download
 * never leaves a half-written model that looks complete.
 */
export async function downloadFile(
  url: string,
  destination: string,
  opts: DownloadOptions = {},
): Promise<{ path: string; bytes: number; skipped: boolean }> {
  const expected = opts.sha256?.trim().toLowerCase();
  const existing = await stat(destination).catch(() => null);
  if (existing?.isFile() && opts.skipExisting !== false) {
    // A file that is already there is exactly the one the check exists for:
    // skipping it unverified means one bad download is trusted forever.
    if (expected) {
      const actual = await fileDigest(destination);
      if (actual !== expected) {
        throw digestMismatch(
          destination,
          expected,
          actual,
          'That file is not the one ppr expects. Delete it and run this again to re-download.',
        );
      }
    }
    return { path: destination, bytes: existing.size, skipped: true };
  }

  await mkdir(dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.part`;

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    throw new PprError('ENETWORK', `Could not reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  if (!response.ok || !response.body) {
    throw new PprError('ENETWORK', `Download failed (${response.status}): ${url}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  let received = 0;

  const hash = expected ? createHash('sha256') : null;
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    hash?.update(chunk);
    opts.onProgress?.({ received, total, fraction: total ? received / total : null });
  });

  try {
    await pipeline(source, createWriteStream(temp));
    // Before the rename, because the rename is what makes the bytes real: a
    // model that failed its digest must never exist under a name whisper.cpp
    // would load.
    if (hash && expected) {
      const actual = hash.digest('hex');
      if (actual !== expected) {
        throw digestMismatch(
          url,
          expected,
          actual,
          'Nothing was installed. If this keeps happening the file has been republished and the digest ppr carries is stale.',
        );
      }
    }
    await rename(temp, destination);
  } catch (err) {
    await rm(temp, { force: true });
    if (err instanceof PprError) throw err;
    throw new PprError('ENETWORK', `Download failed: ${(err as Error).message}`);
  }
  return { path: destination, bytes: received, skipped: false };
}

export const formatBytes = (bytes: number): string => {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${Math.round(bytes / 1_048_576)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};
