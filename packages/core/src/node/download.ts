import { createWriteStream } from 'node:fs';
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
}

/**
 * Downloads to a temp file and renames on success, so an interrupted download
 * never leaves a half-written model that looks complete.
 */
export async function downloadFile(
  url: string,
  destination: string,
  opts: DownloadOptions = {},
): Promise<{ path: string; bytes: number; skipped: boolean }> {
  const existing = await stat(destination).catch(() => null);
  if (existing?.isFile() && opts.skipExisting !== false) {
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

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    opts.onProgress?.({ received, total, fraction: total ? received / total : null });
  });

  try {
    await pipeline(source, createWriteStream(temp));
    await rename(temp, destination);
  } catch (err) {
    await rm(temp, { force: true });
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
