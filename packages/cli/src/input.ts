import { spawn } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { PprError } from '@ppr/core';

/**
 * True only when stdin is a real pipe or redirected file.
 *
 * `!isTTY` is not enough: a process launched by a daemon, a test runner, or an
 * editor plugin inherits a stdin that reports non-TTY but never reaches EOF,
 * and ppr would hang there forever waiting for input nobody is sending.
 */
export const hasStdin = (): boolean => {
  if (process.stdin.isTTY) return false;
  try {
    // Pipes, sockets, and redirected files carry input. Character devices
    // (a tty, /dev/null) are either nothing to read or a wait with no end.
    return !fstatSync(0).isCharacterDevice();
  } catch {
    return false;
  }
};

/** A socket inherited from a long-lived parent may never send or close. */
const inheritedSocket = (): boolean => {
  try {
    return fstatSync(0).isSocket();
  } catch {
    return false;
  }
};

/** Long enough for any parent that means to write, short enough not to feel stuck. */
const FIRST_BYTE_MS = 2000;

/**
 * Reads piped input.
 *
 * A `|` or `<` always ends, so those are read to EOF with no deadline — cutting
 * a slow producer short would lose someone's text. An inherited socket is
 * different: an editor plugin or a supervisor can hand over a stdin that never
 * sends a byte and never closes, and waiting on it forever is the hang that
 * invariant I6 exists to prevent. So only sockets get a deadline, and only on
 * the *first* byte; once input starts arriving it is read to completion.
 */
export async function readStdin(): Promise<string> {
  if (!hasStdin()) return '';
  const stream = process.stdin;
  const chunks: Buffer[] = [];

  if (inheritedSocket()) {
    const started = await new Promise<boolean>((settle) => {
      const timer = setTimeout(() => finish(false), FIRST_BYTE_MS);
      const finish = (value: boolean) => {
        clearTimeout(timer);
        stream.off('readable', onReadable);
        stream.off('end', onEnd);
        settle(value);
      };
      const onReadable = () => finish(true);
      const onEnd = () => finish(false);
      stream.once('readable', onReadable);
      stream.once('end', onEnd);
    });
    if (!started) {
      // Give the descriptor back, or the event loop stays alive on a stream
      // nobody is writing to and the process never exits.
      stream.pause();
      (stream as unknown as { unref?: () => void }).unref?.();
      return '';
    }
  }

  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Text for a command, from wherever it is: arguments, a pipe, or the editor.
 * This is what makes every capture command work the same way.
 */
export async function resolveText(
  args: string[] | undefined,
  opts: { edit?: boolean; template?: string } = {},
): Promise<string> {
  const inline = (args ?? []).join(' ').trim();
  if (inline && !opts.edit) return inline;
  if (!inline && hasStdin()) {
    const piped = (await readStdin()).trim();
    if (piped) return piped;
  }
  return (await openEditor(inline || opts.template || '')).trim();
}

/**
 * Opens an existing file in $EDITOR. Used for entries, which are edited in
 * place — the promise is that these are just markdown files, and editing a
 * temp copy would quietly discard any frontmatter the user changed.
 */
export function spawnEditorOn(file: string): Promise<number> {
  const [cmd, ...args] = editorCommand().split(/\s+/);
  return new Promise<number>((resolvePromise, reject) => {
    const child = spawn(cmd!, [...args, file], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise(code ?? 0));
  });
}

const editorCommand = (): string =>
  process.env.PPR_EDITOR || process.env.VISUAL || process.env.EDITOR || 'vi';

/** The editor ppr will launch, for messages. */
export const editorName = (): string => editorCommand().split(/\s+/)[0]!;

/**
 * Composes an entry in $EDITOR.
 *
 * The buffer is a plain, empty `.md` file — no commented instructions, because
 * `#` starts a tag in ppr and a git-style comment block would either eat them
 * or teach the wrong thing. Quitting without saving leaves it empty, which is
 * how you cancel.
 */
export async function openEditor(initial = '', extension = 'md'): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new PprError('EINVALID', 'No text given and no terminal to open an editor in');
  }
  const dir = await mkdtemp(join(tmpdir(), 'ppr-'));
  const file = join(dir, `entry.${extension}`);
  await writeFile(file, initial);
  try {
    const [cmd, ...args] = editorCommand().split(/\s+/);
    const code = await new Promise<number>((resolvePromise, reject) => {
      const child = spawn(cmd!, [...args, file], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (c) => resolvePromise(c ?? 0));
    });
    if (code !== 0) {
      throw new PprError(
        'EEXTERNAL',
        `${cmd} exited with code ${code}`,
        'Nothing was saved. Set a different editor with $EDITOR or $PPR_EDITOR.',
      );
    }
    return await readFile(file, 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Multi-line capture with a visible boundary.
 *
 * Every line is prefixed with a gutter, so it is never in doubt that you are
 * typing into ppr rather than into your shell — a stray apostrophe leaves zsh
 * showing its own `quote>` prompt, and the two should not look alike. Finishing
 * is an empty line as well as Ctrl-D, because an invisible keystroke is not an
 * exit anyone can find. `--edit` opens $EDITOR for anything with paragraphs.
 */
export async function promptMultiline(title: string, hints: string[] = []): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: DIM_GUTTER,
  });

  process.stderr.write(`${title}\n`);
  for (const hint of hints) process.stderr.write(`${DIM_HINT(hint)}\n`);

  const lines: string[] = [];
  try {
    rl.prompt();
    for await (const line of rl) {
      // A blank line ends the entry once there is something to end.
      if (!line.trim() && lines.length) break;
      lines.push(line);
      rl.prompt();
    }
  } finally {
    rl.close();
  }
  return lines.join('\n').trim();
}

