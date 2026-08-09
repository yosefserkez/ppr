import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Entry, type Vault, parseReminder, truncate, PprError } from '@ppr/core';
import { analyzeWav, micPermission, record, responsibleApp, which } from '@ppr/core/node';
import { canPush, handToReminders, pushDecision } from '../porcelain.js';
import { dayFlag, globals, withVault } from '../context.js';
import { confirm, editorName, hasStdin, openEditor, promptLine, promptMultiline, resolveText } from '../input.js';
import { color, entryDetail, entryJson, json, out, errline, shortId } from '../render.js';

interface CaptureFlags {
  title?: string;
  tag?: string[];
  kind?: string;
  edit?: boolean;
  inline?: boolean;
  /** Resolved decision, not the raw flag — see `wantsFollowUps`. */
  follow?: boolean;
  ask?: boolean;
  quiet?: boolean;
  json?: boolean;
  print?: boolean;
}

/**
 * Whether to ask a follow-up question, decided in one place.
 *
 * By intent, not syntax. A one-liner — `ppr "shipped it"`, `ppr + shipped it` —
 * is the zero-friction path, and interrogating it every time taxes exactly the
 * thing that should have none. An interactive `ppr write` is a writing session
 * already, and one sharp question there is the point of the command.
 */
export function wantsFollowUps(opts: {
  /** `--no-follow` was passed. */
  refused?: boolean;
  /** `--ask` was passed. */
  demanded?: boolean;
  /** The text came from the compose prompt rather than the command line. */
  composed?: boolean;
}): boolean {
  if (opts.refused) return false;
  if (opts.demanded) return true;
  return Boolean(opts.composed);
}

