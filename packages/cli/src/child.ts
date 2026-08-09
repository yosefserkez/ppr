/**
 * The one way ppr runs somebody else's program.
 *
 * Hooks and the built-in flags that reach for a plugin (`--notify`, `--push`)
 * both come through here, so there is exactly one answer to "what happens when
 * it is missing / slow / broken", and the answer is the same one the whole
 * tool gives: the vault write already happened, and nothing out here may cost
 * it (I2's shape).
 *
 * Three rules:
 *
 * **Nothing it does reaches stdout.** A hook printing a banner must not end up
 * inside `ppr ls --json` (I10), so its stdout is discarded and its stderr comes
 * back as one summarised line for the caller to print.
 *
 * **It never throws.** A missing binary, a non-zero exit, a crash — all of them
 * resolve to `{ ok: false, hint }`, the same shape the rest of the CLI reports
 * with.
 *
 * **The wait is bounded, and it is a wait rather than a leash.** A command that
 * has finished its own work does not sit there while a courier finishes:
 * `drainChildren()` waits a couple of seconds and then lets go, leaving the
 * child to run on. Killing it would be worse — the copy it was halfway through
 * making is the whole reason it was started.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { color, errline } from './render.js';

/**
 * How long a command waits, at the very end, for children it started.
 *
 * Two seconds is under the threshold where a person decides a command has
 * hung, and every consumer worth having is finished long before it: posting a
 * notification takes milliseconds. The slow case — a plugin waking a cold
 * application that then waits on a sync service, which is what justified a
 * twenty-second timeout when this code lived inside ppr — is exactly the one
 * where waiting longer helps nobody, because the answer is going to be "fine"
 * either way. So ppr stops waiting and says so, and the child carries on.
 */
const DRAIN_MS = 2000;

export interface ChildResult {
  ok: boolean;
  /**
   * The first line the child said on stderr, whether or not it succeeded.
   *
   * Success is not silence. A courier that cannot deliver — `ppr-notify` on
   * Linux — is supposed to say so and exit 0, and swallowing that would leave
   * the user told the copy was made. Every caller passes it on.
   */
  said?: string;
  /** Why it failed, in one line. Absent when it worked. */
  hint?: string;
}

export interface ChildOptions {
  args?: string[];
  /** Written to the child's stdin, then closed. */
  input?: string;
  /** Added to the inherited environment. */
  env?: Record<string, string>;
  /**
   * Run the command through `sh -c`, so a configured string can carry its own
   * arguments and pipes. Only for commands that came from the user's own
   * config file — never for anything read out of a vault (see `hooks.ts`).
   */
  shell?: boolean;
}

const running = new Map<ChildProcess, Promise<ChildResult>>();

/** Runs a program and reports how it went. Never throws, never blocks stdout. */
export function runChild(command: string, opts: ChildOptions = {}): Promise<ChildResult> {
  let child: ChildProcess;
  try {
    child = spawn(command, opts.args ?? [], {
      shell: opts.shell ?? false,
      // Discard stdout: a consumer's chatter is not ppr's output (I10).
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, ...opts.env },
    });
  } catch (err) {
    return Promise.resolve({ ok: false, hint: (err as Error).message });
  }

  const promise = new Promise<ChildResult>((resolve) => {
    const done = (result: ChildResult) => {
      running.delete(child);
      resolve(result);
    };
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err: NodeJS.ErrnoException) =>
      done({ ok: false, hint: err.code === 'ENOENT' ? `${command} is not on your PATH` : err.message }),
    );
    child.on('close', (code) => {
      const said = firstLine(stderr);
      done({
        ok: code === 0,
        ...(said ? { said } : {}),
        ...(code === 0 ? {} : { hint: said || `exited with ${code}` }),
      });
    });
    // A consumer that never reads its stdin is a normal consumer, not a broken
    // one — and an unhandled EPIPE here would take the whole command down.
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input ?? '');
  });

  running.set(child, promise);
  return promise;
}

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? '';

const unref = (stream: unknown): void => {
  (stream as { unref?: () => void } | null | undefined)?.unref?.();
};

/**
 * Waits briefly for anything still running, then lets go.
 *
 * Unref rather than kill: by the time this runs the vault write is long done,
 * and a courier interrupted halfway through is a copy that exists nowhere.
 * Unrefing the handles is what lets node exit while it finishes.
 */
export async function drainChildren(): Promise<void> {
  if (!running.size) return;
  const timer = new Promise<false>((resolve) => setTimeout(() => resolve(false), DRAIN_MS).unref());
  const finished = Promise.allSettled([...running.values()]).then(() => true as const);

  if (await Promise.race([finished, timer])) return;

  const left = [...running.keys()];
  errline(
    color.dim(
      `${left.length} background ${left.length === 1 ? 'command is' : 'commands are'} still running — not waiting for ${left.length === 1 ? 'it' : 'them'}.`,
    ),
  );
  for (const child of left) {
    child.unref();
    // The pipes are separate handles from the process, and any one of them
    // still referenced keeps node's loop alive — which would be the hang this
    // whole function exists to prevent (I6's shape). Typed as plain streams,
    // a socket underneath.
    unref(child.stdin);
    unref(child.stderr);
  }
  running.clear();
}
