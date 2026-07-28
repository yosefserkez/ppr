import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeWav } from '../dist/node.js';

/** Builds a 16-bit mono PCM WAV in memory, so the suite needs no ffmpeg. */
function wav(samples, sampleRate = 16_000) {
  const data = Buffer.alloc(samples.length * 2);
  for (const [i, sample] of samples.entries()) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const tone = (seconds, amplitude, rate = 16_000) =>
  Array.from({ length: seconds * rate }, (_, i) => amplitude * Math.sin((2 * Math.PI * 220 * i) / rate));

async function withFile(bytes, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ppr-audio-'));
  const path = join(dir, 'test.wav');
  try {
    await writeFile(path, bytes);
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a recording with speech-level signal is not silent', async () => {
  const level = await withFile(wav(tone(2, 0.3)), analyzeWav);
  assert.equal(level.silent, false);
  assert.ok(level.peak > 0.25 && level.peak <= 0.31);
  assert.ok(level.rms > 0.1);
  assert.ok(Math.abs(level.seconds - 2) < 0.01);
});

test('digital silence is reported as silent', async () => {
  const level = await withFile(wav(new Array(16_000).fill(0)), analyzeWav);
  assert.equal(level.silent, true);
  assert.equal(level.peak, 0);
  assert.equal(level.rms, 0);
});

test('a muted microphone — signal far below speech — is silent', async () => {
  // The case that matters: the recorder "works", captures nothing audible, and
  // whisper hallucinates a word like "you" from it. Measured against real
  // files, a muted input lands at or under 0.0005 rms; speech is around 0.14.
  const level = await withFile(wav(tone(3, 0.001)), analyzeWav);
  assert.equal(level.silent, true);
  assert.ok(level.rms < 0.001);
});

test('quiet but real speech is not mistaken for silence', async () => {
  const level = await withFile(wav(tone(3, 0.05)), analyzeWav);
  assert.equal(level.silent, false, 'a soft talker must still be transcribed');
});

test('a non-WAV file is unreadable rather than wrongly silent', async () => {
  const level = await withFile(Buffer.from('this is not audio at all'), analyzeWav);
  assert.equal(level, null, 'null means "cannot tell", which callers treat as fine');
});

test('a missing file returns null instead of throwing', async () => {
  assert.equal(await analyzeWav('/nonexistent/nope.wav'), null);
});
