/**
 * `ppr foo` runs `ppr-foo`, the way git runs `git-foo`.
 *
 * The cheapest extension point there is, and the one with no API: put an
 * executable on PATH and it is a ppr subcommand, in any language, with no
 * registration, no manifest, and no version of ppr that has to know it exists.
 * `ppr context` and `--json` are how it reads; its own arguments are how it is
 * driven.
 *
 * A built-in always wins. Shadowing `ppr ls` from PATH would mean a vault
 * behaving differently on two machines for reasons nobody can see, and the
 * point of this is to add commands rather than to redefine them.
 *
 * I11 is untouched: only a bare word ever reaches here, and a bare word was
 * never going to become an entry. What changes is that the word now has one
 * more place to be a command before it is an error.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { findVault } from '@ppr/core/node';
import type { GlobalOptions } from './context.js';

/**
 * A word that could be a ppr *subcommand*. Anything with a space is a note.
 *
 * A rule about ppr's own vocabulary rather than about what a file on disk may
 * be called, and the two are not the same question. This one guards the step
 * where a bare word somebody typed is turned into a program (`externalFor`,
 * `scanExternals`) and it is deliberate there — I11-adjacent. It has no
 * business filtering a program the user *named* out loud in a hook or a
 * `porcelain` binding: `my+notifier` is a legal filename, and answering "there
 * is nothing called my+notifier" about a file sitting on PATH is ppr enforcing
 * its own spelling on somebody else's program.
 */
const COMMAND_WORD = /^[a-z0-9][a-z0-9._-]*$/i;

const signals: Record<string, number> = osConstants.signals;

/** What an external subcommand is called on disk. */
export const externalName = (word: string): string => `ppr-${word}`;

/** A file we are allowed to run. The one predicate — see `scanExternals`. */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false; // not here, or not ours to run
  }
}

/**
 * The first executable of that name on PATH, or null.
 *
 * A *name*, because that is what PATH is a list of directories of. Anything
 * carrying a separator is a path and is `resolveCommand`'s question — the same
 * `includes('/')` test decides it there, so the two cannot disagree about which
 * of them owns a given string, and `../../thing` never becomes a lookup joined
 * onto every directory on PATH.
 *
 * What it does *not* ask is whether the name is a well-formed ppr subcommand
 * word. That check belongs to the callers that are naming a subcommand (see
 * `COMMAND_WORD`); here it would only ever answer "no such program" about a
 * program that is plainly there.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!name || name.includes('/')) return null;
  for (const dir of pathDirs(env)) {
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

const pathDirs = (env: NodeJS.ProcessEnv): string[] =>
  (env.PATH ?? '').split(delimiter).filter(Boolean);

/**
 * Where a command someone typed would actually come from.
 *
 * `findOnPath` answers for a bare name; a hook or a `--pipe` is a command line
 * the user wrote, and people write `/usr/local/bin/thing` and `./notify` as
 * readily as `ppr-notify`. Anything with a slash is a path and is checked as
 * one, because looking it up on PATH would answer "no" about a program that is
 * plainly there.
 */
export function resolveCommand(word: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!word) return null;
  if (word.includes('/')) {
    const path = resolve(word);
    return isExecutableFile(path) ? path : null;
  }
  return findOnPath(word, env);
}

/**
 * A command line somebody wrote, as words.
 *
 * Not a shell: no pipes, no substitution, no globbing, no `\` escapes. Quotes
 * are honoured and nothing else, because the one thing whitespace-splitting
 * gets silently wrong is the case people hit — `/Applications/My App/notify`,
 * or `--project "Some List"` — and passing `"Some` and `List"` as two arguments
 * is the kind of failure you debug for ten minutes rather than see.
 *
 * **A quote only quotes when it closes**, which is what makes `don't` and
 * `/Users/o'brien/bin/notify` one word each. `\` is not an escape here and is
 * not going to be: an apostrophe in a home directory is common and a backslash
 * before a space is rare, so the apostrophe is the one that has to work with no
 * ceremony at all. A lone quote is therefore an ordinary character rather than
 * an error or — as it briefly was — a licence to swallow the rest of the line.
 *
 * Literal beats throwing because of who calls this. `commandProgram` reports
 * the program at the front of a *hook*, and a hook is a shell line, where
 * `notify it\'s-here` is legal and ours is not the parser that has to
 * understand it; `ppr plugins` describing that file should name `notify`, not
 * fail. And an honestly unterminated `"/opt/my notifier --urgent` still says so
 * out loud, because the program it now names back is `"/opt/my` — the quote is
 * in the error, which is the shortest route from the message to the typo.
 *
 * That is deliberately less than `sh -c` understands. A `porcelain` binding is
 * spawned as argv rather than through a shell (see `porcelain.ts`), so `|` in
 * one is an argument, not a pipe. Somebody who wants a pipeline writes a script
 * and binds that — the same answer `$EDITOR` gives.
 */
export function splitCommandLine(line: string): string[] {
  const quotes = quotePairs(line);
  const words: string[] = [];
  let word = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (quotes.has(i)) {
      quoted = !quoted;
      // A quote is what makes `--title ""` an argument rather than nothing.
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (started) words.push(word);
      word = '';
      started = false;
      continue;
    }
    word += ch;
    started = true;
  }
  if (started) words.push(word);
  return words;
}

