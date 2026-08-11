/**
 * Scheduling, without ppr becoming a thing that runs in the background.
 *
 * ppr has no daemon and is not getting one. What it does instead is write the
 * scheduler config your operating system already has — a launchd agent on
 * macOS, a crontab line elsewhere — and then get out of the way. The job it
 * schedules is an ordinary composable command, so anything you can type you
 * can also put on a timer.
 *
 * The generators here are pure so they can be tested without touching a real
 * launchd; only `install`/`uninstall` reach the filesystem.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PprError } from '@ppr/core';
import { run } from '@ppr/core/node';

/** The jobs ppr knows how to schedule. Both are ordinary CLI commands. */
export const JOBS = {
  learn: {
    args: ['memory', 'learn', '--quiet'],
    description: 'fold new entries into what ppr knows',
    defaultAt: '03:00',
    /** `memory learn` has no `--notify`, so a banner there is a pipe. */
    announces: false,
  },
  brief: {
    // Plain, because delivery is not this command's business. A scheduled
    // brief with nowhere to go writes into a launchd log at 8am where nobody
    // is looking — and the answers to that are a pipe (`--pipe`), or the
    // `--notify` this command already has, which goes *into* the argv rather
    // than wrapping a pipeline round it (see `jobArgv`).
    args: ['brief', '--plain'],
    description: 'what is coming up',
    defaultAt: '08:00',
    /** `ppr brief --notify` announces itself: no pipeline, no shell. */
    announces: true,
  },
} as const;

export type JobName = keyof typeof JOBS;

export const isJobName = (name: string): name is JobName => name in JOBS;

export interface Schedule {
  job: JobName;
  /** 24-hour local time, `HH:MM`. */
  at: string;
  /** Vault to run against, when it is not the default. */
  vault?: string;
  /**
   * A shell command to pipe the job's output into.
   *
   * The generic version of "and then tell me about it": ppr already prints
   * something worth reading, and a pipe is how Unix has delivered output to
   * somewhere else for fifty years. `--pipe ppr-notify` is a banner,
   * `--pipe "mail -s brief me"` is an email, and ppr needs to know about
   * neither.
   */
  pipe?: string;
  /**
   * Whether the job announces its own result — `--notify` on the scheduled
   * command line, not a pipe into something that notifies.
   *
   * Only meaningful for a job whose command has the flag (`JOBS[job].announces`).
   */
  notify?: boolean;
}

