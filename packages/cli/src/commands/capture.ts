import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Entry, type Vault, PprError } from '@ppr/core';
import { analyzeWav, micPermission, record, responsibleApp, which } from '@ppr/core/node';
import { globals, withVault } from '../context.js';
import { confirm, promptLine, promptMultiline, resolveText } from '../input.js';
import { color, entryDetail, entryJson, json, out, errline, shortId } from '../render.js';

interface CaptureFlags {
  title?: string;
  tag?: string[];
  kind?: string;
  edit?: boolean;
  follow?: boolean;
  quiet?: boolean;
  json?: boolean;
  print?: boolean;
}

/** Every capture command ends here, so output and follow-ups behave identically. */
async function finish(vault: Vault, entry: Entry, cmd: Command, flags: CaptureFlags): Promise<Entry> {
  const g = globals(cmd);
  let result = entry;

  if (flags.follow !== false && process.stdin.isTTY && vault.hasAI && !g.json) {
    result = (await runFollowUps(vault, result)) ?? result;
  }

  if (g.json) {
    json(entryJson(result));
  } else if (g.quiet) {
    out(result.id);
  } else if (flags.print) {
    out(entryDetail(result, vault.now()));
  } else {
    errline(`${color.green('✓')} ${color.dim(shortId(result.id))} ${result.title}`);
  }
  return result;
}

/**
 * The bit that separates a journal from a text file: one sharp question about
 * what you just wrote, answered while the context is still in your head.
 */
async function runFollowUps(vault: Vault, entry: Entry): Promise<Entry | null> {
  let questions: string[];
  try {
    questions = await vault.followUps(entry.body);
  } catch {
    return null; // a model hiccup must not cost the entry
  }
  const answers: string[] = [];
  for (const question of questions.slice(0, 2)) {
    const answer = await promptLine(`${color.cyan('?')} ${question}\n  `);
    if (!answer) break;
    answers.push(`**${question}**\n\n${answer}`);
  }
  if (!answers.length) return null;
  return vault.update(entry.id, { body: `${entry.body}\n\n${answers.join('\n\n')}` });
}

const captureFlags = (cmd: Command): Command =>
  cmd
    .option('-T, --title <title>', 'set the title instead of deriving one')
    .option('-t, --tag <tag...>', 'add tags')
    .option('-e, --edit', 'compose in $EDITOR')
    .option('--no-follow', 'skip AI follow-up questions')
    .option('-p, --print', 'print the saved entry');

/** `ppr write` — a journal entry, kept in your words. */
export function writeCommand(): Command {
  const cmd = new Command('write')
    .alias('w')
    .description('write an entry (opens a prompt, or takes text/stdin)')
    .argument('[text...]', 'entry text')
    .option('-k, --kind <kind>', 'entry kind', 'log');

  captureFlags(cmd).action(async (text: string[], flags: CaptureFlags, self: Command) =>
    withVault(self, async (vault) => {
      const body = await resolveTextOrPrompt(text, flags);
      const entry = await vault.add({
        body,
        kind: flags.kind ?? vault.config.capture.defaultKind,
        ...(flags.title ? { title: flags.title } : {}),
        ...(flags.tag?.length ? { tags: flags.tag } : {}),
      });
      await finish(vault, entry, self, flags);
    }),
  );
  return cmd;
}

/** Interactive when there is nothing to read; never blocks a script. */
async function resolveTextOrPrompt(text: string[] | undefined, flags: CaptureFlags): Promise<string> {
  const hasArgs = Boolean(text?.length);
  if (!hasArgs && !flags.edit && process.stdin.isTTY) {
    const body = await promptMultiline(color.dim("What's on your mind? (Ctrl-D when done)"));
    if (!body) throw new PprError('EINVALID', 'Nothing written');
    return body;
  }
  const body = await resolveText(text, flags.edit ? { edit: true } : {});
  if (!body) throw new PprError('EINVALID', 'Nothing to save');
  return body;
}

