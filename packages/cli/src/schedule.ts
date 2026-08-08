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
import { run } from '@ppr/core/node';

/** The jobs ppr knows how to schedule. Both are ordinary CLI commands. */
export const JOBS = {
  learn: {
    args: ['memory', 'learn', '--quiet'],
    description: 'fold new entries into what ppr knows',
    defaultAt: '03:00',
  },
  brief: {
    args: ['brief'],
    description: 'what is coming up',
    defaultAt: '08:00',
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

const agentPath = (job: JobName): string =>
  join(homedir(), 'Library', 'LaunchAgents', `${labelFor(job)}.plist`);

/** The argv a scheduled run executes: this same binary, same flags, no shell. */
export function jobArgv(schedule: Schedule, binary: string): string[] {
  return [
    binary,
    ...(schedule.vault ? ['--vault', schedule.vault] : []),
    ...JOBS[schedule.job].args,
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
  const args = argv.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');

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
  return `${at.minute} ${at.hour} * * * ${argv.map(quote).join(' ')}`;
}

const quote = (arg: string): string => (/[\s"']/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg);

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const supportsInstall = (): boolean => process.platform === 'darwin';

/**
 * Writes the agent and asks launchd to pick it up.
 *
 * `bootout` first: launchd keeps a loaded copy, so rewriting the file alone
 * changes nothing until the old job is dropped. Failures there are expected
 * and ignored — it usually means the job was not loaded in the first place.
 */
export async function install(schedule: Schedule, argv: string[]): Promise<string> {
  const path = agentPath(schedule.job);
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(join(homedir(), 'Library', 'Logs'), { recursive: true });
  await writeFile(path, plist(schedule, argv));

  const target = `gui/${process.getuid?.() ?? 501}`;
  await run('launchctl', ['bootout', `${target}/${labelFor(schedule.job)}`]).catch(() => null);
  const loaded = await run('launchctl', ['bootstrap', target, path]);
  if (loaded.code !== 0) {
    throw new Error(loaded.stderr.trim() || `launchctl refused to load ${path}`);
  }
  return path;
}

export async function uninstall(job: JobName): Promise<boolean> {
  const path = agentPath(job);
  const target = `gui/${process.getuid?.() ?? 501}`;
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
      argv: [...raw.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!).slice(1),
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