const DIM_GUTTER = '\x1b[2m│\x1b[22m ';
const DIM_HINT = (text: string): string => `\x1b[2m${text}\x1b[22m`;

/**
 * One readline for the whole process.
 *
 * Creating a fresh interface per question ends the stream on close, so a second
 * question over a pipe never resolved and the process died with an unsettled
 * promise — `ppr ai setup < answers.txt` was simply broken. Sharing one
 * interface keeps sequential prompts working whether input is typed or piped.
 */
// Queued outside the readline instance, so the interface can be detached and
// rebuilt (see `detachLineInput`) without losing answers already typed.
const buffered: string[] = [];
const waiting: Array<(line: string | null) => void> = [];
let rl: Interface | undefined;
let stdinEnded = false;
let detaching = false;

function attach(): Interface {
  if (rl) return rl;
  rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on('line', (line: string) => {
    const next = waiting.shift();
    if (next) next(line);
    else buffered.push(line);
  });
  rl.once('close', () => {
    rl = undefined;
    // Closing to hand stdin over is not the same as stdin running out.
    if (detaching) return;
    stdinEnded = true;
    while (waiting.length) waiting.shift()!(null);
  });
  return rl;
}

/**
 * Gives up stdin so a raw-mode prompt can own it.
 *
 * Exactly one consumer may read stdin at a time. A readline interface left
 * attached while `Keyboard` is in raw mode means every keystroke is delivered
 * twice — once as a line, once as a keypress — and both prompts react.
 */
export function detachLineInput(): void {
  if (!rl) return;
  detaching = true;
  rl.close();
  detaching = false;
  rl = undefined;
}

export async function promptLine(question: string): Promise<string> {
  process.stderr.write(question);

  // A terminal echoes what the user types; a pipe does not, so echo it here and
  // a scripted run reads back like a typed one.
  const echo = (line: string) => {
    if (!process.stdin.isTTY) process.stderr.write(`${line}\n`);
    return line.trim();
  };
  const exhausted = () =>
    new PprError('EINVALID', `No input left to answer: ${question.trim()}`);

  const ready = buffered.shift();
  if (ready !== undefined) return echo(ready);
  if (stdinEnded) throw exhausted();

  attach();
  const line = await new Promise<string | null>((settle) => waiting.push(settle));
  if (line === null) throw exhausted();
  return echo(line);
}

/** Releases stdin so the process can exit. Safe to call more than once. */
export function closePrompts(): void {
  detachLineInput();
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const answer = (await promptLine(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}