/** `ppr dump` — messy in, clean out. */
export function dumpCommand(): Command {
  const cmd = new Command('dump')
    .alias('d')
    .description('capture a brain dump and distill it into a clean entry')
    .argument('[text...]', 'raw text (or pipe it in)')
    .option('-k, --kind <kind>', 'entry kind', 'dump')
    .option('--raw', 'skip distillation, store verbatim')
    .option('--keep-raw', 'keep the original text alongside the distilled version');

  captureFlags(cmd).action(
    async (text: string[], flags: CaptureFlags & { raw?: boolean; keepRaw?: boolean }, self: Command) =>
      withVault(self, async (vault) => {
        const body = await resolveTextOrPrompt(text, flags);
        if (!vault.hasAI && !flags.raw && !globals(self).json) {
          errline(color.dim('No AI configured — cleaning up offline. `ppr ai setup` for more.'));
        }
        const entry = await vault.dump(body, {
          kind: flags.kind ?? 'dump',
          ...(flags.raw ? { distill: false } : {}),
          ...(flags.keepRaw ? { keepRaw: true } : {}),
          ...(flags.tag?.length ? { tags: flags.tag } : {}),
        });
        const final = flags.title ? await vault.update(entry.id, { title: flags.title }) : entry;
        await finish(vault, final, self, { ...flags, follow: false });
      }),
  );
  return cmd;
}

