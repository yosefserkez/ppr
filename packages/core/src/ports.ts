/**
 * Ports: the only ways core touches the outside world.
 *
 * Core never imports `node:fs`, `node:child_process`, or any platform API.
 * Every host (CLI, mobile, web, a test) supplies these. That is what makes a
 * second front-end a wiring exercise rather than a rewrite.
 */

export interface FileStat {
  /** Vault-relative, POSIX-separated. */
  path: string;
  size: number;
  /** Epoch millis. */
  mtime: number;
}

/** A flat key/value blob store keyed by vault-relative path. */
export interface Storage {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Recursive listing of everything under `prefix` (a directory path, no trailing slash). */
  list(prefix: string): Promise<FileStat[]>;
  stat(path: string): Promise<FileStat | null>;
  /** Optional: move a file. Falls back to read+write+remove when absent. */
  move?(from: string, to: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface GenerateRequest {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for raw JSON. Providers that cannot enforce it still get told in the prompt. */
  json?: boolean;
  signal?: AbortSignal;
}

/** A text-in/text-out model. Deliberately the smallest useful surface. */
export interface AIProvider {
  /** Provider id, e.g. `anthropic`, `ollama`, `apple`. */
  readonly id: string;
  readonly model: string;
  /** True when the provider runs on-device and sends nothing over the network. */
  readonly local: boolean;
  generate(req: GenerateRequest): Promise<string>;
}

export interface AudioInput {
  /** Absolute path on hosts that have a filesystem. */
  path?: string;
  bytes?: Uint8Array;
  mime?: string;
}

export interface Transcriber {
  readonly id: string;
  readonly local: boolean;
  transcribe(audio: AudioInput, opts?: { signal?: AbortSignal }): Promise<string>;
}

/** Fetches a URL and returns raw content. Hosts may proxy, cache, or sandbox this. */
export interface Fetcher {
  (url: string, opts?: { signal?: AbortSignal }): Promise<{
    status: number;
    contentType: string;
    body: string;
    url: string;
  }>;
}
