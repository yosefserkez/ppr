import { Command } from 'commander';
import { EVENT_NAMES, PprError, isEventName, type VaultEventName } from '@ppr/core';
import { globalConfigPath } from '@ppr/core/node';
import { globals } from '../context.js';
import { commandProgram, resolveCommand } from '../external.js';
import { loadHooks, saveHooks, withHook, withoutHook, type Hooks } from '../hooks.js';
import { color, errline, json, out, table } from '../render.js';

/**
 * `ppr hooks` — registration, without opening a JSON file in an editor.
 *
 * This is a pen over visible config and deliberately not a second mechanism:
 * it writes `hooks` in `~/.config/ppr/config.json`, which is the one layer the
 * runner reads (see the security rule in `hooks.ts`), and hand-editing that
 * file remains exactly as supported as it was. Nothing here is a registry:
 * there is no manifest, no id, no lifecycle — a hook is still an event name and
 * a command string.
 *
 * `ppr config set hooks.…` still refuses, and that refusal is the reason this
 * exists: the config path allows `--local`, which would mean a vault could
 * carry a hook, and a vault is a repo people clone.
 */
export function hooksCommand(): Command {
  const cmd = new Command('hooks')
    .description('run a command when ppr writes something')
    // So `ppr hooks add entry.created my-thing --loud` keeps `--loud` in the
    // hook and out of commander: the flags after a command belong to it.
    .enablePositionalOptions();

  cmd
    .command('ls', { isDefault: true })
    .description('what is wired to what')
    .action(async (_flags: unknown, self: Command) => {
      const hooks = await loadHooks();
      if (globals(self).json) return json({ file: globalConfigPath(), hooks });
      if (!Object.keys(hooks).length) {
        out(color.dim('No hooks.'));
        return void out(
          `\n${table([
            ['ppr hooks add entry.created ppr-reminders-push', color.dim('react to a write')],
            ['ppr plugins', color.dim('what else is installed')],
          ])}`,
        );
      }
      out(table(rows(hooks)));
    });

  cmd
    .command('add')
    .description('run a command whenever an event happens')
    .argument('<event>', `one of: ${EVENT_NAMES.join(', ')}`)
    .argument('<command...>', 'the command to run; it gets the event as JSON on stdin')
    // A hook is a shell string, so its own flags are its own business — the
    // same reason `ppr foo --verbose` never reaches commander (see index.ts).
    .passThroughOptions()
    .allowUnknownOption()
    .addHelpText(
      'after',
      `
Examples:
  ppr hooks add entry.created ppr-reminders-push
  ppr hooks add fact.learned "jq -r .entry.body >> ~/facts.txt"
  ppr hooks rm entry.created

Hooks are read from ~/.config/ppr/config.json and nowhere else: they run shell
commands, and a vault is a repo people clone. Editing that file by hand does
the same thing this command does.

A hook may write to a vault, and that write happens — but it fires no further
hooks. ppr fans out once, from the command you ran. If your hook wants a
second thing to happen, it runs it itself.`,
    )
    .action(async (name: string, words: string[], _flags: unknown, self: Command) => {
      const event = asEvent(name);
      const command = words.join(' ').trim();
      if (!command) throw new PprError('EINVALID', 'A hook needs a command to run');

      const hooks = await loadHooks();
      const next = withHook(hooks, event, command);
      const g = globals(self);

      if (!next) {
        if (g.json) return json({ event, command, added: false, file: globalConfigPath() });
        return errline(color.dim(`Already wired: ${event} → ${command}`));
      }

      // A warning, not an error: people wire up the thing they are about to
      // install, and refusing would make `ppr hooks add` useless in a dotfiles
      // script. A hook that is missing when it fires costs one stderr line.
      const first = commandProgram(command);
      if (!resolveCommand(first)) {
        errline(color.dim(`Note: ${first} is not on your PATH yet.`));
      }

      const file = await saveHooks(next, `+ hooks.${event}: ${command}`);
      if (g.json) return json({ event, command, added: true, file });
      errline(`${color.green('✓')} ${event} → ${command}`);
      errline(color.dim(`  ${file}`));
    });

  cmd
    .command('rm')
    .alias('remove')
    .description('stop running a command on an event')
    .argument('<event>', `one of: ${EVENT_NAMES.join(', ')}`)
    .argument('[command...]', 'the command to unwire; omit to remove all of them')
    .passThroughOptions()
    .allowUnknownOption()
    .action(async (name: string, words: string[], _flags: unknown, self: Command) => {
      const event = asEvent(name);
      const command = words.join(' ').trim() || undefined;

      const hooks = await loadHooks();
      const { hooks: next, removed } = withoutHook(hooks, event, command);
      const g = globals(self);

      if (!removed.length) {
        if (g.json) return json({ event, removed, file: globalConfigPath() });
        return errline(color.dim(command ? `Not wired: ${event} → ${command}` : `Nothing on ${event}`));
      }

      const file = await saveHooks(next, removed.map((c) => `- hooks.${event}: ${c}`).join('\n       '));
      if (g.json) return json({ event, removed, file });
      for (const gone of removed) errline(`${color.red('✗')} ${event} → ${gone}`);
    });

  return cmd;
}

/** Event → its commands, with a mark for whether each one is there to run. */
function rows(hooks: Hooks): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const event of EVENT_NAMES) {
    for (const command of hooks[event] ?? []) {
      const found = resolveCommand(commandProgram(command));
      out.push([
        `${found ? color.green('✓') : color.yellow('!')} ${event}`,
        found ? command : `${command}  ${color.dim('(not on your PATH)')}`,
      ]);
    }
  }
  return out;
}

/**
 * The taxonomy is closed, and a typo in it is silent at runtime — `parseHooks`
 * ignores a name it does not know, which is right for a file somebody edited by
 * hand and useless as an answer to `ppr hooks add entry.create`. So the pen
 * checks, and names every event there is.
 */
function asEvent(name: string): VaultEventName {
  if (!isEventName(name)) {
    throw new PprError('EINVALID', `Unknown event: ${name}`, `Events: ${EVENT_NAMES.join(', ')}`);
  }
  return name;
}
