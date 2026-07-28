import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscribeConfig } from '../config.js';
import { PprError } from '../errors.js';
import type { AudioInput, Transcriber } from '../ports.js';
import { run, which } from './exec.js';
import { shellQuote } from './command-provider.js';

const tmpFile = (ext: string): string => join(tmpdir(), `ppr-${process.pid}-${Date.now()}.${ext}`);

async function materialize(audio: AudioInput): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (audio.path) return { path: audio.path, cleanup: async () => {} };
  if (!audio.bytes) throw new PprError('EINVALID', 'No audio supplied');
  const path = tmpFile(audio.mime?.includes('wav') ? 'wav' : 'm4a');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, audio.bytes);
  return { path, cleanup: () => rm(path, { force: true }) };
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
  const out = tmpFile('wav');
  const { code, stderr } = await run('ffmpeg', ['-nostdin', '-y', '-i', path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out]);
  if (code !== 0) throw new PprError('EEXTERNAL', `ffmpeg failed: ${stderr.trim().slice(0, 300)}`);
  return { path: out, cleanup: () => rm(out, { force: true }) };
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
 * Records from the default input device using whatever the machine already has.
 * `sox` first (clean 16 kHz WAV, exactly what whisper wants), then ffmpeg.
 */
export async function record(): Promise<Recording> {
  const path = tmpFile('wav');
  const sox = await which('rec');
  const ffmpeg = sox ? null : await which('ffmpeg');

  if (!sox && !ffmpeg) {
    throw new PprError(
      'EEXTERNAL',
      'No recorder found',
      'brew install sox — or pass an existing audio file: ppr voice memo.m4a',
    );
  }

  const child = sox
    ? spawn('rec', ['-q', '-c', '1', '-r', '16000', '-b', '16', path], { stdio: 'ignore' })
    : spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', inputFormat(), '-i', ':0', '-ar', '16000', '-ac', '1', path], {
        stdio: 'ignore',
      });

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