/** `ppr clip <url>` — save what a page actually says. */
export function clipCommand(): Command {
  const cmd = new Command('clip')
    .alias('c')
    .description('fetch a URL, extract the content, and save a summary')
    .argument('<url>', 'page to clip')
    .option('-t, --tag <tag...>', 'add tags')
    .option('-p, --print', 'print the saved entry')
    .option('--no-follow', 'skip AI follow-up questions');

  cmd.action(async (url: string, flags: CaptureFlags, self: Command) =>
    withVault(self, async (vault) => {
      if (!/^https?:\/\//i.test(url)) throw new PprError('EINVALID', `Not a URL: ${url}`);
      if (!globals(self).json && !globals(self).quiet) errline(color.dim(`Fetching ${url} …`));
      const entry = await vault.clip(url, flags.tag?.length ? { tags: flags.tag } : {});
      await finish(vault, entry, self, { ...flags, follow: false });
    }),
  );
  return cmd;
}

/** `ppr voice` — speak it, keep it. */
export function voiceCommand(): Command {
  const cmd = new Command('voice')
    .alias('v')
    .description('record or transcribe audio, then distill it into an entry')
    .argument('[file]', 'existing audio file; omit to record from the microphone')
    .option('-k, --kind <kind>', 'entry kind', 'voice')
    .option('--raw', 'keep the transcript verbatim, no distillation')
    .option('--transcript-only', 'print the transcript and save nothing');

  captureFlags(cmd).action(
    async (
      file: string | undefined,
      flags: CaptureFlags & { raw?: boolean; transcriptOnly?: boolean },
      self: Command,
    ) =>
      withVault(self, async (vault) => {
        const g = globals(self);
        let path = file;

        // Preflight the whole chain before recording. Checking only the
        // provider was not enough: a missing model file surfaced *after* the
        // user had spoken, and the recording went in the bin with the error.
        await preflightVoice(vault);

        let recorded = false;
        if (!path) {
          if (!process.stdin.isTTY) throw new PprError('EINVALID', 'No audio file given');
          const device = vault.config.transcribe.device;
          const recording = await record(device ? { device } : {});
          errline(color.red('● recording') + color.dim(' — press Enter to stop'));
          await promptLine('');
          path = await recording.stop();
          recorded = true;
        }

        // Whisper hallucinates on silence rather than failing — a dead
        // microphone comes back as "you" and gets filed as a note. Measure the
        // signal instead of trusting the transcript.
        const level = await analyzeWav(path);
        if (level?.silent) {
          errline(color.yellow(`That recording is silent (${level.seconds.toFixed(1)}s, no signal).`));
          if (!recorded) throw new PprError('EINVALID', `${path} has no audible signal`);

          errline(color.dim(`Audio kept at ${path}`));
          throw new PprError('EEXTERNAL', 'The input captured nothing', await silenceHint());
        }
        if (level?.quiet && !g.quiet) {
          errline(color.dim(`Input level is low (peak ${Math.round(level.peak * 100)}%).`));
        }

        if (!g.quiet && !g.json) errline(color.dim('Transcribing …'));
        let transcript: string;
        try {
          transcript = await vault.transcribe({ path });
        } catch (err) {
          // Whatever went wrong, the audio still exists and is still theirs.
          if (recorded) {
            errline(color.yellow(`Your recording is safe at ${path}`));
            errline(color.dim(`Retry once fixed:  ppr voice ${path}`));
          }
          throw err;
        }
        transcript = transcript.replace(/\[BLANK_AUDIO\]|\(silence\)/gi, '').trim();
        if (!transcript.trim()) {
          if (recorded) errline(color.yellow(`Nothing was transcribed. Audio kept at ${path}`));
          throw new PprError('EEXTERNAL', 'Transcription came back empty');
        }

        if (flags.transcriptOnly) {
          out(transcript);
          return;
        }
        const entry = await vault.dump(transcript, {
          kind: flags.kind ?? 'voice',
          source: file ? `file:${file}` : 'microphone',
          ...(flags.raw ? { distill: false } : {}),
          ...(flags.tag?.length ? { tags: flags.tag } : {}),
        });
        await finish(vault, entry, self, { ...flags, follow: false });
      }),
  );
  return cmd;
}

/**
 * Names the likely cause of a silent recording.
 *
 * Permission is the famous one, but the common one is the device: macOS lists
 * virtual inputs (Zoom, Loopback) next to real microphones, and recording from
 * one yields perfect silence. Ask the system which it is rather than guessing.
 */
async function silenceHint(): Promise<string> {
  if (process.platform !== 'darwin') return 'Check which input device your recorder is using';
  const status = await micPermission();
  if (status === 'denied' || status === 'restricted') {
    return `Allow ${responsibleApp()} in System Settings › Privacy & Security › Microphone`;
  }
  if (status === 'notDetermined') return 'Run `ppr setup voice.permission` to ask for access';
  return 'Wrong input device — run `ppr setup voice.recorder` to pick one and test it';
}

/**
 * Everything `ppr voice` needs, checked before the microphone opens.
 * The setup command can fix any of these; the hints say so.
 */
async function preflightVoice(vault: Vault): Promise<void> {
  const { transcribe } = vault.config;
  if (transcribe.provider === 'none') {
    throw new PprError(
      'ECONFIG',
      'No transcription backend configured',
      'Run `ppr setup` to be walked through it, or: ppr config set transcribe.provider whisper-cpp',
    );
  }
  if (transcribe.provider !== 'whisper-cpp') return;

  const binary = transcribe.binary || 'whisper-cli';
  if (!(await which(binary))) {
    throw new PprError('EEXTERNAL', `${binary} is not installed`, 'Run `ppr setup`, or: brew install whisper-cpp');
  }
  if (!transcribe.model) {
    throw new PprError(
      'ECONFIG',
      'whisper.cpp needs a model file',
      'Run `ppr setup` to download one, or set transcribe.model yourself',
    );
  }
  const model = transcribe.model.startsWith('~/')
    ? join(homedir(), transcribe.model.slice(2))
    : transcribe.model;
  if (!existsSync(model)) {
    throw new PprError(
      'ECONFIG',
      `The speech model is missing: ${transcribe.model}`,
      'Run `ppr setup` to download one',
    );
  }
}

/** `ppr append` — keep a thread going without opening an editor. */
export function appendCommand(): Command {
  return new Command('append')
    .alias('a')
    .description('append text to an existing entry')
    .argument('<ref>', 'entry id, `latest`, or a title fragment')
    .argument('[text...]', 'text to append (or pipe it in)')
    .action(async (ref: string, text: string[], _flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const body = await resolveText(text);
        if (!body) throw new PprError('EINVALID', 'Nothing to append');
        const entry = await vault.append(ref, body);
        const g = globals(self);
        if (g.json) json(entryJson(entry));
        else if (g.quiet) out(entry.id);
        else errline(`${color.green('✓')} ${color.dim(shortId(entry.id))} ${entry.title}`);
      }),
    );
}

/** `ppr rm` — with a confirmation you can skip. */
export function removeCommand(): Command {
  return new Command('rm')
    .alias('delete')
    .description('delete an entry')
    .argument('<ref...>', 'entry ids, `latest`, or title fragments')
    .option('-f, --force', 'skip the confirmation')
    .action(async (refs: string[], flags: { force?: boolean }, self: Command) =>
      withVault(self, async (vault) => {
        const g = globals(self);
        const removed = [];
        for (const ref of refs) {
          const entry = vault.get(ref);
          if (!flags.force && !g.json) {
            const ok = await confirm(`Delete ${color.bold(entry.title)}?`);
            if (!ok) continue;
          }
          removed.push(await vault.remove(entry.id));
        }
        if (g.json) json(removed.map(entryJson));
        else for (const entry of removed) errline(`${color.red('✗')} ${entry.title}`);
      }),
    );
}
