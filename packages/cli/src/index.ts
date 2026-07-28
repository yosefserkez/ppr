#!/usr/bin/env node
import { Command } from 'commander';
import { PprError, truncate, VERSION } from '@ppr/core';
import { globals, hoistGlobals, withVault } from './context.js';
import { closePrompts, hasStdin, resolveText } from './input.js';
import { color, entryJson, errline, json, out, setColor, shortId } from './render.js';
import { overview } from './overview.js';
import { suggest } from './suggest.js';
import {
  appendCommand,
  clipCommand,
  dumpCommand,
  removeCommand,
  voiceCommand,
  writeCommand,
} from './commands/capture.js';
import {
  browseCommand,
  editCommand,
  exportCommand,
  linksCommand,
  listCommand,
  pathCommand,
  searchCommand,
  showCommand,
  statsCommand,
  tagsCommand,
  textCommand,
  windowCommands,
} from './commands/browse.js';
import { askCommand, memoryCommand, recapCommand } from './commands/think.js';
import { aiCommand, configCommand, initCommand, reindexCommand } from './commands/settings.js';
import { doctorCommand, setupCommand } from './commands/setup.js';

const EXIT_CODES: Record<string, number> = {
  ENOVAULT: 4,
  ENOTFOUND: 3,
  EAMBIGUOUS: 3,
  EINVALID: 2,
  ENOAI: 4,
  ECONFIG: 4,
  EAI: 5,
  ENETWORK: 5,
  EEXTERNAL: 6,
};

const program = new Command();

program
  .name('ppr')
  .description(
    'Local-first notes, logs, and brain dumps in plain markdown.\n\n' +
      'Every command takes --json, so ppr composes with everything else you use.',
  )
  .version(VERSION, '-V, --version')
  .option('--vault <dir>', 'vault directory (default: $PPR_DIR, the nearest .ppr, or ~/ppr)')
  .option('--json', 'machine-readable output')
  .option('-q, --quiet', 'ids only, no chrome')
  .option('--no-color', 'disable colour')
  .option('--no-ai', 'skip model generation for this command (transcription still works)')
  .showHelpAfterError('(run `ppr --help`)')
  .enablePositionalOptions();

// Capture
program.addCommand(writeCommand());
program.addCommand(dumpCommand());
program.addCommand(clipCommand());
program.addCommand(voiceCommand());
program.addCommand(appendCommand());

// Browse
program.addCommand(listCommand());
program.addCommand(browseCommand());
for (const cmd of windowCommands()) program.addCommand(cmd);
program.addCommand(searchCommand());
program.addCommand(showCommand());
program.addCommand(editCommand());
program.addCommand(removeCommand());
program.addCommand(tagsCommand());
program.addCommand(linksCommand());
program.addCommand(pathCommand());
program.addCommand(textCommand());
program.addCommand(statsCommand());
program.addCommand(exportCommand());

// Think
program.addCommand(recapCommand());
program.addCommand(askCommand());
program.addCommand(memoryCommand());

// Settings
program.addCommand(initCommand());
program.addCommand(setupCommand());
program.addCommand(configCommand());
program.addCommand(aiCommand());
program.addCommand(doctorCommand());
program.addCommand(reindexCommand());

/** Every command name and alias, for did-you-mean. */
const commandNames = (): string[] =>
  program.commands.flatMap((cmd) => [cmd.name(), ...cmd.aliases()]);

/**
 * Refuses to guess.
 *
 * `ppr serach redis` used to become a note saying "serach redis", because any
 * unrecognised word fell through to capture. No heuristic can separate a
 * mistyped command from a short note — the information is not in the text — so
 * ppr uses a signal that already exists: quoting. One argument is a note,
 * several are an attempted command. Both ways to log it are in the error.
 */
function notACommand(text: string[]): PprError {
  const guess = suggest(text[0]!, commandNames());
  const quoted = text.join(' ').replaceAll('"', '\\"');
  return new PprError(
    'EINVALID',
    `Unknown command: ${text[0]}`,
    [
      guess ? `Did you mean \`ppr ${guess}\`?` : '',
      `To log it as a note:  ppr "${truncate(quoted, 48)}"`,
      `Or write it directly: ppr + ${truncate(text.join(' '), 48)}`,
    ]
      .filter(Boolean)
      .join('\n  '),
  );
}

/**
 * `ppr "shipped the migration"` — the fastest path from thought to file.
 * A bare `ppr` reports instead of capturing, so running it by accident is free.
 */
program
  .argument('[text...]', 'a quoted note to log, e.g. ppr "shipped it"')
  .action(async (text: string[], _flags: unknown, self: Command) => {
    const piped = !text.length && hasStdin();

    if (!text.length && !piped) {
      return withVault(self, async (vault) => overview(vault));
    }
    // Several bare words are an attempted command, not a note.
    if (text.length > 1) throw notACommand(text);
    // A single word that is nearly a command is a typo, not a one-word note.
    if (text.length === 1 && suggest(text[0]!, commandNames())) throw notACommand(text);

    await withVault(self, async (vault) => {
      const body = await resolveText(text);
      if (!body) {
        program.outputHelp();
        return;
      }
      const entry = await vault.add({ body, kind: vault.config.capture.defaultKind });
      const g = globals(self);
      if (g.json) json(entryJson(entry));
      else if (g.quiet) out(entry.id);
      else errline(`${color.green('✓')} ${color.dim(shortId(entry.id))} ${entry.title}`);
    });
  });

program.addHelpText(
  'after',
  `
Examples:
  ppr                                             what you wrote today
  ppr setup                                       guided setup, downloads included
  ppr "deploy failed again, rolled back to 4.2"   quick log (quoted = a note)
  ppr + deploy failed again                       the same, without quoting
  cat notes.txt | ppr dump                        clean up a wall of text
  ppr clip https://example.com/post               save what a page says
  ppr voice                                       record, transcribe, distill
  ppr ls                                          browse with the keyboard
  ppr search deploy --since 30d                   find it later
  ppr ask "why did we drop redis?"                answer from your own entries
  ppr recap --since 7d --style weekly             what happened
  vim $(ppr path latest)                          it is just markdown
`,
);

function reportError(err: unknown): number {
  setColor(process.stdout.isTTY === true);
  if (err instanceof PprError) {
    errline(`${color.red('error')} ${err.message}`);
    if (err.hint) errline(color.dim(`  ${err.hint}`));
    return EXIT_CODES[err.code] ?? 1;
  }
  const error = err as NodeJS.ErrnoException;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    errline(color.dim('cancelled'));
    return 130;
  }
  errline(`${color.red('error')} ${error?.message ?? String(err)}`);
  if (process.env.PPR_DEBUG) errline(String(error?.stack ?? ''));
  return 1;
}

// A broken pipe (`ppr ls | head`) is a normal way to end, not a crash.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

try {
  await program.parseAsync(hoistGlobals(process.argv.slice(2)), { from: 'user' });
} catch (err) {
  process.exitCode = reportError(err);
} finally {
  // Releases stdin, so a command that prompted can still exit on its own.
  closePrompts();
}
