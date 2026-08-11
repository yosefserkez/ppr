import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  crontabLine,
  jobArgv,
  labelFor,
  parseAt,
  plist,
  programArgumentsFrom,
  shellCommand,
} from '../dist/schedule.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

/**
 * The real binary, against throwaway directories.
 *
 * `PPR_DIR` and `XDG_CONFIG_HOME` both point inside the temp dir, so nothing
 * here can read or write the developer's own vault or config — the rule every
 * test that spawns ppr follows.
 */
function ppr(dir, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        PPR_DIR: dir,
        XDG_CONFIG_HOME: join(dir, '.xdg'),
        PPR_NO_AI: '1',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => done({ code: code ?? 0, stdout, stderr }));
  });
}

/** A `porcelain.notify` binding in the one file a binding may come from. */
async function withBinding(binding, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ppr-schedule-'));
  try {
    await mkdir(join(dir, '.xdg', 'ppr'), { recursive: true });
    await writeFile(
      join(dir, '.xdg', 'ppr', 'config.json'),
      `${JSON.stringify({ porcelain: { notify: binding } }, null, 2)}\n`,
    );
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a time of day is parsed or refused, never guessed', () => {
  assert.deepEqual(parseAt('08:00'), { hour: 8, minute: 0 });
  assert.deepEqual(parseAt('3:05'), { hour: 3, minute: 5 });
  for (const bad of ['24:00', '08:60', '8am', '0800', '']) {
    assert.equal(parseAt(bad), null, `should reject: ${bad}`);
  }
});

test('a scheduled job is an ordinary ppr command', () => {
  assert.deepEqual(
    jobArgv({ job: 'learn', at: '03:00' }, '/opt/homebrew/bin/node', '/repo/dist/index.js'),
    ['/opt/homebrew/bin/node', '/repo/dist/index.js', 'memory', 'learn', '--quiet'],
  );
  // The vault has to be explicit: cron has no cwd worth inheriting. And the
  // job itself is a plain command — where its output goes is a pipe's job,
  // not a flag ppr has to grow for every destination there is.
  assert.deepEqual(
    jobArgv({ job: 'brief', at: '08:00', vault: '~/notes' }, '/usr/bin/node', '/repo/dist/index.js'),
    ['/usr/bin/node', '/repo/dist/index.js', '--vault', '~/notes', 'brief', '--plain'],
  );
});

test('a scheduled --notify is the job announcing itself, not a pipeline', () => {
  const schedule = { job: 'brief', at: '08:00', notify: true };
  const argv = jobArgv(schedule, '/usr/bin/node', '/repo/dist/index.js');

  // What runs at 8am is ppr, so what `--notify` means is resolved at 8am too —
  // by that ppr, as argv, through the one path the terminal flag uses.
  assert.deepEqual(argv, ['/usr/bin/node', '/repo/dist/index.js', 'brief', '--plain', '--notify']);

  // And with nothing to pipe into, there is no shell anywhere for a resolved
  // command line to have been spliced into.
  const xml = plist(schedule, argv);
  assert.doesNotMatch(xml, /\/bin\/sh/);
  assert.deepEqual(programArgumentsFrom(xml), argv);
  assert.equal(
    crontabLine(schedule, argv),
    '0 8 * * * /usr/bin/node /repo/dist/index.js brief --plain --notify',
  );
});

test('a porcelain binding never reaches the scheduled command line', async () => {
  // A binding is a *command line*. Written into the schedule it would be
  // spliced into the `/bin/sh -c` a piped job is handed, where `|` becomes a
  // real pipe and `$HOME` expands at 8am — while the same string at the
  // terminal is five arguments to one program, which is the rule porcelain.ts
  // calls non-negotiable. The program at the front is a real one, so the
  // "nothing to run" note (which quotes the binding on purpose) stays out of
  // the way of what is being asserted.
  const binding = '/bin/echo --to $HOME/x | tee /tmp/ppr-schedule-leak';
  const traces = ['/bin/echo', '$HOME', 'tee', 'ppr-schedule-leak', '|'];

  await withBinding(binding, async (dir) => {
    // `--dry-run`, because the artifact is the claim and installing it would
    // put a real job on the developer's machine.
    const brief = await ppr(dir, ['schedule', 'add', 'brief', '--notify', '--dry-run', '--json']);
    assert.equal(brief.code, 0, brief.stderr);

    const said = `${brief.stdout}\n${brief.stderr}`;
    for (const trace of traces) {
      assert.ok(!said.includes(trace), `the binding reached the schedule (${trace}):\n${said}`);
    }

    if (process.platform === 'darwin') {
      const plan = JSON.parse(brief.stdout);
      assert.deepEqual(plan.argv.slice(-3), ['brief', '--plain', '--notify']);
      assert.equal(plan.notify, true);
      // Not a pipe, so nothing was snapshotted: rebinding porcelain.notify
      // tomorrow changes tomorrow's banner, and `ppr plugins` cannot end up
      // reporting something other than what runs.
      assert.equal(plan.pipe, undefined);
      assert.doesNotMatch(brief.stderr, /\/bin\/sh/);
    } else {
      // Elsewhere ppr prints the crontab line for the user to place, and it is
      // the command and nothing else.
      assert.match(brief.stdout.trim(), / brief --plain --notify$/);
    }

    // `memory learn` has no --notify of its own, so a banner there is still a
    // pipe — and it is the conventional name, looked up on PATH at 3am, never
    // a binding baked into a shell line.
    const learn = await ppr(dir, ['schedule', 'add', 'learn', '--notify', '--dry-run', '--json']);
    assert.equal(learn.code, 0, learn.stderr);
    const learnSaid = `${learn.stdout}\n${learn.stderr}`;
    for (const trace of traces.filter((t) => t !== '|')) {
      assert.ok(!learnSaid.includes(trace), `the binding reached the schedule (${trace}):\n${learnSaid}`);
    }
    assert.match(learnSaid, /\| ppr-notify/);
    if (process.platform === 'darwin') {
      assert.equal(JSON.parse(learn.stdout).pipe, 'ppr-notify');
    }
  });
});