/**
 * Which of the quote characters in a line are quotes, by position.
 *
 * Decided before any splitting, because whether `'` opened a quoted word is a
 * fact about the *rest* of the line: in `/Users/o'brien/bin/notify` it did not,
 * and a splitter that has to find that out later has already eaten three words.
 *
 * The search resumes after an unmatched quote rather than giving up on the
 * line, which is the case worth the loop: `/Users/o'brien/bin/notify --list "My
 * List"` has an apostrophe *and* a quoted argument, and the apostrophe must not
 * cost the argument its quotes. A quote inside a matched pair is skipped whole,
 * so the `'` in `"it's fine"` is content and closes nothing.
 */
function quotePairs(line: string): Set<number> {
  const pairs = new Set<number>();
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (ch === '"' || ch === "'") {
      const close = line.indexOf(ch, i + 1);
      if (close === -1) continue; // an apostrophe, not an opening quote
      pairs.add(i);
      pairs.add(close);
      i = close;
    }
  }
  return pairs;
}

/**
 * The program at the front of a command line somebody wrote.
 *
 * A hook, a `--pipe`, a `porcelain` binding, and a `ppr plugins` row are all
 * handed a *string* rather than a name, because a configured command carries
 * its own arguments — and all of them then ask the same question of it: is the
 * thing at the front there to run? Asking it in one place is what stops the
 * answers differing. They already had: three call sites went through
 * `resolveCommand` and `schedule --pipe` through `findOnPath`, so an absolute
 * path was reported missing by one command and present by the others.
 *
 * It splits the line the same way the runner does, for the same reason: a
 * report that resolved `"My App/notify"` differently from the spawn would be
 * exactly the disagreement this function exists to prevent.
 */
export const commandProgram = (line: string): string => splitCommandLine(line)[0] ?? '';

/** A `ppr-foo` on PATH: the word that runs it, and where it came from. */
export interface ExternalCommand {
  /** What you type: `ppr <word>`. */
  word: string;
  /** What it is called on disk. */
  name: string;
  path: string;
}

/**
 * Every `ppr-*` on PATH, as `ppr plugins` reports them.
 *
 * Deduped by name with the first directory winning, because that is what the
 * shell does and what `findOnPath` above does — a listing that disagreed with
 * the dispatcher about which copy runs would be worse than no listing. A
 * built-in still wins over all of them, which `externalFor` decides and this
 * does not: the point here is to show what is installed, and something shadowed
 * by a built-in is exactly the thing worth seeing.
 */
export function scanExternals(env: NodeJS.ProcessEnv = process.env): ExternalCommand[] {
  const found = new Map<string, ExternalCommand>();
  for (const dir of pathDirs(env)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // a PATH entry that is not a directory is not an error
    }
    for (const name of names) {
      if (!name.startsWith('ppr-') || found.has(name)) continue;
      const word = name.slice('ppr-'.length);
      if (!COMMAND_WORD.test(word)) continue;
      const path = join(dir, name);
      if (isExecutableFile(path)) found.set(name, { word, name, path });
    }
  }
  return [...found.values()].sort((a, b) => a.word.localeCompare(b.word));
}

/** The binary `ppr <word>` should hand over to, if there is one. */
export function externalFor(
  word: string,
  known: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!COMMAND_WORD.test(word) || known.includes(word)) return null;
  return findOnPath(externalName(word), env);
}

/**
 * The contract an external subcommand is handed, and the reason it is
 * environment rather than argv.
 *
 * Global flags are hoisted out of argv before anything sees them (L4), so by
 * the time a word is recognised as external its `--json` is long gone. Passing
 * them back on the command line would mean every plugin having to parse ppr's
 * flags to stay out of their way; naming them in the environment says the same
 * thing and can be ignored by a plugin that does not care. `PPR_NO_AI` and
 * `NO_COLOR` already mean this everywhere else, so they keep their spellings.
 */
export function externalEnv(opts: GlobalOptions): Record<string, string> {
  const found = findVault(opts.vault ? { explicit: opts.vault } : {});
  return {
    PPR_VAULT: found.root,
    ...(opts.json ? { PPR_JSON: '1' } : {}),
    ...(opts.quiet ? { PPR_QUIET: '1' } : {}),
    ...(opts.color === false ? { NO_COLOR: '1' } : {}),
    ...(opts.ai === false ? { PPR_NO_AI: '1' } : {}),
  };
}

/**
 * Hands the terminal over and reports what came back.
 *
 * Synchronous and stdio-inherited on purpose: an external subcommand may be
 * interactive, may want a pager, and owns the terminal for as long as it runs.
 * Its exit code becomes ppr's, because to whoever typed it there was only ever
 * one command.
 */
export function runExternal(bin: string, args: string[], opts: GlobalOptions): number {
  const result = spawnSync(bin, args, {
    stdio: 'inherit',
    env: { ...process.env, ...externalEnv(opts) },
  });
  if (result.error) {
    process.stderr.write(`error ${result.error.message}\n`);
    return 6;
  }
  // A child killed by a signal has no exit code; 128+n is what a shell reports
  // for the same thing, so `ppr foo` and `ppr-foo` still agree.
  if (result.signal) return 128 + (signals[result.signal] ?? 0);
  return result.status ?? 0;
}
