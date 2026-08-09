import type { Command } from 'commander';
import { type Vault, type ListQuery, asDay, futureWhen, parseWhen, PprError } from '@ppr/core';
import { openVault } from '@ppr/core/node';
import { drainChildren } from './child.js';
import { hookRunner, loadHooks } from './hooks.js';
import { setColor } from './render.js';

export interface GlobalOptions {
  vault?: string;
  json?: boolean;
  color?: boolean;
  ai?: boolean;
  quiet?: boolean;
}

let hoisted: GlobalOptions = {};

/**
 * Pulls the global flags out of argv before commander sees them.
 *
 * Commander scopes options to the command they follow, which would mean
 * `ppr ls --json` and `ppr --json ls` behaving differently. For a CLI whose
 * whole point is composing with other tools, `--json` has to work wherever you
 * happen to type it.
 */
export function hoistGlobals(argv: string[]): string[] {
  const rest: string[] = [];
  const opts: GlobalOptions = {};
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (passthrough) {
      rest.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      rest.push(arg);
      continue;
    }
    switch (true) {
      case arg === '--json':
        opts.json = true;
        continue;
      case arg === '-q' || arg === '--quiet':
        opts.quiet = true;
        continue;
      case arg === '--no-color':
        opts.color = false;
        continue;
      case arg === '--color':
        opts.color = true;
        continue;
      case arg === '--no-ai':
        opts.ai = false;
        continue;
      case arg === '--vault': {
        const dir = argv[++i];
        if (!dir || dir.startsWith('-')) {
          throw new PprError('EINVALID', '--vault needs a directory', 'Example: ppr --vault ~/work-journal ls');
        }
        opts.vault = dir;
        continue;
      }
      case arg.startsWith('--vault='):
        opts.vault = arg.slice('--vault='.length);
        continue;
      default:
        rest.push(arg);
    }
  }
  hoisted = opts;
  return rest;
}

/** Global flags, wherever they appeared on the line. */
export function globals(_cmd?: Command): GlobalOptions {
  return hoisted;
}

/**
 * Opens the vault for a command. Commands never construct a Vault themselves,
 * so `--vault` and `--no-ai` behave identically everywhere.
 *
 * This is also where ppr's push surface is wired: hooks listen to the vault's
 * events, and `drainChildren()` in the `finally` is the one bounded wait for
 * everything they, and the plugin-backed flags, started. Both are no-ops when
 * nothing is configured, which is the usual case.
 */
export async function withVault<T>(_cmd: Command, fn: (vault: Vault) => Promise<T>): Promise<T> {
  const opts = globals();
  setColor(opts.color !== false && !opts.json);
  const onEvent = hookRunner(await loadHooks());
  const vault = await openVault({
    ...(opts.vault ? { vault: opts.vault } : {}),
    ...(opts.ai === false ? { noAI: true } : {}),
    ...(onEvent ? { onEvent } : {}),
  });
  try {
    return await fn(vault);
  } finally {
    await vault.close();
    await drainChildren();
  }
}

export interface FilterFlags {
  since?: string;
  until?: string;
  tag?: string[];
  kind?: string[];
  limit?: string;
  all?: boolean;
  pinned?: boolean;
  reverse?: boolean;
}

/** Turns the shared `--since/--tag/--kind/--limit` flags into a core query. */
export function toQuery(flags: FilterFlags, fallbackLimit: number, now: Date): ListQuery {
  const query: ListQuery = {};
  if (flags.since) {
    const since = parseWhen(flags.since, now);
    if (!since) throw new PprError('EINVALID', `Could not understand --since "${flags.since}"`, 'Try: 7d, today, yesterday, 2026-07-01');
    query.since = since;
  }
  if (flags.until) {
    const until = parseWhen(flags.until, now);
    if (!until) throw new PprError('EINVALID', `Could not understand --until "${flags.until}"`);
    query.until = until;
  }
  if (flags.tag?.length) query.tag = flags.tag;
  if (flags.kind?.length) query.kind = flags.kind;
  if (flags.pinned) query.pinned = true;
  if (flags.reverse) query.order = 'asc';
  if (!flags.all) query.limit = flags.limit ? Number(flags.limit) : fallbackLimit;
  if (query.limit !== undefined && !Number.isFinite(query.limit)) {
    throw new PprError('EINVALID', `--limit must be a number`);
  }
  return query;
}

/**
 * A calendar day from a flag someone typed, or an error naming what works.
 *
 * Forward-looking, unlike `--since`: every flag that reaches here is about
 * something still to come. A flag the user spelled out is refused rather than
 * fallen back on — they said which day they meant, and quietly storing a
 * different one, or none, is worse than saying it was not understood.
 */
export function dayFlag(flag: string, value: string, now: Date): string {
  const when = futureWhen(value, now);
  const day = when && asDay(when);
  if (!day) {
    throw new PprError(
      'EINVALID',
      `Could not understand ${flag} "${value}"`,
      'Try: tomorrow, friday, in 3 days, 20 october, 2026-10-20',
    );
  }
  return day;
}

/** Attaches the filter flag set to a command. One definition, used everywhere. */
export function filterFlags(cmd: Command): Command {
  return cmd
    .option('-s, --since <when>', 'only entries after this point (7d, today, 2026-07-01)')
    .option('-u, --until <when>', 'only entries before this point')
    .option('-t, --tag <tag...>', 'filter by tag (repeatable, AND)')
    .option('-k, --kind <kind...>', 'filter by kind: log, note, dump, clip, voice, reminder, memory')
    .option('-n, --limit <n>', 'maximum entries')
    .option('-a, --all', 'no limit')
    .option('--pinned', 'only pinned entries')
    .option('-r, --reverse', 'oldest first');
}