test('a piped job is one command in cron and a shell in launchd', () => {
  const schedule = { job: 'brief', at: '08:00', pipe: 'ppr-notify' };
  const argv = ['/usr/bin/node', '/repo/dist/index.js', 'brief', '--plain'];

  // cron already runs its line through a shell, so the pipe is a real pipe.
  assert.equal(
    crontabLine(schedule, argv),
    '0 8 * * * /usr/bin/node /repo/dist/index.js brief --plain | ppr-notify',
  );

  // launchd execs an argv and has no shell, so it is handed one — running the
  // same string, so the two schedulers cannot do different things.
  const xml = plist(schedule, argv);
  assert.match(xml, /<string>\/bin\/sh<\/string>/);
  assert.match(xml, /<string>-c<\/string>/);
  assert.match(xml, /brief --plain \| ppr-notify/);

  // Without a pipe there is no shell in the way at all.
  assert.doesNotMatch(plist({ job: 'brief', at: '08:00' }, argv), /\/bin\/sh/);
});

test('a piped job quotes the argv but not the command the user typed', () => {
  const schedule = { job: 'brief', at: '08:00', pipe: 'mail -s "brief" me@example.com' };
  const line = shellCommand(schedule, ['/usr/bin/node', '/my notes/index.js', 'brief']);

  // A path with a space in it is ordinary on a Mac and has to survive.
  assert.match(line, /'\/my notes\/index\.js'/);
  // The pipe target is a command line somebody typed; quoting it would break
  // the first flag they put in it.
  assert.ok(line.endsWith('| mail -s "brief" me@example.com'), line);
});

test('a vault path with shell characters in it cannot run a second command at 3am', () => {
  const argv = ['/usr/bin/node', '/repo/dist/index.js', '--vault', '/notes;rm -rf ~', 'brief', '--plain'];
  const line = shellCommand({ job: 'brief', at: '08:00' }, argv);

  assert.match(line, /'\/notes;rm -rf ~'/);
  // An argument that needs no quoting keeps none, so the line stays readable
  // and `ppr schedule ls` shows what somebody typed.
  assert.ok(line.startsWith('/usr/bin/node /repo/dist/index.js --vault '), line);
  assert.ok(line.endsWith(' brief --plain'), line);

  for (const path of ['/notes/$(whoami)', '/notes/`id`', '/notes/a&b', '/notes/(x)', '/notes/*', '/notes/100%']) {
    const quoted = shellCommand({ job: 'brief', at: '08:00' }, ['ppr', '--vault', path]);
    assert.ok(quoted.endsWith(`'${path}'`), quoted);
  }

  // The pipe is still whatever the user typed, metacharacters and all.
  const piped = shellCommand({ job: 'brief', at: '08:00', pipe: 'mail -s "$(date)" me' }, ['ppr', 'brief']);
  assert.ok(piped.endsWith('| mail -s "$(date)" me'), piped);
});

test('a scheduled job names its interpreter instead of trusting PATH', () => {
  const argv = jobArgv({ job: 'learn', at: '03:00' }, process.execPath, '/repo/dist/index.js');
  // launchd runs with PATH=/usr/bin:/bin:/usr/sbin:/sbin and cron with as
  // little; a shebang that says `env node` finds nothing there.
  assert.ok(isAbsolute(argv[0]), `expected an absolute node path, got ${argv[0]}`);
  assert.equal(argv[0], process.execPath);
  assert.ok(isAbsolute(argv[1]), `expected an absolute script path, got ${argv[1]}`);
});

