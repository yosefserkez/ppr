import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { PprError } from '@ppr/core';
import { globals } from '../context.js';
import { dryRun, would } from '../dryrun.js';
import { commandProgram, resolveCommand } from '../external.js';
import { missing, NOTIFY_INTENT, NOTIFY_PLUGIN, porcelainFor } from '../porcelain.js';
import { color, errline, json, out, table } from '../render.js';
import {
  agentPath,
  crontabLine,
  install,
  installed,
  isJobName,
  jobArgv,
  JOBS,
  parseAt,
  shellCommand,
  supportsInstall,
  uninstall,
  type JobName,
  type Schedule,
} from '../schedule.js';

/**
 * `ppr schedule` — put a ppr command on a timer.
 *
 * ppr does not run in the background and will not start; this writes the
 * scheduler config the operating system already has and hands it over. What
 * gets scheduled is a plain command, which is the only reason this is a
 * reasonable feature and not the beginning of a daemon.
 */
export function scheduleCommand(): Command {
  const cmd = new Command('schedule').description('run `memory learn` or `brief` on a timer');

  cmd
    .command('ls', { isDefault: true })
    .description('what ppr has scheduled')
    .action(async (_flags: unknown, self: Command) => {
      const jobs = await installed();
      if (globals(self).json) return json(jobs);
      if (!supportsInstall()) return void out(crontabHelp());
      if (!jobs.length) {
        out(color.dim('Nothing scheduled.'));
        return void out(
          `\n${table(
            Object.entries(JOBS).map(([name, job]) => [
              `ppr schedule add ${name}`,
              color.dim(`${job.description} (daily at ${job.defaultAt})`),
            ]),
          )}`,
        );
      }
      out(table(jobs.map((j) => [`${j.at}  ${j.job}`, color.dim(j.argv.join(' '))])));
    });

  cmd
    .command('add')
    .description('schedule a job to run daily')
    .argument('<job>', `one of: ${Object.keys(JOBS).join(', ')}`)
    .option('--at <HH:MM>', 'time of day, 24-hour local')
    .option('--pipe <command>', 'pipe the output into a command, e.g. `ppr-notify`')
    .option('--notify', 'send it as a notification, resolved when the job runs')
    .addHelpText(
      'after',
      `
Examples:
  ppr schedule add learn                        fold new entries in at 3am
  ppr schedule add brief --notify               a banner at 8am
  ppr schedule add brief --pipe ppr-notify      the output, piped, instead
  ppr schedule add brief --pipe "mail -s brief me@example.com"

A scheduled brief with nowhere to go writes into a log nobody reads, so the
useful half is delivery — and delivery is a pipe. ppr does not need to know
what is on the other end of it.

--notify is not a pipe. It schedules \`ppr brief --notify\`, so what the intent
means is looked up when the job runs — ${NOTIFY_PLUGIN} on PATH, or your
porcelain.notify — and run as argv. Rebind it tomorrow and tomorrow's banner
changes with it; nothing about it is written into the schedule.`,
    )
    .action(async (name: string, flags: { at?: string; pipe?: string; notify?: boolean }, self: Command) => {
      const job = asJob(name);
      const at = flags.at ?? JOBS[job].defaultAt;
      if (!parseAt(at)) throw new PprError('EINVALID', `--at takes HH:MM, got "${at}"`);

      const g = globals(self);
      // `--notify` schedules the job's *own* `--notify`, so `ppr brief
      // --notify` is what runs at 8am and the intent is resolved then, by that
      // ppr, through the one `resolveIntent` path. Nothing about it is
      // resolved here, and that is deliberate twice: a `porcelain` binding is
      // a whole command line, so writing one down would splice a `|` or a
      // `$HOME` into the `/bin/sh -c` a piped job is handed — an argument at
      // the terminal, shell source at 8am — and it would freeze today's
      // binding into the plist while `ppr plugins` went on reporting the
      // current one.
      //
      // `memory learn` has no such flag, so there a banner is still a pipe —
      // into the conventional name, late-bound on PATH at 3am exactly as it
      // was before bindings existed. A binding never reaches `shellCommand`
      // by either route.
      const announces = flags.notify === true && JOBS[job].announces;
      const pipe = flags.pipe ?? (flags.notify && !JOBS[job].announces ? NOTIFY_PLUGIN : undefined);
      const schedule: Schedule = {
        job,
        at,
        ...(g.vault ? { vault: g.vault } : {}),
        ...(pipe ? { pipe } : {}),
        ...(announces ? { notify: true } : {}),
      };
      if (pipe && !resolveCommand(commandProgram(pipe))) {
        // Not an error: a scheduled job is allowed to name something you are
        // about to install. But a silent 8am no-op is worth a word now. Asked
        // the way `ppr hooks add` asks it, so `--pipe /usr/local/bin/thing`
        // gets the same answer from both.
        errline(color.dim(`Note: ${commandProgram(pipe)} is not on your PATH yet.`));
      }
      if (announces) {
        // Resolved to say something, never to write something: the same
        // silent-8am-no-op warning as above, worded once in `missing()` so a
        // binding pointing at a typo names the file here as well as at the
        // terminal. What actually runs is looked up again when it runs.
        const target = await porcelainFor(NOTIFY_INTENT);
        if (!target.path) errline(color.dim(`Note: ${missing(target)}`));
      }
      const argv = jobArgv(schedule, process.execPath, entryScript());
      // One shape whether the plist was written or only previewed (I10: a
      // `--dry-run --json` prints exactly what a real run would).
      const plan = (file: string) => ({
        job,
        at,
        path: file,
        argv,
        ...(pipe ? { pipe } : {}),
        ...(announces ? { notify: true } : {}),
      });

      // Nothing to install into: print the line and let the user place it,
      // rather than editing a crontab behind their back.
      if (!supportsInstall()) {
        out(crontabLine(schedule, argv));
        return void errline(color.dim('\nAdd that with `crontab -e`.'));
      }
      // The artifact, not a summary of it: what launchd will read is a file at
      // a path, waking a command at an hour, and those are the two things a
      // person wants to check before it runs at 3am (L22 is what happens when
      // nobody checked).
      if (dryRun()) {
        const when = parseAt(at)!;
        would(`write ${agentPath(job)}`, [
          `StartCalendarInterval: Hour ${when.hour}, Minute ${when.minute}`,
          shellCommand(schedule, argv),
        ]);
        would(`load it with launchctl bootstrap`);
        if (g.json) return json(plan(agentPath(job)));
        return void errline(color.dim(`${job} would run daily at ${at}`));
      }
      const path = await install(schedule, argv);
      if (g.json) return json(plan(path));
      errline(`${color.green('✓')} ${job} runs daily at ${at}`);
      errline(color.dim(`  ${path}`));
    });

  cmd
    .command('rm')
    .alias('remove')
    .description('stop a scheduled job')
    .argument('<job>', `one of: ${Object.keys(JOBS).join(', ')}`)
    .action(async (name: string, _flags: unknown, self: Command) => {
      const job = asJob(name);
      if (!supportsInstall()) {
        throw new PprError('EINVALID', 'Nothing to remove', 'Edit your crontab with `crontab -e`.');
      }
      if (dryRun()) {
        would(`remove ${agentPath(job)}`);
        would(`unload it with launchctl bootout`);
        if (globals(self).json) return json({ job, removed: false });
        return void errline(color.dim(`${job} would be unscheduled`));
      }
      const removed = await uninstall(job);
      if (globals(self).json) return json({ job, removed });
      errline(removed ? `${color.red('✗')} ${job} unscheduled` : color.dim(`${job} was not scheduled`));
    });

  return cmd;
}

/**
 * The absolute path of the script a scheduled run should execute.
 *
 * `process.argv[1]` is whatever was typed, so it can be relative — a path that
 * means nothing to a job launched from `/` at 3am. Resolving it against the
 * cwd fixes that; the module-relative fallback covers being loaded without an
 * entry script at all.
 */
function entryScript(): string {
  const argv1 = process.argv[1];
  return argv1 ? resolve(argv1) : fileURLToPath(new URL('../index.js', import.meta.url));
}

function asJob(name: string): JobName {
  if (!isJobName(name)) {
    throw new PprError('EINVALID', `Unknown job: ${name}`, `Pick one of: ${Object.keys(JOBS).join(', ')}`);
  }
  return name;
}

/** On anything but macOS, ppr can generate the line but not place it. */
const crontabHelp = (): string =>
  [
    color.dim('ppr installs schedules through launchd, which is macOS only.'),
    color.dim('Elsewhere, `ppr schedule add <job>` prints a crontab line to add yourself.'),
  ].join('\n');
