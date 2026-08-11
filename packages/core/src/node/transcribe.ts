import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscribeConfig } from '../config.js';
import { PprError } from '../errors.js';
import type { AudioInput, Transcriber } from '../ports.js';
import { run, which } from './exec.js';
import { shellQuote } from './command-provider.js';

/**
 * Every audio artifact goes in its own private directory. A name built from
 * the pid and the clock is guessable, and /tmp is shared: whoever gets a
 * symlink in first at the name we are about to write has redirected the write.
 * `mkdtemp` is the one call that hands back a path nobody could have prepared,
 * and it is mode 0700, so what lands inside is nobody else's to read either.
 */
const tmpDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'ppr-'));

/** The whole directory goes, so a converter's stray sidecar files go with it. */
const discard = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

async function materialize(audio: AudioInput): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (audio.path) return { path: audio.path, cleanup: async () => {} };
  if (!audio.bytes) throw new PprError('EINVALID', 'No audio supplied');
  const dir = await tmpDir();
  const path = join(dir, `audio.${audio.mime?.includes('wav') ? 'wav' : 'm4a'}`);
  try {
    await writeFile(path, audio.bytes);
  } catch (err) {
    await discard(dir);
    throw err;
  }
  return { path, cleanup: () => discard(dir) };
}

/** whisper.cpp wants 16 kHz mono WAV; ffmpeg is only invoked when it must be. */
async function toWav16k(path: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (path.toLowerCase().endsWith('.wav')) return { path, cleanup: async () => {} };
  if (!(await which('ffmpeg'))) {
    throw new PprError(
      'EEXTERNAL',
      'ffmpeg is needed to convert audio for whisper.cpp',
      'brew install ffmpeg — or record straight to .wav',
    );
  }
  // Its own directory rather than the input's: each half has its own cleanup,
  // and removing a directory is not something to do while the other still
  // needs what is in it.
  const dir = await tmpDir();
  const out = join(dir, 'audio-16k.wav');
  // Both failures, not just the interesting one: `run` rejects when the spawn
  // itself fails — ffmpeg gone between the `which` above and here, EACCES,
  // EAGAIN under load — and nobody downstream has a handle on this directory
  // to clean it up, so a rejection that walked past here leaked one per go.
  try {
    const { code, stderr } = await run('ffmpeg', ['-nostdin', '-y', '-i', path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out]);
    if (code !== 0) {
      throw new PprError('EEXTERNAL', `ffmpeg failed: ${stderr.trim().slice(0, 300)}`);
    }
  } catch (err) {
    await discard(dir);
    throw err;
  }
  return { path: out, cleanup: () => discard(dir) };
}

function whisperCpp(cfg: TranscribeConfig): Transcriber {
  return {
    id: 'whisper-cpp',
    local: true,
    async transcribe(audio, opts) {
      const binary = cfg.binary || 'whisper-cli';
      if (!cfg.model) {
        throw new PprError(
          'ECONFIG',
          'whisper.cpp needs a model file',
          'ppr config set transcribe.model ~/models/ggml-base.en.bin',
        );
      }
      const input = await materialize(audio);
      // Nested rather than sequential: a conversion that throws must not take
      // the materialised input's directory with it into the leak pile.
      try {
        const wav = await toWav16k(input.path);
        try {
          const args = ['-m', cfg.model, '-f', wav.path, '-nt', '-np'];
          if (cfg.language) args.push('-l', cfg.language);
          const { code, stdout, stderr } = await run(binary, args, {
            timeoutMs: 600_000,
            ...(opts?.signal ? { signal: opts.signal } : {}),
          });
          if (code !== 0) throw new PprError('EEXTERNAL', stderr.trim().slice(0, 400) || `${binary} exited with ${code}`);
          return stdout.replace(/^\s*\[[^\]]*\]\s*/gm, '').trim();
        } finally {
          await wav.cleanup();
        }
      } finally {
        await input.cleanup();
      }
    },
  };
}