test('the launchd agent runs on a clock and never at load', () => {
  const xml = plist({ job: 'brief', at: '08:30' }, ['/bin/ppr', 'brief']);

  assert.match(xml, /<key>Label<\/key>\s*<string>sh\.ppr\.brief<\/string>/);
  assert.match(xml, /<key>Hour<\/key>\s*<integer>8<\/integer>/);
  assert.match(xml, /<key>Minute<\/key>\s*<integer>30<\/integer>/);
  // Installing a schedule must not run the job, and neither must waking up.
  assert.doesNotMatch(xml, /RunAtLoad/);
  // A job you cannot debug is a job you stop trusting.
  assert.match(xml, /StandardErrorPath/);
});

test('paths with characters XML cares about survive', () => {
  const xml = plist({ job: 'learn', at: '03:00' }, ['/bin/ppr', '--vault', '/tmp/a&b<c>']);
  assert.match(xml, /<string>\/tmp\/a&amp;b&lt;c&gt;<\/string>/);
});

test('`schedule ls` reads back the scheduled command and nothing else', () => {
  const schedule = { job: 'learn', at: '03:00', vault: '/my notes/a&b' };
  const argv = jobArgv(schedule, '/opt/homebrew/bin/node', '/repo/dist/index.js');
  const xml = plist(schedule, argv);

  assert.deepEqual(programArgumentsFrom(xml), argv);
  // The label sits before the array and the two log paths after it, so a scan
  // of the whole document reported a command ending in files nobody scheduled.
  assert.match(xml, /<key>StandardOutPath<\/key>/);
  assert.ok(
    !programArgumentsFrom(xml).some((a) => a.endsWith('.log') || a === 'sh.ppr.learn'),
    'log paths and the label are not part of the command',
  );

  // A piped job really is a shell running the pipe, and says so.
  const piped = { job: 'brief', at: '08:00', pipe: 'ppr-notify' };
  const briefArgv = jobArgv(piped, '/usr/bin/node', '/repo/dist/index.js');
  assert.deepEqual(programArgumentsFrom(plist(piped, briefArgv)), [
    '/bin/sh',
    '-c',
    shellCommand(piped, briefArgv),
  ]);
});

test('the crontab line quotes what a shell would otherwise split', () => {
  const line = crontabLine({ job: 'learn', at: '03:07' }, ['ppr', '--vault', '/my notes', 'memory', 'learn']);
  assert.match(line, /^7 3 \* \* \* /);
  assert.match(line, /'\/my notes'/);
});

test('a `%` in a vault path is escaped for cron and left alone for launchd', () => {
  const schedule = { job: 'learn', at: '03:00', vault: '/Users/me/100% notes' };
  const argv = jobArgv(schedule, '/usr/bin/node', '/repo/dist/index.js');
  const line = crontabLine(schedule, argv);

  // cron rewrites the first unescaped `%` into a newline and sends the rest to
  // the job on stdin, and it does that before /bin/sh sees the line — so the
  // quotes alone would still leave the 3am run executing `--vault /Users/me/100`.
  assert.match(line, /'\/Users\/me\/100\\% notes'/);
  assert.ok(!/[^\\]%/.test(line), `an unescaped % truncates the whole line: ${line}`);
  // Everything the job needs is still there, after the % rather than on stdin.
  assert.ok(line.endsWith(' memory learn --quiet'), line);

  // A plist has no such rule: `%` is an ordinary character inside a <string>,
  // and a backslash written there would end up in the path itself.
  const xml = plist(schedule, argv);
  assert.match(xml, /<string>\/Users\/me\/100% notes<\/string>/);
  assert.doesNotMatch(xml, /\\%/);
});

test('a `%` the user typed into a --pipe is escaped for cron too', () => {
  const schedule = { job: 'brief', at: '08:00', pipe: 'mail -s "100% done" me' };
  const argv = ['/usr/bin/node', '/repo/dist/index.js', 'brief', '--plain'];

  // The pipe is part of the same crontab line, and cron truncates at the first
  // unescaped `%` wherever it is — including inside a command somebody typed,
  // where the character meant a percent sign and nothing else.
  const line = crontabLine(schedule, argv);
  assert.ok(line.endsWith('| mail -s "100\\% done" me'), line);

  // launchd hands the same string to /bin/sh with no cron in between, so the
  // pipe stays exactly what was typed.
  assert.ok(shellCommand(schedule, argv).endsWith('| mail -s "100% done" me'), shellCommand(schedule, argv));
});

test('job labels are stable — they are what the OS is keyed on', () => {
  assert.equal(labelFor('learn'), 'sh.ppr.learn');
  assert.equal(labelFor('brief'), 'sh.ppr.brief');
});
