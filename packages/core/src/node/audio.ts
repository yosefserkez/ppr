import { open } from 'node:fs/promises';

/**
 * Just enough WAV parsing to answer one question: did the microphone actually
 * hear anything?
 *
 * Whisper does not fail on silence — it hallucinates. A recording of nothing
 * comes back as "you", or "Thank you.", or "[BLANK_AUDIO]", and gets filed as a
 * note. Measuring the signal is deterministic where guessing from the
 * transcript is not, and it points at the real cause: on macOS the terminal
 * needs microphone permission, and without it the recorder captures silence
 * quite happily.
 */

export interface AudioLevel {
  /** Loudest sample, 0–1. */
  peak: number;
  /** Root mean square over the file, 0–1. Better than peak for "is this speech". */
  rms: number;
  seconds: number;
  /** No signal at all: a dead or wrong input device. */
  silent: boolean;
  /** Live input, but nothing loud enough to be speech. */
  quiet: boolean;
}

/**
 * Below this RMS a recording is a room with the mic switched off, not speech.
 *
 * Calibrated against real files: a muted input measures 0.0000–0.0005, ordinary
 * speech around 0.14. The threshold sits nearer the silent end on purpose —
 * wrongly calling a soft talker silent would reject a real recording, which is
 * worse than letting one hallucinated transcript through where the user can see it.
 */
const SILENT_RMS = 0.002;
const SILENT_PEAK = 0.02;
/**
 * Between the two thresholds sits a live microphone in a quiet room: measured
 * room tone is around 0.004, speech around 0.14. Worth a warning, not a refusal.
 */
const QUIET_RMS = 0.015;
/** Enough samples for a stable measurement without reading a whole long file. */
const MAX_SAMPLES = 200_000;

export async function analyzeWav(path: string): Promise<AudioLevel | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;

  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);
    if (bytesRead < 12 || header.toString('ascii', 0, 4) !== 'RIFF') return null;
    if (header.toString('ascii', 8, 12) !== 'WAVE') return null;

    let offset = 12;
    let channels = 1;
    let sampleRate = 16_000;
    let bits = 16;
    let dataOffset = 0;
    let dataLength = 0;

    // Walk the chunk list for `fmt ` and `data`; everything else is skipped.
    const chunk = Buffer.alloc(8);
    for (;;) {
      const read = await handle.read(chunk, 0, 8, offset);
      if (read.bytesRead < 8) break;
      const id = chunk.toString('ascii', 0, 4);
      const size = chunk.readUInt32LE(4);

      if (id === 'fmt ') {
        const fmt = Buffer.alloc(Math.min(size, 16));
        await handle.read(fmt, 0, fmt.length, offset + 8);
        channels = fmt.readUInt16LE(2) || 1;
        sampleRate = fmt.readUInt32LE(4) || 16_000;
        bits = fmt.readUInt16LE(14) || 16;
      } else if (id === 'data') {
        dataOffset = offset + 8;
        dataLength = size;
        break;
      }
      offset += 8 + size + (size % 2); // chunks are word-aligned
    }

    if (!dataLength || bits !== 16) return null;

    const frames = Math.floor(dataLength / 2);
    const stride = Math.max(1, Math.floor(frames / MAX_SAMPLES));
    const buffer = Buffer.alloc(Math.min(dataLength, 1 << 20));

    let peak = 0;
    let sumSquares = 0;
    let counted = 0;
    let cursor = 0;

    while (cursor < dataLength) {
      const want = Math.min(buffer.length, dataLength - cursor);
      const { bytesRead: got } = await handle.read(buffer, 0, want, dataOffset + cursor);
      if (got <= 0) break;

      for (let i = 0; i + 1 < got; i += 2 * stride) {
        const sample = buffer.readInt16LE(i) / 32_768;
        const magnitude = Math.abs(sample);
        if (magnitude > peak) peak = magnitude;
        sumSquares += sample * sample;
        counted++;
      }
      cursor += got;
    }

    const rms = counted ? Math.sqrt(sumSquares / counted) : 0;
    return {
      peak,
      rms,
      seconds: frames / channels / sampleRate,
      silent: rms < SILENT_RMS && peak < SILENT_PEAK,
      quiet: rms < QUIET_RMS,
    };
  } finally {
    await handle.close();
  }
}