/** Every capture command ends here, so output and follow-ups behave identically. */
async function finish(vault: Vault, entry: Entry, cmd: Command, flags: CaptureFlags): Promise<Entry> {
  const g = globals(cmd);
  let result = entry;

  if (flags.follow && process.stdin.isTTY && vault.hasAI && !g.json) {
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
    .option('-e, --edit', 'compose in $EDITOR (the default for `ppr write`)')
    .option('-i, --inline', 'compose at the terminal prompt instead of $EDITOR')
    .option('--ask', 'ask an AI follow-up question, even for a one-liner')
    .option('--no-follow', 'never ask a follow-up question')
    .option('-p, --print', 'print the saved entry');

/** `ppr write` — a journal entry, kept in your words. */
export function writeCommand(): Command {
  const cmd = new Command('write')
    .alias('w')
    // `+` is the unquoted fast path: shell-safe, and unmistakably an intent to
    // capture rather than a mistyped command. `add` and `new` are what people
    // type from muscle memory, and they used to be filed as notes saying "add".
    .alias('+')
    .alias('add')
    .alias('new')
    .description('write an entry (opens a prompt, or takes text/stdin)')
    .argument('[text...]', 'entry text')
    .option('-k, --kind <kind>', 'entry kind', 'log');

  captureFlags(cmd).action(async (text: string[], flags: CaptureFlags, self: Command) =>
    withVault(self, async (vault) => {
      // Composing is composing, whether it happened in $EDITOR or at the prompt.
      const composed = !text.length && process.stdin.isTTY;
      const willAsk =
        composed && vault.hasAI && wantsFollowUps({ refused: flags.follow === false, demanded: flags.ask, composed });
      const body = await resolveTextOrPrompt(text, flags, {
        willAsk,
        compose: vault.config.capture.compose,
      });
      const entry = await vault.add({
        body,
        kind: flags.kind ?? vault.config.capture.defaultKind,
        ...(flags.title ? { title: flags.title } : {}),
        ...(flags.tag?.length ? { tags: flags.tag } : {}),
      });
      await finish(vault, entry, self, {
        ...flags,
        follow: wantsFollowUps({ refused: flags.follow === false, demanded: flags.ask, composed }),
      });
    }),
  );
  return cmd;
}

/**
 * The quick-log path, shared with the bare `ppr "text"` form.
 *
 * It lives here rather than in the entry point so the two cannot drift: they
 * were separate implementations, and `ppr + text` asked follow-up questions
 * while `ppr "text"` did not.
 */
export async function quickLog(
  vault: Vault,
  cmd: Command,
  body: string,
  opts: { kind?: string } = {},
): Promise<Entry> {
  if (!opts.kind && TODO_PREFIX.test(body)) return todo(vault, cmd, body);
  if (!opts.kind && REMIND_PREFIX.test(body)) return remind(vault, cmd, body);
  const entry = await vault.add({ body, kind: opts.kind ?? vault.config.capture.defaultKind });
  return finish(vault, entry, cmd, { follow: false });
}

/**
 * The two things a quick capture is allowed to become other than a log.
 *
 * Fixed prefixes, never a judgement about what the text is about. "remind me"
 * and a leading "todo:" are sentences nobody writes by accident and nobody
 * writes meaning anything else — which is the only kind of signal that may
 * change what a command does (L17/I11). Everything past those words is still
 * just words.
 */
const REMIND_PREFIX = /^remind(\s+me)?\b/i;
const TODO_PREFIX = /^todo:?\s/i;

/**
 * `ppr remind` — a thing to do, on a day.
 *
 * The single implementation, so `ppr remind tomorrow call the dentist` and
 * `ppr "remind me tomorrow to call the dentist"` cannot answer differently
 * (L18). Both are the same act, and one of them being a little more explicit
 * about it is not a reason for a second code path.
 */
export async function remind(
  vault: Vault,
  cmd: Command,
  body: string,
  flags: { at?: string; print?: boolean; push?: boolean } = {},
): Promise<Entry> {
  const now = vault.now();
  // `--at` was typed on purpose, so it wins and a bad value is an error rather
  // than a fallback. Without it the words are read, and only then a model.
  const stated = flags.at ? dayFlag('--at', flags.at, now) : undefined;
  const parsed = stated ? parseReminder(body, now) : await vault.reminderFrom(body);
  const text = parsed.text || body;
  const date = stated ?? parsed.date;

  // Decided once, here, for the same reason the whole function exists: this is
  // also the path `ppr "remind me …"` takes, and a second copy of the rule is
  // a second answer waiting to happen (L18).
  const decision = pushDecision({
    configured: vault.config.remind.push,
    ...(flags.push !== undefined ? { asked: flags.push } : {}),
    dated: Boolean(date),
    available: canPush(),
  });

  if (!date) {
    // A reminder with no day never surfaces anywhere, which is the quietest
    // possible way to lose something. The words are kept as an ordinary log
    // and the difference is said out loud (I2).
    errline(
      color.yellow('No date in that — logged it instead.') +
        color.dim(`\n  To set one:  ppr remind tomorrow ${truncate(text, 40)}`),
    );
    const logged = await vault.add({ body: text, kind: vault.config.capture.defaultKind });
    const saved = await finish(vault, logged, cmd, { follow: false, ...(flags.print ? { print: true } : {}) });
    await handToReminders(vault, saved, decision);
    return saved;
  }

  const entry = await vault.addReminder(text, {
    date,
    ...(parsed.recurs ? { recurs: parsed.recurs } : {}),
  });
  const saved = await finish(vault, entry, cmd, { follow: false, ...(flags.print ? { print: true } : {}) });
  // Last, and unable to undo anything before it: the markdown is already on
  // disk, so a plugin that fails costs a copy in another app and never the
  // entry (I2's shape).
  await handToReminders(vault, saved, decision);
  return saved;
}

/** `ppr remind` — the command form of the same thing. */
export function remindCommand(): Command {
  return new Command('remind')
    .description('remind yourself of something on a day')
    .argument('[text...]', 'the day and the thing, e.g. `tomorrow call the dentist`')
    .option('--at <when>', 'the day, when it is not in the text (friday, in 3 days, 20 october)')
    .option('-p, --print', 'print the saved entry')
    // `--push` is declared first on purpose: commander gives a lone `--no-x`
    // a default of true, and this has to default to whatever config says.
    .option('--push', 'also hand it to `ppr-reminders-push` (Reminders.app by default)')
    .option('--no-push', 'keep it in the vault only')
    .addHelpText(
      'after',
      `
Examples:
  ppr remind tomorrow call the dentist
  ppr remind "next friday" review the roadmap
  ppr remind every year on 20 october call mum
  ppr remind pay the rent --at "in 3 days"
  ppr "remind me to call the dentist tomorrow"   the same thing, quoted
  ppr brief                                      what is coming up
  ppr done <ref>                                 when it is dealt with

--json gives the saved entry: the usual fields plus "date" and "recurs".
A line with no readable date is kept as a log instead — kind says which — and
the reason goes to stderr. A reminder with no day would never surface at all.

--push hands a copy to whatever \`ppr-reminders-push\` is on your PATH — the
one ppr ships creates it in Reminders.app, so the alarm arrives on your watch
rather than only in a terminal. Replace that program and --push means whatever
you replaced it with. It is one-way and never read back; the entry is written
first and stands whatever the plugin does. \`ppr config set remind.push true\`
makes it the default for every reminder, quoted ones too.`,
    )
    .action(async (text: string[], flags: { at?: string; print?: boolean; push?: boolean }, self: Command) =>
      withVault(self, async (vault) => {
        // Not `resolveText` alone: with nothing to work from it opens $EDITOR,
        // and a bare `ppr remind` is a person asking how the command works.
        const body = text.length || hasStdin() ? await resolveText(text) : '';
        if (!body) {
          throw new PprError(
            'EINVALID',
            'Nothing to be reminded about',
            'Try: ppr remind tomorrow call the dentist',
          );
        }
        await remind(vault, self, body, flags);
      }),
    );
}

/**
 * `ppr todo` — a thing to do, with no day on it.
 *
 * The single implementation, so `ppr todo buy milk` and `ppr "todo: buy milk"`
 * cannot answer differently (L18). Nothing is read out of the words: a todo is
 * dateless by definition, and a command that quietly found "friday" in "call
 * dad friday about the boat" would be inventing a deadline nobody set. `--at`
 * is how you say you meant one — and then this *is* `ppr remind`, so it hands
 * over rather than growing a second copy of the reminder path.
 */
export async function todo(
  vault: Vault,
  cmd: Command,
  body: string,
  flags: { at?: string; print?: boolean } = {},
): Promise<Entry> {
  if (flags.at) return remind(vault, cmd, body.replace(TODO_PREFIX, ''), flags);

  const text = body.replace(TODO_PREFIX, '').trim();
  if (!text) {
    throw new PprError('EINVALID', 'Nothing to do', 'Try: ppr todo buy milk');
  }
  const entry = await vault.addReminder(text);
  return finish(vault, entry, cmd, { follow: false, ...(flags.print ? { print: true } : {}) });
}

/** `ppr todo` — the command form of the same thing. */
export function todoCommand(): Command {
  return new Command('todo')
    .description('something to do, with no day on it')
    .argument('[text...]', 'the thing to do, e.g. `buy milk`')
    .option('--at <when>', 'give it a day after all — the same as `ppr remind`')
    .option('-p, --print', 'print the saved entry')
    .addHelpText(
      'after',
      `
Examples:
  ppr todo buy milk
  ppr todo chase the invoice --at friday      the same as \`ppr remind\`
  ppr "todo: buy milk"                        the same thing, quoted
  ppr todos                                   what is open
  ppr done <ref>                              when it is dealt with

A todo is a reminder with no date: same kind, same file, same \`ppr done\`. It
stays out of \`ppr brief\`, because there is nothing to count down to — \`ppr
todos\` is where it lives, and \`ppr brief\` says how many are waiting.

No date is read out of the words. If you meant one, --at says so.`,
    )
    .action(async (text: string[], flags: { at?: string; print?: boolean }, self: Command) =>
      withVault(self, async (vault) => {
        // Not `resolveText` alone: with nothing to work from it opens $EDITOR,
        // and a bare `ppr todo` is a person asking how the command works.
        const body = text.length || hasStdin() ? await resolveText(text) : '';
        if (!body) {
          throw new PprError('EINVALID', 'Nothing to do', 'Try: ppr todo buy milk');
        }
        await todo(vault, self, body, flags);
      }),
    );
}

/** `ppr done` — a reminder dealt with. */
export function doneCommand(): Command {
  return new Command('done')
    .alias('complete')
    .description('mark a reminder dealt with, so it stops coming up')
    .argument('<ref...>', 'entry ids, `latest`, or title fragments')
    .action(async (refs: string[], _flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const g = globals(self);
        const completed: Entry[] = [];
        for (const ref of refs) completed.push(await vault.complete(ref));

        if (g.json) return json(completed.map(entryJson));
        if (g.quiet) return void out(completed.map((e) => e.id).join('\n'));
        for (const entry of completed) errline(`${color.green('✓')} ${entry.title}`);
        // No confirmation to give, and none needed: nothing was deleted.
        errline(color.dim('  The file stays — `status: done` is one line of frontmatter.'));
      }),
    );
}

/**
 * Where a longer entry gets composed.
 *
 * $EDITOR by default, because moving around and editing text is a solved
 * problem and the solution is already open on your machine. Rebuilding cursor
 * movement, wrapping, and undo inside a note tool would be a worse version of
 * something you know better than we could teach. `--inline` keeps the terminal
 * prompt for a couple of quick lines, and is the automatic fallback when no
 * editor will start.
 */
async function resolveTextOrPrompt(
  text: string[] | undefined,
  flags: CaptureFlags,
  session: { willAsk?: boolean; compose?: 'editor' | 'inline' } = {},
): Promise<string> {
  const hasArgs = Boolean(text?.length);
  const useEditor = flags.edit || (!flags.inline && session.compose !== 'inline');

  if (!hasArgs && process.stdin.isTTY && useEditor) {
    errline(color.dim(`Opening ${editorName()} — save and quit to keep it, quit without saving to discard.`));
    let written: string;
    try {
      written = await openEditor();
    } catch (err) {
      // A missing or broken editor should cost you the note, not the session.
      if (flags.edit) throw err;
      errline(color.yellow(`${(err as Error).message} — falling back to the inline prompt.`));
      return composeInline(session);
    }
    const body = written.trim();
    if (!body) throw new PprError('EINVALID', 'Nothing written — the editor buffer was empty');
    return body;
  }

  if (!hasArgs && process.stdin.isTTY) return composeInline(session);

  const body = await resolveText(text, flags.edit ? { edit: true } : {});
  if (!body) throw new PprError('EINVALID', 'Nothing to save');
  return body;
}

async function composeInline(session: { willAsk?: boolean }): Promise<string> {
  const body = await promptMultiline(color.bold("What's on your mind?"), [
    'empty line or ctrl-d to save · ctrl-c to discard',
    ...(session.willAsk ? ['ppr will ask a question or two when you finish'] : []),
  ]);
  if (!body) throw new PprError('EINVALID', 'Nothing written');
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
    .alias('remove')
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
