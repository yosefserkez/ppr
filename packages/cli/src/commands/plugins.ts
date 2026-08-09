import { Command } from 'commander';
import { EVENT_NAMES } from '@ppr/core';
import { findVault, loadConfig } from '@ppr/core/node';
import { globals } from '../context.js';
import { resolveCommand, scanExternals } from '../external.js';
import { loadHooks } from '../hooks.js';
import { NOTIFY_PLUGIN, PUSH_PLUGIN } from '../porcelain.js';
import { color, json, out, table } from '../render.js';

/**
 * `ppr plugins` — who hears what, and where would things go.
 *
 * ppr's extension surface is deliberately made of conventions rather than
 * registrations: a name on PATH, an event name in a config file, a `plugins.`
 * key nobody validates. That is what makes it cost nothing to build on, and it
 * is also why there is no list anywhere of what is currently wired up. This is
 * that list, computed from the machine every time — not a registry, because a
 * registry would be a second source of truth and the first one would be wrong.
 *
 * Four questions, in the order somebody debugging asks them:
 *
 *   events    what runs when ppr writes something
 *   intents   what `--push` and `--notify` currently mean
 *   commands  which `ppr-foo` words exist
 *   settings  which `plugins.<name>` sections are configured
 *
 * It needs no vault. Everything above is a fact about the user's machine, and
 * a report that refused to run in a directory with no notes would be useless
 * exactly when it is wanted — the `plugins.*` config still comes from the
 * vault layer when there is one, which is how `findVault` already behaves for
 * `ppr doctor`.
 */
export function pluginsCommand(): Command {
  return new Command('plugins')
    .description('what is wired to ppr: hooks, plugin-backed flags, `ppr-*` commands')
    .addHelpText(
      'after',
      `
Read-only, and it runs no model. Everything it reports is a convention rather
than a registration: a name on PATH, an event in ~/.config/ppr/config.json,
and \`plugins.<name>.<key>\` for settings ppr never validates.

  ppr hooks add entry.created ppr-reminders-push   wire an event
  ppr plugins --json                               the same thing, as data`,
    )
    .action(async (_flags: unknown, self: Command) => {
      const g = globals(self);
      const found = findVault(g.vault ? { explicit: g.vault } : {});
      const config = await loadConfig(found.root);

      const report = {
        events: eventRows(await loadHooks()),
        intents: intentRows(),
        commands: scanExternals().map((cmd) => ({ word: cmd.word, name: cmd.name, path: cmd.path })),
        settings: config.plugins ?? {},
      };
      if (g.json) return json(report);

      section('Events', report.events.length
        ? report.events.map((row): [string, string] => [
            `${mark(row.path)} ${row.event}`,
            row.path ? row.command : `${row.command}  ${color.dim('(not on your PATH)')}`,
          ])
        : [['', color.dim('Nothing wired. `ppr hooks add <event> <command>`')]]);

      section('Intents', report.intents.map((row): [string, string] => [
        `${row.tool ? mark(row.path) : ' '} ${row.flag}`,
        row.tool
          ? `${row.tool}  ${color.dim(row.path ?? '(not on your PATH)')}`
          : color.dim(row.resolves),
      ]));

      section('Commands', report.commands.length
        ? report.commands.map((cmd): [string, string] => [
            `${color.green('✓')} ppr ${cmd.word}`,
            color.dim(cmd.path),
          ])
        : [['', color.dim('No `ppr-*` on your PATH. Any executable so named is a subcommand.')]]);

      const settings = Object.entries(report.settings).flatMap(([name, values]) =>
        Object.entries(values as Record<string, unknown>).map(
          ([key, value]): [string, string] => [`plugins.${name}.${key}`, String(value)],
        ),
      );
      section('Settings', settings.length
        ? settings
        : [['', color.dim('No `plugins.<name>` sections. Anything under that key is yours.')]]);
    });
}

const mark = (path: string | null): string => (path ? color.green('✓') : color.yellow('!'));

function section(title: string, rows: Array<[string, string]>): void {
  out(color.bold(title));
  out(table(rows.map(([k, v]) => [`  ${k}`, v])));
  out('');
}

/** Every registered consumer, in event order, with whether it is there to run. */
function eventRows(hooks: Record<string, string[]>): Array<{
  event: string;
  command: string;
  path: string | null;
}> {
  return EVENT_NAMES.flatMap((event) =>
    (hooks[event] ?? []).map((command) => ({
      event,
      command,
      // The first word, because a hook is a shell string and may carry its own
      // arguments and pipes — what has to exist is the program at the front.
      path: resolveCommand(command.split(/\s+/)[0]!),
    })),
  );
}

/**
 * What the friendly flags currently mean.
 *
 * A flag names an intent and a conventional program name on PATH resolves the
 * tool (I13), so "what does `--push` do" is answered by `which`, not by ppr —
 * and this is the only place a person can see that answer without knowing to
 * run `which`. `--pipe` is in the table with nothing resolved on purpose: it
 * is the same mechanism with the convention removed, and leaving it out would
 * suggest the two blessed names are the whole story.
 */
function intentRows(): Array<{ flag: string; tool: string | null; path: string | null; resolves: string }> {
  const resolve = (flag: string, tool: string) => ({
    flag,
    tool,
    path: resolveCommand(tool),
    resolves: tool,
  });
  return [
    resolve('remind --push', PUSH_PLUGIN),
    resolve('brief --notify', NOTIFY_PLUGIN),
    { flag: 'schedule --pipe', tool: null, path: null, resolves: 'anything you name' },
  ];
}
