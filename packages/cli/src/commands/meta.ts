import { Command } from 'commander';
import { PprError, VERSION } from '@ppr/core';
import { globals } from '../context.js';
import { color, json, out } from '../render.js';
import { suggest } from '../suggest.js';

/**
 * `help` and `version` as real commands.
 *
 * Commander provides both as flags, and an implicit `help` subcommand that a
 * default action swallows — so `ppr help` was being filed as a note. They are
 * the two words every CLI user types without thinking, and neither may ever
 * become an entry.
 */

export function helpCommand(program: Command): Command {
  return new Command('help')
    .description('show help for a command')
    .argument('[command]', 'command to describe')
    .action((name: string | undefined) => {
      if (!name) return program.outputHelp();

      const target = program.commands.find(
        (cmd) => cmd.name() === name || cmd.aliases().includes(name),
      );
      if (!target) {
        const guess = suggest(
          name,
          program.commands.flatMap((cmd) => [cmd.name(), ...cmd.aliases()]),
        );
        throw new PprError(
          'EINVALID',
          `No command called ${name}`,
          guess ? `Did you mean \`ppr help ${guess}\`?` : 'Run `ppr help` for the full list.',
        );
      }
      target.outputHelp();
    });
}

export function versionCommand(): Command {
  return new Command('version')
    .description('print the version')
    .action((_flags: unknown, self: Command) => {
      if (globals(self).json) return json({ version: VERSION, node: process.versions.node });
      out(`ppr ${VERSION} ${color.dim(`(node ${process.versions.node})`)}`);
    });
}
