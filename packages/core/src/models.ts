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
  note?: string;
}

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
