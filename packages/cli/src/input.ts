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
    // Pipes, sockets, and redirected files all deliver EOF. Character devices
    // (a tty, /dev/null) are either nothing to read or a wait with no end.
    return !fstatSync(0).isCharacterDevice();
  } catch {
    return false;
  }
};

export async function readStdin(): Promise<string> {
  if (!hasStdin()) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
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
    if (code !== 0) throw new PprError('EEXTERNAL', `Editor exited with code ${code}`);
    return await readFile(file, 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Multi-line terminal capture. Blank line then EOF, or Ctrl-D, ends it. */
export async function promptMultiline(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write(`${prompt}\n`);
  const lines: string[] = [];
  try {
    for await (const line of rl) lines.push(line);
  } finally {
    rl.close();
  }
  return lines.join('\n').trim();
}

/**
 * One readline for the whole process.
 *
 * Creating a fresh interface per question ends the stream on close, so a second
 * question over a pipe never resolved and the process died with an unsettled
 * promise — `ppr ai setup < answers.txt` was simply broken. Sharing one
 * interface keeps sequential prompts working whether input is typed or piped.
 */
interface LineReader {
  next(question: string): Promise<string>;
  close(): void;
}

let reader: LineReader | undefined;

function lineReader(): LineReader {
  if (reader) return reader;

  const rl: Interface = createInterface({ input: process.stdin, output: process.stderr });
  // Piped input arrives all at once: readline emits every line immediately, and
  // a line nobody happened to be awaiting is gone. So lines are queued here and
  // handed out as questions ask for them.
  const buffered: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let ended = false;

  rl.on('line', (line: string) => {
    const next = waiting.shift();
    if (next) next(line);
    else buffered.push(line);
  });
  rl.once('close', () => {
    ended = true;
    while (waiting.length) waiting.shift()!(null);
  });

  const exhausted = (question: string) =>
    new PprError('EINVALID', `No input left to answer: ${question.trim()}`);

  reader = {
    async next(question: string): Promise<string> {
      process.stderr.write(question);

      // A terminal echoes what the user types; a pipe does not, so echo it here
      // and a scripted run reads back like a typed one.
      const echo = (line: string) => {
        if (!process.stdin.isTTY) process.stderr.write(`${line}\n`);
        return line;
      };

      const ready = buffered.shift();
      if (ready !== undefined) return echo(ready);
      if (ended) throw exhausted(question);

      const line = await new Promise<string | null>((settle) => waiting.push(settle));
      if (line === null) throw exhausted(question);
      return echo(line);
    },
    close() {
      rl.close();
      reader = undefined;
    },
  };
  return reader;
}

export async function promptLine(question: string): Promise<string> {
  return (await lineReader().next(question)).trim();
}

/** Releases stdin so the process can exit. Safe to call more than once. */
export function closePrompts(): void {
  reader?.close();
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const answer = (await promptLine(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}