/** `08:00` -> `{hour: 8, minute: 0}`. Throws nothing; returns null instead. */
export function parseAt(at: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export const labelFor = (job: JobName): string => `sh.ppr.${job}`;

export const agentPath = (job: JobName): string =>
  join(homedir(), 'Library', 'LaunchAgents', `${labelFor(job)}.plist`);

/**
 * The argv a scheduled run executes: this same binary, same flags, no shell.
 *
 * `node` comes first and the script second, both absolute. Relying on the
 * script's `#!/usr/bin/env node` shebang looks equivalent and is not: launchd
 * runs jobs with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and cron with something
 * just as bare, so a Homebrew, nvm, or volta node is simply not there — the
 * job dies at 3am with "env: node: No such file or directory" in a log nobody
 * reads (L22). Naming the interpreter removes the lookup entirely.
 *
 * `--notify` rides here, on the end of the job's own argv, and that placement
 * is the whole of it: what the intent means is then resolved at 8am, by the
 * ppr that runs, through the one `resolveIntent` path — as argv, with no shell
 * anywhere and nothing about it written down. Resolving it at install time and
 * piping into the answer would break that twice over. A `porcelain` binding is
 * a *command line*, so splicing one into the `/bin/sh -c` that `shellCommand`
 * builds would make a `|` or a `$HOME` in it shell source at 8am when it is an
 * argument at the terminal — the one thing `porcelain.ts` calls
 * non-negotiable. And it would freeze today's binding into the plist, so
 * editing it tomorrow would leave the job running yesterday's while
 * `ppr plugins` reported the new one.
 */
export function jobArgv(schedule: Schedule, node: string, script: string): string[] {
  return [
    node,
    script,
    ...(schedule.vault ? ['--vault', schedule.vault] : []),
    ...JOBS[schedule.job].args,
    ...(schedule.notify ? ['--notify'] : []),
  ];
}

/**
 * A launchd agent.
 *
 * `RunAtLoad` is deliberately absent: installing a schedule should not run the
 * job, and a machine waking up should not either. Output goes to a log rather
 * than nowhere, because a cron job you cannot debug is a cron job you stop
 * trusting.
 */
export function plist(schedule: Schedule, argv: string[]): string {
  const at = parseAt(schedule.at) ?? { hour: 3, minute: 0 };
  const log = join(homedir(), 'Library', 'Logs', `${labelFor(schedule.job)}.log`);
  const args = programArguments(schedule, argv)
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${labelFor(schedule.job)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${at.hour}</integer>
    <key>Minute</key>
    <integer>${at.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(log)}</string>
</dict>
</plist>
`;
}

/** The crontab line for everything that is not macOS. */
export function crontabLine(schedule: Schedule, argv: string[]): string {
  const at = parseAt(schedule.at) ?? { hour: 3, minute: 0 };
  return `${at.minute} ${at.hour} * * * ${escapePercent(shellCommand(schedule, argv))}`;
}

/**
 * The job as one shell command, pipe included.
 *
 * cron already runs its line through a shell, so a pipe there is a real pipe
 * and nothing has to be arranged. launchd does not — it execs an argv — so a
 * piped job is handed to `/bin/sh -c` and this same string is what it gets.
 * One function, so the two schedulers cannot end up running different things.
 *
 * The argv is quoted (absolute paths with spaces in them are ordinary on a
 * Mac); the pipe target is not, because it is a command line the user typed
 * and quoting it would break the first `--flag` they put in it.
 */
export function shellCommand(schedule: Schedule, argv: string[]): string {
  const command = argv.map(quote).join(' ');
  return schedule.pipe ? `${command} | ${schedule.pipe}` : command;
}

/** The argv launchd should exec: the job itself, or a shell holding the pipe. */
export const programArguments = (schedule: Schedule, argv: string[]): string[] =>
  schedule.pipe ? ['/bin/sh', '-c', shellCommand(schedule, argv)] : argv;

/**
 * Anything outside this set is single-quoted. Quoting an argument that did not
 * need it costs nothing; leaving a `$`, `;`, or backtick in a vault path bare
 * runs extra shell words at 3am, in a log nobody reads. Only the argv comes
 * through here — the pipe target is the user's own command line (`shellCommand`).
 *
 * `%` is absent from the set even though no shell cares about it, because cron
 * does (`escapePercent`) — an argument the scheduler will rewrite is not an
 * argument to leave bare.
 */
const quote = (arg: string): string =>
  /^[A-Za-z0-9_@+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

/**
 * `%` belongs to cron, not to the shell.
 *
 * cron rewrites the first unescaped `%` in a line into a newline, runs only
 * what came before it, and feeds the rest to the job on stdin. It does that to
 * the crontab line itself, before `/bin/sh` is handed anything, so quoting
 * cannot reach it: `'/Users/me/100% notes'` still truncates the command. Only
 * `\%` survives, and cron strips that backslash on the way through, so the
 * shell ends up seeing the plain `%` inside the quotes it expected.
 *
 * The whole line goes through here, the user's `--pipe` included: one
 * unescaped `%` anywhere truncates everything after it, and a `%` somebody
 * typed into a shell command line meant a percent sign. launchd has no such
 * rule — a `%` is ordinary inside a plist `<string>` and a backslash there
 * would land in the path — which is why this lives in `crontabLine` rather
 * than in the `shellCommand` both schedulers share.
 */
const escapePercent = (line: string): string => line.replace(/%/g, '\\%');

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `&amp;` last, or an escaped `&lt;` would come back as a real `<`. */
const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * The argv of an installed agent, read out of `ProgramArguments` and nowhere
 * else.
 *
 * A plist holds `<string>`s on either side of that array — the Label before it,
 * the two log paths after — so scanning the whole document reported a command
 * that ended in a pair of log files the user never scheduled. `ppr schedule ls`
 * is only worth having if it says what launchd will actually run.
 */
export function programArgumentsFrom(raw: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(raw);
  if (!block) return [];
  return [...block[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unescapeXml(m[1]!));
}

export const supportsInstall = (): boolean => process.platform === 'darwin';

/**
 * The launchd domain to load into. Guessing a uid is worse than not running:
 * `gui/501` is the first account on most Macs and somebody else's session on
 * the rest, so a wrong guess either fails obscurely or schedules the job
 * against a user who did not ask for it.
 */
function guiDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new PprError(
      'EEXTERNAL',
      'Cannot determine your user id, so launchd has no domain to load into',
      'Run `ppr schedule add` from a normal user shell, or schedule the printed command with cron.',
    );
  }
  return `gui/${uid}`;
}

/**
 * Writes the agent and asks launchd to pick it up.
 *
 * `bootout` first: launchd keeps a loaded copy, so rewriting the file alone
 * changes nothing until the old job is dropped. Failures there are expected
 * and ignored — it usually means the job was not loaded in the first place.
 */
export async function install(schedule: Schedule, argv: string[]): Promise<string> {
  const target = guiDomain();
  const path = agentPath(schedule.job);
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(join(homedir(), 'Library', 'Logs'), { recursive: true });
  await writeFile(path, plist(schedule, argv));

  await run('launchctl', ['bootout', `${target}/${labelFor(schedule.job)}`]).catch(() => null);
  const loaded = await run('launchctl', ['bootstrap', target, path]);
  if (loaded.code !== 0) {
    throw new Error(loaded.stderr.trim() || `launchctl refused to load ${path}`);
  }
  return path;
}

export async function uninstall(job: JobName): Promise<boolean> {
  const path = agentPath(job);
  const target = guiDomain();
  await run('launchctl', ['bootout', `${target}/${labelFor(job)}`]).catch(() => null);
  try {
    await rm(path);
    return true;
  } catch {
    return false;
  }
}

export interface InstalledJob {
  job: JobName;
  at: string;
  path: string;
  argv: string[];
}

/** What is actually scheduled, read back from the OS rather than remembered. */
export async function installed(): Promise<InstalledJob[]> {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const out: InstalledJob[] = [];
  for (const file of files) {
    const match = /^sh\.ppr\.(\w+)\.plist$/.exec(file);
    if (!match || !isJobName(match[1]!)) continue;
    const path = join(dir, file);
    const raw = await readFile(path, 'utf8').catch(() => '');
    const hour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(raw)?.[1] ?? '?';
    const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(raw)?.[1] ?? '??';
    out.push({
      job: match[1]!,
      at: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`,
      path,
      argv: programArgumentsFrom(raw),
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