function openaiTranscriber(cfg: TranscribeConfig, secrets: (n: string) => string | undefined): Transcriber {
  return {
    id: 'openai',
    local: false,
    async transcribe(audio, opts) {
      const key = secrets(cfg.apiKeyEnv || 'OPENAI_API_KEY');
      if (!key) throw new PprError('ECONFIG', 'No OpenAI key for transcription', 'Run `ppr ai setup`.');
      const input = await materialize(audio);
      try {
        const bytes = await readFile(input.path);
        const form = new FormData();
        form.set('file', new Blob([new Uint8Array(bytes)]), input.path.split('/').pop() ?? 'audio.wav');
        form.set('model', cfg.model || 'whisper-1');
        if (cfg.language) form.set('language', cfg.language);

        const res = await fetch(`${cfg.baseUrl ?? 'https://api.openai.com/v1'}/audio/transcriptions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}` },
          body: form,
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        if (!res.ok) {
          throw new PprError('EAI', `Transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
        }
        const json = (await res.json()) as { text?: string };
        return (json.text ?? '').trim();
      } finally {
        await input.cleanup();
      }
    },
  };
}

/** `{file}` is replaced with the audio path; stdout is the transcript. */
function commandTranscriber(cfg: TranscribeConfig): Transcriber {
  return {
    id: 'command',
    local: true,
    async transcribe(audio, opts) {
      if (!cfg.command) throw new PprError('ECONFIG', 'No transcribe.command configured');
      const input = await materialize(audio);
      try {
        const cmd = cfg.command.replaceAll('{file}', shellQuote(input.path));
        const { code, stdout, stderr } = await run(cmd, [], {
          shell: true,
          timeoutMs: 600_000,
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        if (code !== 0) throw new PprError('EEXTERNAL', stderr.trim() || `Command exited with ${code}`);
        return stdout.trim();
      } finally {
        await input.cleanup();
      }
    },
  };
}

export function createTranscriber(
  cfg: TranscribeConfig,
  secrets: (n: string) => string | undefined,
): Transcriber | undefined {
  switch (cfg.provider) {
    case 'whisper-cpp':
      return whisperCpp(cfg);
    case 'openai':
      return openaiTranscriber(cfg, secrets);
    case 'command':
      return commandTranscriber(cfg);
    default:
      return undefined;
  }
}

export interface Recording {
  path: string;
  /** Stops the recorder and resolves once the file is closed. */
  stop(): Promise<string>;
}

/**
 * Records from the system's default input, or a device the user has chosen.
 * `sox` first (clean 16 kHz WAV, exactly what whisper wants), then ffmpeg.
 *
 * The device matters more than it looks. avfoundation index 0 is *not* the
 * microphone — it is whatever virtual device sorted first, and on any machine
 * with Zoom installed that is `ZoomAudioDevice`, which records flawless
 * silence. `default` follows the system setting, which is what a person means
 * when they say "my microphone".
 */
export async function record(opts: { device?: string } = {}): Promise<Recording> {
  const sox = await which('rec');
  const ffmpeg = sox ? null : await which('ffmpeg');

  if (!sox && !ffmpeg) {
    throw new PprError(
      'EEXTERNAL',
      'No recorder found',
      'brew install sox — or pass an existing audio file: ppr voice memo.m4a',
    );
  }

  // The recording outlives this call — a failed transcription tells the user
  // where their audio is — so the directory is deliberately not cleaned up.
  // It is created after the recorder check so a machine with neither tool
  // leaves nothing behind.
  const path = join(await tmpDir(), 'recording.wav');
  const device = opts.device?.trim() || 'default';
  const child = sox
    ? spawn('rec', ['-q', '-c', '1', '-r', '16000', '-b', '16', path], {
        stdio: 'ignore',
        // sox picks its input from the environment rather than an argument.
        env: device === 'default' ? process.env : { ...process.env, AUDIODEV: device },
      })
    : spawn(
        'ffmpeg',
        ['-nostdin', '-loglevel', 'error', '-f', inputFormat(), '-i', `:${device}`, '-ar', '16000', '-ac', '1', path],
        { stdio: 'ignore' },
      );

  const done = new Promise<void>((resolvePromise) => child.on('close', () => resolvePromise()));

  return {
    path,
    async stop() {
      child.kill('SIGINT');
      // Give the encoder a moment to flush its header before reading the file.
      await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
      return path;
    },
  };
}

const inputFormat = (): string =>
  process.platform === 'darwin' ? 'avfoundation' : process.platform === 'win32' ? 'dshow' : 'alsa';
