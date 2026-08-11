/**
 * Downloadable models ppr knows how to fetch.
 *
 * This is data, not platform code, so every front-end offers the same choices
 * and the same URLs. How a host downloads them is its own business.
 */

export interface ModelInfo {
  id: string;
  label: string;
  /** Approximate download size in megabytes. Shown before asking to download. */
  sizeMb: number;
  url: string;
  /** Filename on disk once downloaded. */
  file: string;
  /**
   * Lowercase hex SHA-256 of the file, when it is known. Optional because a
   * digest can only be obtained by fetching gigabytes, and a wrong one is worse
   * than none — it would block a download that was fine. A host checks it when
   * it is set and downloads unverified when it is not.
   */
  sha256?: string;
  note?: string;
}

// `resolve/main` is a branch, not a version: it names whatever that ref points
// at today. That is why `sha256` exists — nothing below sets one yet, so these
// downloads are still unverified.
const WHISPER_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

const whisper = (id: string, sizeMb: number, note?: string): ModelInfo => ({
  id,
  label: `whisper ${id}`,
  sizeMb,
  url: `${WHISPER_BASE}/ggml-${id}.bin`,
  file: `ggml-${id}.bin`,
  ...(note ? { note } : {}),
});

/** Ordered smallest first: the cheapest thing that works is the right default. */
export const WHISPER_MODELS: ModelInfo[] = [
  whisper('tiny.en', 74, 'fastest, English only'),
  whisper('base.en', 141, 'good default, English only'),
  whisper('small.en', 465, 'more accurate, slower'),
  whisper('base', 141, 'multilingual'),
  whisper('small', 465, 'multilingual, more accurate'),
];

export const DEFAULT_WHISPER_MODEL = 'base.en';

export const findWhisperModel = (id: string): ModelInfo | undefined =>
  WHISPER_MODELS.find((m) => m.id === id);
