import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

/**
 * Runs the real binary against a throwaway vault, with AI forced off and the
 * config dir redirected so tests can never touch the developer's own setup.
 */
function ppr(vault, args, { input, editor, env } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        PPR_DIR: vault,
        PPR_NO_AI: '1',
        NO_COLOR: '1',
        XDG_CONFIG_HOME: join(vault, '.xdg'),
        ...(editor ? { PPR_EDITOR: editor } : {}),
        ...env,
      },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolvePromise({ code: code ?? 0, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

/**
 * A calendar day N days from now, in *local* time — which is the only kind of
 * day ppr has. `toISOString()` would name a different one either side of
 * midnight UTC, and the count of days would be off by one for half the world.
 */
function dayFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function withVault(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ppr-test-'));
  try {
    await ppr(dir, ['init']);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('init creates a vault that is just files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppr-test-'));
  try {
    const { code, stdout } = await ppr(dir, ['init']);
    assert.equal(code, 0);
    assert.match(stdout, /vault created/);
    assert.ok(await readFile(join(dir, 'README.md'), 'utf8'));
    assert.ok(await readFile(join(dir, '.ppr', 'config.json'), 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a bare argument logs an entry', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['shipped the thing #work']);
    assert.equal(code, 0);
    assert.match(stderr, /shipped the thing/);

    const { stdout } = await ppr(dir, ['ls', '--json']);
    const entries = JSON.parse(stdout);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'log');
    assert.deepEqual(entries[0].tags, ['work']);
  });
});

test('global flags work before or after the subcommand', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['first entry']);
    const after = await ppr(dir, ['ls', '--json']);
    const before = await ppr(dir, ['--json', 'ls']);
    assert.deepEqual(JSON.parse(after.stdout), JSON.parse(before.stdout));
  });
});

test('stdin feeds dump', async () => {
  await withVault(async (dir) => {
    const { code } = await ppr(dir, ['dump'], {
      input: 'um so basically the cache is cold on every deploy. it adds 30 seconds.',
    });
    assert.equal(code, 0);

    const { stdout } = await ppr(dir, ['ls', '--json']);
    const [entry] = JSON.parse(stdout);
    assert.equal(entry.kind, 'dump');
    assert.match(entry.body, /cache is cold/);
    assert.doesNotMatch(entry.body, /\bum\b/i);
  });
});

test('search finds entries and -q gives pipeable ids', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['the redis migration went badly']);
    await ppr(dir, ['lunch was fine']);

    const { stdout } = await ppr(dir, ['search', 'redis', '--json']);
    const hits = JSON.parse(stdout);
    assert.equal(hits.length, 1);
    assert.match(hits[0].title, /redis/);

    const ids = await ppr(dir, ['search', 'redis', '-q']);
    assert.match(ids.stdout.trim(), /^[0-9a-z]{16}$/);
  });
});

test('show resolves latest and prints the body', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['+', 'first']);
    await ppr(dir, ['+', 'second']);
    const { stdout } = await ppr(dir, ['show', 'latest', '--body']);
    assert.equal(stdout.trim(), 'second');
  });
});

test('path points at a real markdown file', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['find me on disk']);
    const { stdout } = await ppr(dir, ['path', 'latest']);
    const content = await readFile(stdout.trim(), 'utf8');
    assert.match(content, /find me on disk/);
  });
});

test('externally created files show up without any ppr involvement', async () => {
  await withVault(async (dir) => {
    await writeFile(
      join(dir, 'entries', 'manual.md'),
      '---\ntitle: Written in vim\nkind: note\n---\n\nHand made.\n',
    );
    const { stdout } = await ppr(dir, ['ls', '--json']);
    const entries = JSON.parse(stdout);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, 'Written in vim');
  });
});

test('missing entries exit 3, bad input exits 2', async () => {
  await withVault(async (dir) => {
    const missing = await ppr(dir, ['show', 'does-not-exist']);
    assert.equal(missing.code, 3);
    assert.match(missing.stderr, /No entry matching/);

    const bad = await ppr(dir, ['ls', '--since', 'not-a-date']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--since/);
  });
});

test('commands that need AI fail with a hint, not a stack trace', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['something to learn from']);
    const { code, stderr } = await ppr(dir, ['memory', 'learn', 'latest']);
    assert.equal(code, 4);
    assert.match(stderr, /ppr ai setup/);
    assert.doesNotMatch(stderr, /at Object|node:internal/);
  });
});

test('`ai test` says there is no backend rather than pretending to test one', async () => {
  await withVault(async (dir) => {
    // The live round trip cannot run here — no test may reach the network — so
    // what is pinned is the path a user with nothing configured actually hits.
    const { code, stdout, stderr } = await ppr(dir, ['ai', 'test']);
    assert.equal(code, 4);
    assert.match(stderr, /No model backend configured/);
    assert.match(stderr, /ppr ai setup/);
    assert.doesNotMatch(stderr, /at Object|node:internal/);
    assert.equal(stdout, '', 'nothing to report is nothing on stdout');
  });
});

test('everything still works without a model', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['deployed 4.2 to prod #release']);
    await ppr(dir, ['rolled it back, memory leak #release #incident']);

    const recap = await ppr(dir, ['recap', '--since', '1d']);
    assert.equal(recap.code, 0);
    assert.match(recap.stdout, /rolled it back/);

    // No model means no answer, but retrieval still has to point somewhere.
    const ask = await ppr(dir, ['ask', 'what happened with 4.2']);
    assert.equal(ask.code, 0);
    assert.match(ask.stdout, /Closest entries/);
    assert.match(ask.stdout, /deployed 4\.2 to prod/);

    const tags = await ppr(dir, ['tags', '--json']);
    assert.equal(JSON.parse(tags.stdout).find((t) => t.tag === 'release').count, 2);
  });
});

test('config writes to the vault layer with --local', async () => {
  await withVault(async (dir) => {
    const { code } = await ppr(dir, ['config', 'set', 'capture.maxTags', '3', '--local']);
    assert.equal(code, 0);
    const written = JSON.parse(await readFile(join(dir, '.ppr', 'config.json'), 'utf8'));
    assert.equal(written.capture.maxTags, 3);

    const { stdout } = await ppr(dir, ['config', 'get', 'capture.maxTags']);
    assert.equal(stdout.trim(), '3');
  });
});

test('a plugin gets a place to keep its settings, and not its secrets', async () => {
  await withVault(async (dir) => {
    const set = await ppr(dir, ['config', 'set', 'plugins.reminders-push.list', 'Errands']);
    assert.equal(set.code, 0);

    // The read path a plugin in any language can use: one command, one value.
    const get = await ppr(dir, ['config', 'get', 'plugins.reminders-push.list']);
    assert.equal(get.stdout.trim(), 'Errands');
    const list = await ppr(dir, ['config', 'list']);
    assert.match(list.stdout, /plugins\.reminders-push\.list\s+Errands/);

    // Or the file itself, for something that would rather not shell out.
    const file = JSON.parse(await readFile(join(dir, '.xdg', 'ppr', 'config.json'), 'utf8'));
    assert.equal(file.plugins['reminders-push'].list, 'Errands');

    // A token is refused here as firmly as anywhere else: this file has a
    // vault-layer twin, and a vault is assumed to be in git (I7).
    const secret = await ppr(dir, ['config', 'set', 'plugins.todoist.token', 'sk-live-abc123def456']);
    assert.equal(secret.code, 2);
    assert.match(secret.stderr, /config file is not one/);
  });
});

/** An executable shell script, for the tests that need a real subprocess. */
async function writeScript(dir, name, body) {
  await mkdir(join(dir, 'bin'), { recursive: true });
  const path = join(dir, 'bin', name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `"${path}"`;
}

/**
 * The PATH a spawned ppr is given whenever a test cares what is installed.
 *
 * Never `process.env.PATH`. A developer who has run `install.sh` has a real
 * `ppr-notify` and `ppr-reminders-push` on theirs, so inheriting it makes every
 * assertion below a claim about *that machine* rather than about ppr — and one
 * that only fails for the person who installed the thing. Only the dirs the
 * test wrote, plus the two the `#!/bin/sh` scripts need to find `cat`, `touch`,
 * and `wc`; a plugin never lands in either of those.
 */
const testPath = (...dirs) => [...dirs, '/usr/bin', '/bin'].join(':');

/**
 * Long enough for a child ppr let go of at the end of a command to finish.
 * The parent drains for two seconds and then unrefs, so anything asserted
 * about what a hook did has to outwait that.
 */
const settle = (ms = 2500) => new Promise((resolve) => setTimeout(resolve, ms));

/** The *user* config layer — the only place a hook is ever honoured from. */
async function writeUserConfig(dir, data) {
  await mkdir(join(dir, '.xdg', 'ppr'), { recursive: true });
  await writeFile(join(dir, '.xdg', 'ppr', 'config.json'), JSON.stringify(data, null, 2));
}

test('a hook is handed the whole event, on stdin and in its environment', async () => {
  await withVault(async (dir) => {
    const seen = join(dir, 'seen.json');
    const hook = await writeScript(dir, 'record', `cat > "${seen}"\necho "$PPR_EVENT|$PPR_VAULT" > "${seen}.env"`);
    await writeUserConfig(dir, { hooks: { 'entry.created': [hook] } });

    const { code } = await ppr(dir, ['+', 'shipped the migration']);
    assert.equal(code, 0);

    const event = JSON.parse(await readFile(seen, 'utf8'));
    assert.equal(event.event, 'entry.created');
    assert.equal(event.v, 1, 'the payload says which version it is');
    assert.equal(event.vault, dir);
    // Data-complete: a hook never has to call back into ppr to find out what
    // it was just told about.
    assert.equal(event.entry.body, 'shipped the migration');
    assert.equal(event.entry.kind, 'log');
    assert.ok(event.entry.id && event.entry.path);

    assert.equal((await readFile(`${seen}.env`, 'utf8')).trim(), `entry.created|${dir}`);
  });
});

test('a hook declared by a vault is never run, however the vault got there', async () => {
  await withVault(async (dir) => {
    const marker = join(dir, 'stranger-was-here');
    const hook = await writeScript(dir, 'stranger', `touch "${marker}"`);
    // The shape of a cloned repo: the vault's own config layer asks for it,
    // and the vault layer wins every other key in ppr.
    await writeFile(
      join(dir, '.ppr', 'config.json'),
      JSON.stringify({ hooks: { 'entry.created': [hook], 'entry.updated': [hook] } }),
    );

    assert.equal((await ppr(dir, ['+', 'a note'])).code, 0);
    assert.equal((await ppr(dir, ['ls'])).code, 0);
    assert.equal(existsSync(marker), false, 'cloning a vault must not run its shell');

    // Not merged into the config either, so nothing downstream can find one.
    const config = JSON.parse((await ppr(dir, ['config', 'list', '--json'])).stdout);
    assert.equal(config.hooks, undefined);

    // And `config set` sends people to the file rather than pretending.
    const set = await ppr(dir, ['config', 'set', 'hooks.entry.created', 'echo hi']);
    assert.equal(set.code, 2);
    assert.match(set.stderr, /~\/\.config\/ppr\/config\.json/);

    // The same declaration, moved to the user's own file, does run — so what
    // is asserted above is the layer it came from and not a broken fixture.
    await writeUserConfig(dir, { hooks: { 'entry.created': [hook] } });
    assert.equal((await ppr(dir, ['+', 'another note'])).code, 0);
    assert.equal(existsSync(marker), true, 'a hook you wrote yourself still runs');
  });
});

test('a hook that hangs does not hang the command', async () => {
  await withVault(async (dir) => {
    const marker = join(dir, 'eventually');
    const hook = await writeScript(dir, 'slow', `sleep 30\ntouch "${marker}"`);
    await writeUserConfig(dir, { hooks: { 'entry.created': [hook] } });

    const started = Date.now();
    const { code, stderr } = await ppr(dir, ['+', 'a note']);
    const elapsed = Date.now() - started;

    assert.equal(code, 0, 'a slow courier is not a failed write');
    assert.ok(elapsed < 15_000, `waited ${elapsed}ms for a hook that sleeps 30s`);
    assert.match(stderr, /still running/, 'and it said so, on stderr');
    assert.equal(existsSync(marker), false, 'the hook was left to finish on its own');
  });
});

test('a hook that fails costs one line, not the exit code and not stdout', async () => {
  await withVault(async (dir) => {
    const hook = await writeScript(dir, 'broken', `echo "garbage on stdout"\necho "no thanks" >&2\nexit 3`);
    await writeUserConfig(dir, { hooks: { 'entry.created': [hook, 'ppr-definitely-not-installed'] } });

    const { code, stdout, stderr } = await ppr(dir, ['--json', '+', 'a note']);
    assert.equal(code, 0, 'the entry is written; a hook is not part of the write');
    assert.match(stderr, /hook entry\.created: no thanks/);
    assert.match(stderr, /hook entry\.created: .*not found/i);
    // Whatever a hook prints is its own business, never ppr's output (I10).
    assert.ok(JSON.parse(stdout).id);
    assert.doesNotMatch(stdout, /garbage/);
  });
});

test('a hook that writes is one more entry, not a generation of processes', async () => {
  await withVault(async (dir) => {
    const log = join(dir, 'generations');
    // Self-capping on purpose: if the guard ever goes, this test must still
    // stop rather than fork-bomb whoever is running the suite. Three lines is
    // already proof of a cascade; one line is proof there was none.
    const hook = await writeScript(
      dir,
      'writes-back',
      [
        `echo fired >> "${log}"`,
        `[ "$(wc -l < "${log}")" -ge 3 ] && exit 0`,
        `"${process.execPath}" "${BIN}" + "written by the hook" >/dev/null 2>&1`,
      ].join('\n'),
    );
    await writeUserConfig(dir, { hooks: { 'entry.created': [hook] } });

    const { code } = await ppr(dir, ['+', 'the entry a person actually typed']);
    assert.equal(code, 0);
    await settle();

    // The write the hook made still happened — suppressing the cascade is not
    // suppressing the consumer.
    const entries = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    assert.equal(entries.length, 2, 'the hook wrote its entry');
    assert.equal(
      (await readFile(log, 'utf8')).trim().split('\n').length,
      1,
      'and that entry announced nothing, so there is no second generation',
    );
  });
});

test('`ppr hooks add` wires a command that then actually fires', async () => {
  await withVault(async (dir) => {
    const marker = join(dir, 'fired');
    await writeScript(dir, 'ppr-marker', `touch "${marker}"`);
    const env = { PATH: testPath(join(dir, 'bin')) };

    assert.equal((await ppr(dir, ['hooks', 'add', 'entry.created', 'ppr-marker'], { env })).code, 0);

    // A pen over visible config, not a second mechanism: what it writes is the
    // same block, in the same user-layer file, people were told to edit.
    const layer = JSON.parse(await readFile(join(dir, '.xdg', 'ppr', 'config.json'), 'utf8'));
    assert.deepEqual(layer.hooks, { 'entry.created': ['ppr-marker'] });

    await ppr(dir, ['+', 'a note'], { env });
    assert.equal(existsSync(marker), true, 'the runner reads the layer `hooks add` wrote');

    // Wiring is either there or not, so asking twice changes nothing.
    const again = await ppr(dir, ['hooks', 'add', 'entry.created', 'ppr-marker'], { env });
    assert.match(again.stderr, /already wired/i);
    const listed = JSON.parse((await ppr(dir, ['hooks', 'ls', '--json'], { env })).stdout);
    assert.deepEqual(listed.hooks['entry.created'], ['ppr-marker']);

    await rm(marker);
    assert.equal((await ppr(dir, ['hooks', 'rm', 'entry.created'], { env })).code, 0);
    await ppr(dir, ['+', 'another note'], { env });
    assert.equal(existsSync(marker), false, 'and unwiring it stops it');

    // The last command out takes the key with it, rather than leaving [].
    const after = JSON.parse(await readFile(join(dir, '.xdg', 'ppr', 'config.json'), 'utf8'));
    assert.equal(after.hooks, undefined);
  });
});

test('a hook on an event that does not exist is refused, not written', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['hooks', 'add', 'entry.create', 'echo hi']);
    assert.equal(code, 2);
    // The runner ignores a name it does not know, which is right for a file
    // edited by hand and useless as an answer to a typo — so the pen names
    // every event there is.
    assert.match(stderr, /entry\.created/);
    assert.match(stderr, /learn\.finished/);
    assert.equal(existsSync(join(dir, '.xdg', 'ppr', 'config.json')), false, 'and nothing was written');
  });
});

test('--dry-run writes nothing, runs nothing, and says what it would have', async () => {
  await withVault(async (dir) => {
    const marker = join(dir, 'fired');
    await writeScript(dir, 'ppr-marker', `touch "${marker}"`);
    const env = { PATH: testPath(join(dir, 'bin')) };
    await ppr(dir, ['hooks', 'add', 'entry.created', 'ppr-marker'], { env });

    const { code, stderr } = await ppr(dir, ['--dry-run', 'shipped the migration'], { env });
    assert.equal(code, 0);

    const entries = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    assert.equal(entries.length, 0, 'the vault is untouched');
    assert.equal(existsSync(marker), false, 'and so is everything downstream of it');

    // The plan is on stderr, and it names both halves: the file that would
    // have appeared and the consumer that would have been told about it.
    assert.match(stderr, /would write entries\/.*shipped-the-migration.*\.md/);
    assert.match(stderr, /would run ppr-marker\s+\(entry\.created\)/);
  });
});

test('--dry-run --json still prints the entry that would have been written', async () => {
  await withVault(async (dir) => {
    const { stdout, stderr } = await ppr(dir, ['--dry-run', '--json', 'a note about redis']);
    // The preview is the natural one: exactly what a real run would print,
    // with the plan kept off stdout so `--json` still pipes (I10).
    const entry = JSON.parse(stdout);
    assert.equal(entry.body, 'a note about redis');
    assert.match(entry.path, /^entries\//);
    assert.match(stderr, /^would /m);
    assert.equal(JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).length, 0);
  });
});

test('--dry-run on a write outside the vault leaves the file byte-identical', async () => {
  await withVault(async (dir) => {
    const file = join(dir, '.xdg', 'ppr', 'config.json');
    await ppr(dir, ['config', 'set', 'display.listLimit', '11']);
    const before = await readFile(file);

    const { code, stderr } = await ppr(dir, ['config', 'set', 'display.listLimit', '99', '--dry-run']);
    assert.equal(code, 0);
    assert.deepEqual(await readFile(file), before, 'not a byte');
    // And the plan is the delta, because a config layer holds only the delta.
    assert.match(stderr, /would write .*config\.json/);
    assert.match(stderr, /- display\.listLimit = 11/);
    assert.match(stderr, /\+ display\.listLimit = 99/);
  });
});

test('--dry-run shows the scheduler config without installing one', async () => {
  await withVault(async (dir) => {
    // HOME redirected: a test that wrote into a real ~/Library would be the
    // litter this suite refuses to leave.
    const { code, stdout, stderr } = await ppr(
      dir,
      ['schedule', 'add', 'brief', '--at', '08:30', '--dry-run'],
      { env: { HOME: dir } },
    );
    assert.equal(code, 0);
    if (process.platform === 'darwin') {
      assert.match(stderr, /would write .*sh\.ppr\.brief\.plist/);
      assert.match(stderr, /Hour 8, Minute 30/);
      assert.equal(existsSync(join(dir, 'Library', 'LaunchAgents', 'sh.ppr.brief.plist')), false);
    } else {
      // Elsewhere ppr prints a crontab line and installs nothing either way.
      assert.match(stdout, /^30 8 \* \* \* /m);
    }
  });
});

test('one answer to "is that program there", whichever command asks', async () => {
  await withVault(async (dir) => {
    // Not on PATH, but plainly there — which is how people write a `--pipe`
    // and a hook. Four call sites split a command line and asked; one of them
    // asked `findOnPath`, so it said no about a file it could see.
    const absolute = join(dir, 'bin', 'my-notify');
    await writeScript(dir, 'my-notify', 'cat >/dev/null');

    const hook = await ppr(dir, ['hooks', 'add', 'entry.created', `${absolute} --loud`]);
    assert.doesNotMatch(hook.stderr, /not on your PATH/);

    const piped = await ppr(dir, ['schedule', 'add', 'brief', '--pipe', `${absolute} --loud`, '--dry-run'], {
      env: { HOME: dir },
    });
    assert.doesNotMatch(piped.stderr, /not on your PATH/, 'the same question, the same answer');

    // And a name that really is absent still says so, from both.
    const missing = await ppr(dir, ['hooks', 'add', 'entry.updated', 'ppr-nope --loud']);
    assert.match(missing.stderr, /ppr-nope is not on your PATH/, 'the flags are not part of the name');
  });
});

test('--dry-run refuses `ppr edit`, because saving is the write', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['+', 'the original words']);
    const file = (await ppr(dir, ['path', 'latest'])).stdout.trim();
    const before = await readFile(file, 'utf8');

    // An editor that saves the moment it opens: every other editor in ppr
    // composes into a scratch file that Storage then writes, and a dry run
    // intercepts that. This one opens the entry itself (L8), so there is
    // nothing left to intercept.
    await writeScript(dir, 'saves-immediately', 'printf "\\nedited\\n" >> "$1"');
    const { code, stderr } = await ppr(dir, ['edit', 'latest', '--dry-run'], {
      editor: join(dir, 'bin', 'saves-immediately'),
    });
    assert.equal(code, 2);
    assert.match(stderr, /cannot preview `ppr edit`/);
    assert.equal(await readFile(file, 'utf8'), before, 'and the editor never opened');
  });
});

test('--dry-run previews what would happen, so an error still happens', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['memory', 'learn', '--dry-run']);
    assert.equal(code, 4, 'no model configured is still no model configured');
    assert.match(stderr, /needs a model/);
  });
});

test('`ppr plugins` answers who hears what, and what a flag currently means', async () => {
  await withVault(async (dir) => {
    await writeScript(dir, 'ppr-notify', 'exit 0');
    await writeScript(dir, 'ppr-standup', 'echo "first on PATH"');
    // A second copy, later on PATH. Whichever one `ppr standup` runs is the
    // one `ppr plugins` has to name, or the report is worse than none.
    await mkdir(join(dir, 'bin2'), { recursive: true });
    await writeFile(join(dir, 'bin2', 'ppr-standup'), '#!/bin/sh\necho "shadowed"\n', { mode: 0o755 });
    const env = { PATH: testPath(join(dir, 'bin'), join(dir, 'bin2')) };

    await ppr(dir, ['hooks', 'add', 'entry.created', 'ppr-notify'], { env });
    await ppr(dir, ['config', 'set', 'plugins.standup.style', 'weekly']);

    const report = JSON.parse((await ppr(dir, ['plugins', '--json'], { env })).stdout);
    assert.deepEqual(report.events, [
      { event: 'entry.created', command: 'ppr-notify', path: join(dir, 'bin', 'ppr-notify') },
    ]);
    // A flag names an intent; a name on PATH resolves the tool (I13). This is
    // where you find out which one, without knowing to run `which`.
    const notify = report.intents.find((i) => i.flag === 'brief --notify');
    assert.equal(notify.path, join(dir, 'bin', 'ppr-notify'));
    assert.equal(report.intents.find((i) => i.flag === 'remind --push').path, null);
    assert.equal(report.intents.find((i) => i.flag === 'schedule --pipe').tool, null);

    const standup = report.commands.filter((c) => c.word === 'standup');
    assert.equal(standup.length, 1, 'one row per word, first on PATH');
    assert.equal(standup[0].path, join(dir, 'bin', 'ppr-standup'));
    assert.match((await ppr(dir, ['standup'], { env })).stdout, /first on PATH/);

    assert.deepEqual(report.settings, { standup: { style: 'weekly' } });
  });
});

test('an unknown word runs `ppr-<word>` from PATH, the way git does', async () => {
  await withVault(async (dir) => {
    await writeScript(
      dir,
      'ppr-foo',
      'echo "foo ran with: $*"\necho "vault=$PPR_VAULT json=${PPR_JSON:-0} quiet=${PPR_QUIET:-0}"\nexit 7',
    );
    const env = { PATH: testPath(join(dir, 'bin')) };

    const ran = await ppr(dir, ['foo', 'a', '--verbose'], { env });
    // Its arguments are its own — ppr has no opinion about `--verbose`.
    assert.match(ran.stdout, /foo ran with: a --verbose/);
    assert.equal(ran.code, 7, "the plugin's exit code is ppr's exit code");
    assert.ok(ran.stdout.includes(`vault=${dir}`), 'it is told which vault it is in');

    // Global flags were hoisted out of argv before the word was even read
    // (L4), so they arrive as environment or not at all.
    const piped = await ppr(dir, ['--json', '-q', 'foo'], { env });
    assert.match(piped.stdout, /json=1 quiet=1/);

    // A built-in always wins: PATH may add commands, never redefine them.
    await writeScript(dir, 'ppr-ls', 'echo "hijacked"');
    const ls = await ppr(dir, ['ls'], { env });
    assert.doesNotMatch(ls.stdout, /hijacked/);
  });
});

test('a word with no command and no plugin is still never a note', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['sync']);
    assert.equal(code, 2);
    assert.match(stderr, /Unknown command: sync/);
    // The error names the convention, because that is how anyone finds out
    // they could have written one.
    assert.match(stderr, /ppr-sync/);
    // I11 holds: nothing landed in the vault.
    assert.equal(JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).length, 0);
  });
});

test('doctor reports without a vault instead of crashing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppr-empty-'));
  try {
    const { code, stdout } = await ppr(dir, ['doctor']);
    assert.equal(code, 0);
    assert.match(stdout, /Vault/i);
    assert.match(stdout, /ppr init/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export round-trips through json and jsonl', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['+', 'alpha']);
    await ppr(dir, ['+', 'beta']);

    const asJson = JSON.parse((await ppr(dir, ['export'])).stdout);
    assert.equal(asJson.length, 2);

    const lines = (await ppr(dir, ['export', '-f', 'jsonl'])).stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).title, 'beta');

    const md = (await ppr(dir, ['export', '-f', 'md'])).stdout;
    assert.match(md, /# beta/);
  });
});

test('export hands over the facts too, unless you asked for a kind', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['+', 'shipped the thing']);
    await ppr(dir, ['memory', 'add', 'the deploy key lives in 1Password']);

    // Facts stay out of lists and recaps (I12), but export means "everything
    // you have" — a backup that quietly drops the fact store loses data.
    const all = JSON.parse((await ppr(dir, ['export'])).stdout);
    assert.equal(all.length, 2);
    assert.ok(all.some((e) => e.kind === 'memory'), 'export omitted the fact');

    // An explicit filter is still exactly a filter.
    const logs = JSON.parse((await ppr(dir, ['export', '-k', 'log'])).stdout);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].kind, 'log');

    const facts = JSON.parse((await ppr(dir, ['export', '-k', 'memory'])).stdout);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].kind, 'memory');
  });
});

test('list commands stay plain when there is no terminal', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['alpha entry']);
    await ppr(dir, ['+', 'alpha entry again, following [[alpha entry]]']);
    await ppr(dir, ['+', 'still on [[alpha entry]] — alpha entry three']);

    // The browser must never engage on a pipe — this is what keeps ppr scriptable.
    for (const args of [
      ['ls'],
      ['ls', '--plain'],
      ['today'],
      ['browse'],
      ['search', 'alpha'],
      ['thread', 'alpha entry'],
      ['thread', 'alpha entry', '--plain'],
    ]) {
      const { code, stdout } = await ppr(dir, args);
      assert.equal(code, 0, `${args.join(' ')} exited ${code}`);
      assert.doesNotMatch(stdout, /\[\?1049h/, `${args.join(' ')} opened the alt screen`);
      assert.match(stdout, /alpha entry/);
    }
  });
});

test('edit opens the entry file itself, frontmatter included', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['editable entry']);
    const file = (await ppr(dir, ['path', 'latest'])).stdout.trim();

    const editor = join(dir, 'fake-editor.sh');
    await writeFile(editor, "#!/bin/sh\nsed -i \"\" \"s/^kind: log/kind: note/\" \"$1\"\nprintf \"\\nappended line\\n\" >> \"$1\"\n", { mode: 0o755 });

    const { code, stdout } = await ppr(dir, ['edit', 'latest'], { editor });
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /No changes/);

    const after = await readFile(file, 'utf8');
    assert.match(after, /appended line/);
    // The frontmatter edit survived, which a temp-file round trip would have lost.
    assert.match(after, /kind: note/);

    const [entry] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    assert.equal(entry.kind, 'note');
    assert.match(entry.body, /appended line/);
  });
});

test('edit reports when nothing changed', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['+', 'untouched']);
    const { stdout } = await ppr(dir, ['edit', 'latest'], { editor: '/usr/bin/true' });
    assert.match(stdout, /No changes/);
  });
});

test('setup answers can be piped, one line per question', async () => {
  await withVault(async (dir) => {
    // Sequential prompts over a pipe used to drop every answer after the first:
    // readline emits all lines at once and anything not being awaited was lost.
    const { code, stderr } = await ppr(dir, ['ai', 'setup'], { input: 'ollama\nqwen3\n\n' });
    assert.equal(code, 0, stderr);

    const config = JSON.parse(await readFile(join(dir, '.xdg', 'ppr', 'config.json'), 'utf8'));
    assert.equal(config.ai.provider, 'ollama');
    assert.equal(config.ai.model, 'qwen3');

    const { stdout } = await ppr(dir, ['ai', 'status', '--json']);
    assert.equal(JSON.parse(stdout).ai.provider, 'ollama');
  });
});

test('setup accepts a number as readily as a name', async () => {
  await withVault(async (dir) => {
    const { code } = await ppr(dir, ['ai', 'setup'], { input: '3\nllama3.2\n\n' });
    assert.equal(code, 0);
    const config = JSON.parse(await readFile(join(dir, '.xdg', 'ppr', 'config.json'), 'utf8'));
    assert.equal(config.ai.provider, 'ollama', 'option 3 is ollama');
  });
});

test('setup refuses an answer that is not an option', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['ai', 'setup'], { input: 'notathing\n' });
    assert.equal(code, 2);
    assert.match(stderr, /Not one of the options/);
  });
});

test('running out of answers is an error, not a hang', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['ai', 'setup'], { input: 'anthropic\n' });
    assert.equal(code, 2);
    assert.match(stderr, /No input left to answer/);
  });
});

test('doctor and setup report the same checks as data', async () => {
  await withVault(async (dir) => {
    const doctor = JSON.parse((await ppr(dir, ['doctor', '--json'])).stdout);
    const setup = JSON.parse((await ppr(dir, ['setup', '--json'])).stdout);

    // One registry, two renderings — they must never drift apart.
    assert.deepEqual(
      doctor.checks.map((c) => c.id),
      setup.checks.map((c) => c.id),
    );
    assert.equal(doctor.vault, dir);
    assert.equal(typeof doctor.ok, 'boolean');
  });
});

test('every broken check hands an agent the command that fixes it', async () => {
  await withVault(async (dir) => {
    const { checks } = JSON.parse((await ppr(dir, ['doctor', '--json'])).stdout);
    const broken = checks.filter((c) => c.status !== 'ok');
    assert.ok(broken.length, 'a fresh vault has things left to configure');

    for (const check of broken) {
      assert.ok(check.fix, `${check.id} is broken with no fix command`);
      assert.match(check.fix, /^(ppr|brew|ollama|xcode-select|upgrade)/);
    }
  });
});

test('checks follow the configuration they depend on', async () => {
  await withVault(async (dir) => {
    const ids = async () =>
      JSON.parse((await ppr(dir, ['doctor', '--json'])).stdout).checks.map((c) => c.id);

    assert.ok(!(await ids()).includes('voice.model'), 'no whisper checks before whisper is chosen');

    await ppr(dir, ['config', 'set', 'transcribe.provider', 'whisper-cpp']);
    const after = await ids();
    assert.ok(after.includes('voice.binary'), 'choosing whisper adds its binary check');
    assert.ok(after.includes('voice.model'), 'and its model check');

    await ppr(dir, ['config', 'set', 'ai.provider', 'anthropic']);
    assert.ok((await ids()).includes('ai.key'), 'a hosted backend adds a key check');
  });
});

test('setup without a terminal prints the plan instead of hanging', async () => {
  await withVault(async (dir) => {
    const { code, stdout } = await ppr(dir, ['setup']);
    assert.equal(code, 0);
    assert.match(stdout, /needs a terminal/);
    assert.match(stdout, /ppr config set/, 'the plan names the plain commands');
  });
});

test('voice refuses before recording when the chain is incomplete', async () => {
  await withVault(async (dir) => {
    // Provider set, model missing: this is the case that used to record first
    // and only then discover the problem, throwing the audio away.
    await ppr(dir, ['config', 'set', 'transcribe.provider', 'whisper-cpp']);
    const { code, stderr } = await ppr(dir, ['voice']);
    assert.equal(code, 4);
    assert.match(stderr, /model file|not installed/);
    assert.match(stderr, /ppr setup/);
  });
});

test('voice keeps the audio when transcription fails', async () => {
  await withVault(async (dir) => {
    const missing = join(dir, 'nope.wav');
    await ppr(dir, ['config', 'set', 'transcribe.provider', 'command']);
    await ppr(dir, ['config', 'set', 'transcribe.command', 'false']);

    const { code, stderr } = await ppr(dir, ['voice', missing]);
    assert.notEqual(code, 0);
    // The file was supplied rather than recorded, so no "your recording is
    // safe" line — but it must still fail cleanly rather than crash.
    assert.doesNotMatch(stderr, /node:internal/);
  });
});

test('setup lists its steps so one can be run on its own', async () => {
  await withVault(async (dir) => {
    const { code, stdout } = await ppr(dir, ['setup', '--list']);
    assert.equal(code, 0);
    for (const id of ['vault', 'ai', 'voice.model']) assert.match(stdout, new RegExp(id));

    const listed = JSON.parse((await ppr(dir, ['setup', '--list', '--json'])).stdout);
    assert.ok(listed.every((s) => s.id && s.label));
  });
});

test('a step id narrows the run to that family', async () => {
  await withVault(async (dir) => {
    const { checks } = JSON.parse((await ppr(dir, ['doctor', 'voice', '--json'])).stdout);
    const ids = checks.map((c) => c.id);
    assert.ok(ids.length && ids.every((id) => id === 'voice' || id.startsWith('voice.')));
    assert.ok(!ids.includes('vault'), 'unrelated steps stay out of the way');

    const one = JSON.parse((await ppr(dir, ['setup', 'ai.key', '--json'])).stdout);
    assert.deepEqual(one.checks.map((c) => c.id), ['ai.key']);
  });
});

test('a step name that does not exist lists the ones that do', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['setup', 'nonsense']);
    assert.equal(code, 2);
    assert.match(stderr, /No setup step matches/);
    assert.match(stderr, /voice\.model/, 'the error names the valid steps');
  });
});

test('a silent recording is diagnosed instead of transcribed into noise', async () => {
  await withVault(async (dir) => {
    // 16-bit mono WAV of pure digital silence.
    const samples = 16_000;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + samples * 2, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(32_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(samples * 2, 40);

    const file = join(dir, 'silence.wav');
    await writeFile(file, Buffer.concat([header, Buffer.alloc(samples * 2)]));

    await ppr(dir, ['config', 'set', 'transcribe.provider', 'command']);
    await ppr(dir, ['config', 'set', 'transcribe.command', 'echo you']);

    const { code, stderr } = await ppr(dir, ['voice', file, '--transcript-only']);
    assert.notEqual(code, 0, 'silence must not become an entry');
    assert.match(stderr, /silent/i);
    // The transcriber was never reached, so its hallucination never surfaced.
    assert.doesNotMatch(stderr, /^you$/m);
  });
});

test('a mistyped command never becomes an entry', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['serach', 'redis']);
    assert.equal(code, 2);
    assert.match(stderr, /Unknown command: serach/);
    assert.match(stderr, /Did you mean `ppr search`/);
    assert.match(stderr, /ppr "serach redis"/, 'the error shows how to log it anyway');

    assert.equal(JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).length, 0, 'nothing was written');
  });
});

test('a single word that is nearly a command is treated as a typo', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['lsit']);
    assert.equal(code, 2);
    assert.match(stderr, /Did you mean `ppr list`/);
    assert.equal(JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).length, 0);
  });
});

test('a quoted note is still one argument away', async () => {
  await withVault(async (dir) => {
    const { code } = await ppr(dir, ['shipped the redis migration #infra']);
    assert.equal(code, 0);
    const [entry] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    assert.equal(entry.title, 'shipped the redis migration');
    assert.deepEqual(entry.tags, ['infra']);
  });
});

test('+ captures without quoting', async () => {
  await withVault(async (dir) => {
    const { code } = await ppr(dir, ['+', 'rolled', 'it', 'back', 'twice']);
    assert.equal(code, 0);
    const [entry] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    assert.equal(entry.body, 'rolled it back twice');
  });
});

test('a bare word is never a note, however ordinary it looks', async () => {
  await withVault(async (dir) => {
    // "lunch" is a plausible note and "sync" is a plausible command, and argv
    // cannot tell them apart — so neither is written without an explicit ask.
    for (const word of ['lunch', 'sync', 'add-something']) {
      const { code, stderr } = await ppr(dir, [word]);
      assert.equal(code, 2, `${word} should not be captured`);
      assert.match(stderr, /ppr \+ /, 'the error shows the explicit way');
      // Quoting cannot help a single word, so it must not be suggested.
      assert.doesNotMatch(stderr, /To log it as a note: {2}ppr "/);
    }
    assert.equal(JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).length, 0);

    // And the explicit way works.
    assert.equal((await ppr(dir, ['+', 'lunch'])).code, 0);
    const [entry] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    assert.equal(entry.body, 'lunch');
  });
});

test('a bare ppr reports instead of capturing', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['already here']);

    const { code, stdout } = await ppr(dir, []);
    assert.equal(code, 0);
    assert.match(stdout, /already here/, 'it shows what you wrote today');
    assert.match(stdout, /ppr "text"/, 'and how to write more');

    // The point of the change: running ppr by accident costs nothing.
    assert.equal(JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).length, 1);
  });
});

test('a bare ppr says what ppr knows, and only when it knows something', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['+', 'shipped the importer']);

    const bare = await ppr(dir, []);
    assert.doesNotMatch(bare.stdout, /fact/, 'an empty fact store is not advertised');
    assert.doesNotMatch(bare.stdout, /ppr brief/, 'nor is the command for reading it');

    await ppr(dir, ['memory', 'add', "Priya's birthday is in a few days"]);
    const [fact] = JSON.parse((await ppr(dir, ['memory', 'ls', '--json'])).stdout);
    const path = join(dir, fact.path);
    const soon = new Date(Date.now() + 5 * 86_400_000);
    const day = `${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
    const raw = await readFile(path, 'utf8');
    await writeFile(path, raw.replace(/^---\n/, `---\ndate: 0000-${day}\nrecurs: yearly\n`));

    const { code, stdout } = await ppr(dir, []);
    assert.equal(code, 0);
    assert.match(stdout, /1 fact/, 'the header counts what is known');
    assert.match(stdout, /1 entry\b/, 'and a fact is not counted as an entry');
    assert.match(stdout, /Priya's birthday.*in \d+ days/, 'the soonest thing is named');
    assert.match(stdout, /ppr brief/, 'and the command that lists the rest');
  });
});

test('an overview counts what is waiting, and names where to see it', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['+', 'shipped the importer']);
    const quiet = await ppr(dir, []);
    assert.doesNotMatch(quiet.stdout, /todo/, 'an empty list is not advertised');

    await ppr(dir, ['todo', 'buy milk']);
    await ppr(dir, ['todo', 'renew the passport']);
    const { stdout } = await ppr(dir, []);
    assert.match(stdout, /2 todos/);
    // A count with no command under it is a dead end.
    assert.match(stdout, /ppr todos/);

    // A dated one belongs to the upcoming line and is not counted twice.
    await ppr(dir, ['remind', 'tomorrow', 'call the dentist']);
    const dated = await ppr(dir, []);
    assert.match(dated.stdout, /2 todos/);
    assert.match(dated.stdout, /call the dentist/);
  });
});

test('the brief says how much is waiting with no date on it', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['remind', 'tomorrow', 'call the dentist']);
    await ppr(dir, ['todo', 'buy milk']);

    for (const args of [['brief'], ['brief', '--plain']]) {
      const { stdout } = await ppr(dir, args);
      assert.match(stdout, /call the dentist/, `${args.join(' ')} still counts down to the dated one`);
      assert.match(stdout, /1 open todo — ppr todos/, `${args.join(' ')} names the rest`);
    }

    // The items are dated things, and a script filtering them on `.overdue`
    // must not have to step over a sentence.
    const items = JSON.parse((await ppr(dir, ['brief', '--json'])).stdout);
    assert.equal(items.length, 1);
    assert.equal(items[0].text, 'call the dentist');

    // Nothing waiting, nothing said.
    await withVault(async (empty) => {
      await ppr(empty, ['remind', 'tomorrow', 'call the dentist']);
      assert.doesNotMatch((await ppr(empty, ['brief'])).stdout, /todo/);
    });
  });
});

test('piping still captures, because a pipe is deliberate', async () => {
  await withVault(async (dir) => {
    const { code } = await ppr(dir, [], { input: 'straight from a pipe\n' });
    assert.equal(code, 0);
    const [entry] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    assert.equal(entry.body, 'straight from a pipe');
  });
});

test('help and version are commands, not notes', async () => {
  await withVault(async (dir) => {
    const help = await ppr(dir, ['help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: ppr/);

    const scoped = await ppr(dir, ['help', 'search']);
    assert.equal(scoped.code, 0);
    assert.match(scoped.stdout, /search titles, bodies, and tags/);

    const version = JSON.parse((await ppr(dir, ['version', '--json'])).stdout);
    assert.equal(typeof version.version, 'string');

    assert.equal(JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).length, 0);
  });
});

test('a mistyped help is a suggestion, not an entry', async () => {
  await withVault(async (dir) => {
    for (const typo of ['hlep', 'halp']) {
      const { code, stderr } = await ppr(dir, [typo]);
      assert.equal(code, 2);
      assert.match(stderr, /Did you mean `ppr help`/);
    }
    assert.equal(JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).length, 0);
  });
});

test('help for a command that does not exist suggests one that does', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['help', 'serach']);
    assert.equal(code, 2);
    assert.match(stderr, /Did you mean `ppr help search`/);
  });
});

test('add and new reach the same place as write', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['add', 'from the add alias']);
    await ppr(dir, ['new', 'from the new alias']);
    const bodies = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).map((e) => e.body);
    assert.deepEqual(bodies.sort(), ['from the add alias', 'from the new alias']);
  });
});

test('`ppr ai key` works out where the key goes on its own', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['config', 'set', 'ai.provider', 'openai']);
    await ppr(dir, ['config', 'set', 'ai.baseUrl', 'https://openrouter.ai/api/v1']);

    // No variable name typed: ppr names it after the endpoint and records that.
    const { code, stdout } = await ppr(dir, ['ai', 'key', 'sk-or-v1-testkeyvalue', '--json']);
    assert.equal(code, 0);
    const { name, file } = JSON.parse(stdout);
    assert.equal(name, 'OPENROUTER_API_KEY');

    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(stored.OPENROUTER_API_KEY, 'sk-or-v1-testkeyvalue');

    const config = JSON.parse(await readFile(join(dir, '.xdg', 'ppr', 'config.json'), 'utf8'));
    assert.equal(config.ai.apiKeyEnv, 'OPENROUTER_API_KEY', 'the config points at the variable');
    assert.ok(!JSON.stringify(config).includes('sk-or-v1'), 'the key never lands in config');
  });
});

test('`ppr ai key` repairs a config that has the key pasted into it', async () => {
  await withVault(async (dir) => {
    const configFile = join(dir, '.xdg', 'ppr', 'config.json');
    await mkdir(dirname(configFile), { recursive: true });
    const key = 'sk-or-v1-2f45c9a5de610d3475826159ea58892955b79aa98026cc73acf5764';
    await writeFile(
      configFile,
      // The mistake: apiKeyEnv holding the key rather than a variable name.
      JSON.stringify({ ai: { provider: 'openai', model: 'x', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: key } }),
    );

    const { code } = await ppr(dir, ['ai', 'key', key]);
    assert.equal(code, 0);

    const config = JSON.parse(await readFile(configFile, 'utf8'));
    // The name must come from the endpoint, never from the pasted key itself.
    assert.equal(config.ai.apiKeyEnv, 'OPENROUTER_API_KEY');
    const stored = JSON.parse(await readFile(join(dir, '.xdg', 'ppr', 'credentials.json'), 'utf8'));
    assert.deepEqual(Object.keys(stored), ['OPENROUTER_API_KEY']);
  });
});

test('a misconfigured key never costs you an entry', async () => {
  await withVault(async (dir) => {
    await mkdir(join(dir, '.xdg', 'ppr'), { recursive: true });
    await writeFile(
      join(dir, '.xdg', 'ppr', 'config.json'),
      JSON.stringify({ ai: { provider: 'openai', model: 'x', apiKeyEnv: 'sk-or-v1-broken-config-value' } }),
    );
    const { code } = await ppr(dir, ['a note written while the key is wrong']);
    assert.equal(code, 0);
    assert.match((await ppr(dir, ['ls', '--json'])).stdout, /while the key is wrong/);
  });
});

test('pasting a key into ai.apiKeyEnv is refused with the command that works', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['config', 'set', 'ai.apiKeyEnv', 'sk-or-v1-testkeyvalue']);
    assert.equal(code, 2);
    assert.match(stderr, /name of an environment variable/);
    assert.match(stderr, /ppr ai key/);
  });
});

test('the quoted and + capture paths produce identical entries', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['shipped the thing #work']);
    await ppr(dir, ['+', 'shipped', 'the', 'thing', '#work']);

    const [second, first] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    // Same body, kind, tags and title: one code path, so they cannot drift.
    for (const field of ['body', 'kind', 'title']) {
      assert.equal(second[field], first[field], `${field} differs between the two paths`);
    }
    assert.deepEqual(second.tags, first.tags);
  });
});

test('a reminder is an entry with a day on it, and it is in the timeline', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['remind', 'tomorrow', 'call the dentist']);
    assert.equal(code, 0);
    assert.match(stderr, /call the dentist/);

    const [entry] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    assert.equal(entry.kind, 'reminder');
    assert.equal(entry.title, 'call the dentist', 'the day is not part of what you wrote');
    assert.match(entry.path, /^entries\//, 'you did say it, so it belongs to the day you said it');

    const [item] = JSON.parse((await ppr(dir, ['brief', '--json'])).stdout);
    assert.equal(item.days, 1);
    assert.equal(item.kind, 'reminder');
    assert.equal(item.overdue, false);
    assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/);
  });
});

test('the quoted and the explicit ways to set a reminder are one path', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['remind', 'tomorrow', 'call the dentist']);
    await ppr(dir, ['remind me to call the dentist tomorrow']);

    const [second, first] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    for (const field of ['kind', 'title']) {
      assert.equal(second[field], first[field], `${field} differs between the two paths`);
    }
    const brief = JSON.parse((await ppr(dir, ['brief', '--json'])).stdout);
    assert.equal(brief.length, 2);
    assert.deepEqual([...new Set(brief.map((i) => i.days))], [1], 'both land on the same day');
  });
});

test('a todo is a reminder with no day on it, and it has somewhere to be', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['todo', 'buy milk']);
    assert.equal(code, 0);
    assert.match(stderr, /buy milk/);

    const [entry] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    assert.equal(entry.kind, 'reminder', 'the same kind: a todo is a reminder without the day');
    // No `date:` at all rather than an empty one — absence is the shape, and
    // it is what keeps a todo out of every dated view (I3's `extra` stays bare).
    assert.equal(entry.extra, undefined);
    assert.doesNotMatch(await readFile(join(dir, entry.path), 'utf8'), /^date:/m);

    // Nothing to count down to, so nothing in the calendar view — which is
    // exactly why `ppr todos` had to exist before this could be stored.
    assert.equal(JSON.parse((await ppr(dir, ['brief', '--json'])).stdout).length, 0);

    const [todo] = JSON.parse((await ppr(dir, ['todos', '--json'])).stdout);
    assert.equal(todo.text, 'buy milk');
    assert.equal(todo.overdue, false);
    assert.equal(todo.done, false);
    assert.equal(todo.date, undefined, 'no day means no day, not a guessed one');
    assert.equal((await ppr(dir, ['todos', '-q'])).stdout.trim(), entry.id);
  });
});

test('the quoted and the explicit ways to add a todo are one path', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['todo', 'buy milk']);
    await ppr(dir, ['todo: buy milk']);

    const [second, first] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    for (const field of ['body', 'kind', 'title']) {
      assert.equal(second[field], first[field], `${field} differs between the two paths`);
    }
    // `--at` makes it a reminder, because that is all a reminder is.
    await ppr(dir, ['todo', 'chase the invoice', '--at', 'tomorrow']);
    const [dated] = JSON.parse((await ppr(dir, ['brief', '--json'])).stdout);
    assert.equal(dated.text, 'chase the invoice');
    assert.equal(dated.days, 1);
  });
});

test('todos are ordered the way you would work through them', async () => {
  await withVault(async (dir) => {
    // Written oldest first, so the undated pair also proves it is age and not
    // insertion order that decides — ids are monotonic (L2), so they can be
    // compared.
    await ppr(dir, ['todo', 'buy milk']);
    await ppr(dir, ['todo', 'renew the passport']);
    await ppr(dir, ['remind', 'in 3 days', 'water the plants']);
    await ppr(dir, ['remind', 'tomorrow', 'call the dentist']);
    await ppr(dir, ['remind', 'tomorrow', 'file the expenses']);

    // Two overdue, by hand: the date is one line of frontmatter, which is the
    // only interface there is.
    const byTitle = Object.fromEntries(
      JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).map((e) => [e.title, e]),
    );
    for (const [title, days] of [['call the dentist', -2], ['file the expenses', -9]]) {
      const path = join(dir, byTitle[title].path);
      const raw = await readFile(path, 'utf8');
      await writeFile(path, raw.replace(/^date: .*$/m, `date: ${dayFromNow(days)}`));
    }

    const todos = JSON.parse((await ppr(dir, ['todos', '--json'])).stdout);
    assert.deepEqual(
      todos.map((t) => t.text),
      [
        // Most overdue first: the one that has been waiting longest to be
        // decided about.
        'file the expenses',
        'call the dentist',
        // Then dated, soonest first.
        'water the plants',
        // Then undated, oldest first — the one being avoided is at the top.
        'buy milk',
        'renew the passport',
      ],
    );
    assert.deepEqual(todos.map((t) => t.overdue), [true, true, false, false, false]);
    assert.equal(todos[0].days, -9);
    // A fortnight late is still on the list. `ppr brief` forgets after a week
    // because it is a heads-up; this is a list, and a list you can finish is
    // one nothing falls off.
    assert.equal(JSON.parse((await ppr(dir, ['brief', '--json'])).stdout).length, 2);
  });
});

test('done takes a todo off the list without deleting anything', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['todo', 'buy milk']);
    const [entry] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);

    // A dateless intention completes like a dated one: there is something to
    // stop showing, which is the whole test `complete()` applies.
    const done = await ppr(dir, ['done', entry.id]);
    assert.equal(done.code, 0);

    assert.equal(JSON.parse((await ppr(dir, ['todos', '--json'])).stdout).length, 0);
    const all = JSON.parse((await ppr(dir, ['todos', '--all', '--json'])).stdout);
    assert.equal(all.length, 1);
    assert.equal(all[0].done, true);
    assert.match(await readFile(join(dir, entry.path), 'utf8'), /status: done/);
  });
});

test('a reminder with no readable date is kept as a todo, and says so', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['remind me about the passport thing']);
    // Exit 0: nothing failed. The words are on disk either way (I2).
    assert.equal(code, 0);
    assert.match(stderr, /No date in that — kept as a todo/);
    assert.match(stderr, /ppr remind tomorrow/, 'and the way to do it explicitly');

    // It used to become a log, which was right when a dateless intention had
    // nowhere to appear. `ppr todos` is that surface now, so it stays what it
    // was said as.
    const [entry] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    assert.equal(entry.kind, 'reminder');
    assert.match(entry.title, /passport thing/);
    // Still nothing to count down to, so still nothing in the brief.
    assert.equal(JSON.parse((await ppr(dir, ['brief', '--json'])).stdout).length, 0);
    const [todo] = JSON.parse((await ppr(dir, ['todos', '--json'])).stdout);
    assert.match(todo.text, /passport thing/);
    assert.equal(todo.date, undefined);

    // A day the user typed out is a different matter: that is an error.
    const bad = await ppr(dir, ['remind', 'call the dentist', '--at', 'whenever']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /Could not understand --at/);
  });
});

test('nothing leaves the vault for Reminders.app unless it was asked to', async () => {
  await withVault(async (dir) => {
    // Off is the default: writing into another app is not something ppr does
    // to you. Only the paths that spawn nothing are exercised here — the
    // decision itself is unit-tested in porcelain.test.js, and a test suite
    // that creates real reminders is one that leaves litter behind.
    assert.equal((await ppr(dir, ['config', 'get', 'remind.push'])).stdout.trim(), 'false');

    for (const args of [
      ['remind', 'tomorrow', 'call the dentist'],
      ['remind me to call the dentist tomorrow'],
      ['remind', 'tomorrow', 'call the dentist', '--no-push'],
      // A dateless line is a todo, so there is no moment to ring at however
      // loudly the flag asked.
      ['remind', 'the passport thing', '--push'],
      ['todo', 'buy milk'],
    ]) {
      const { code, stderr } = await ppr(dir, args);
      assert.equal(code, 0, `${args.join(' ')} should still save`);
      assert.doesNotMatch(stderr, /ppr-reminders-push/, `${args.join(' ')} should hand over nothing`);
    }
  });
});

test('--push hands the entry to whatever `ppr-reminders-push` is', async () => {
  await withVault(async (dir) => {
    const seen = join(dir, 'pushed.json');
    // A stand-in for the one ppr ships. The flag names the intent; this name
    // on PATH is what resolves the tool — swap the file, swap the meaning.
    await writeScript(dir, 'ppr-reminders-push', `cat > "${seen}"`);
    const env = { PATH: testPath(join(dir, 'bin')) };

    const { code, stderr } = await ppr(dir, ['remind', 'tomorrow', 'call the dentist', '--push'], { env });
    assert.equal(code, 0);
    assert.match(stderr, /→ ppr-reminders-push/, 'and it said where the copy went');

    // What it is handed is the `entry.created` event, in exactly the shape a
    // hook on `entry.created` receives: one serializer, two doors.
    const event = JSON.parse(await readFile(seen, 'utf8'));
    assert.equal(event.event, 'entry.created');
    assert.equal(event.v, 1);
    assert.equal(event.entry.kind, 'reminder');
    assert.equal(event.entry.body, 'call the dentist');
    assert.equal(event.entry.extra.date, dayFromNow(1), 'the day, without reading the file back');

    // `remind.push` is the same act without the flag, and it reaches the same
    // program — `ppr "remind me …"` included (L18).
    await ppr(dir, ['config', 'set', 'remind.push', 'true']);
    await ppr(dir, ['remind me to renew the passport tomorrow'], { env });
    assert.match(JSON.parse(await readFile(seen, 'utf8')).entry.body, /renew the passport/);
  });
});

test('--push with nothing installed explains itself and keeps the entry', async () => {
  await withVault(async (dir) => {
    await mkdir(join(dir, 'empty'), { recursive: true });
    const { code, stderr } = await ppr(dir, ['remind', 'tomorrow', 'call the dentist', '--push'], {
      env: { PATH: testPath(join(dir, 'empty')) },
    });

    assert.equal(code, 0, 'a missing courier is not a failed write');
    assert.match(stderr, /Nothing called ppr-reminders-push on your PATH/);
    assert.match(stderr, /entry is in your vault/i);
    assert.equal(JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).length, 1);
  });
});

test('a plugin that exits 0 with something to say is still heard', async () => {
  await withVault(async (dir) => {
    // The real shape of this is `ppr-notify` on Linux: one line on stderr and
    // exit 0, because a courier that cannot deliver must not turn a capture
    // red. Swallowing it would leave the user told a copy was made.
    await writeScript(dir, 'ppr-reminders-push', 'echo "ppr-reminders-push: not on this platform" >&2');
    const env = { PATH: testPath(join(dir, 'bin')) };

    const { code, stderr } = await ppr(dir, ['remind', 'tomorrow', 'call the dentist', '--push'], { env });
    assert.equal(code, 0);
    assert.match(stderr, /not on this platform/);
    assert.doesNotMatch(stderr, /→/, 'and no claim that the copy was made');
  });
});

test('--notify sends the brief to whatever `ppr-notify` is', async () => {
  await withVault(async (dir) => {
    const seen = join(dir, 'notified.txt');
    await writeScript(dir, 'ppr-notify', `printf 'title=%s\\n' "$2" > "${seen}"\ncat >> "${seen}"`);
    const env = { PATH: testPath(join(dir, 'bin')) };
    await ppr(dir, ['remind', 'tomorrow', 'call the dentist']);

    const { code, stdout } = await ppr(dir, ['brief', '--notify'], { env });
    assert.equal(code, 0);

    const notified = await readFile(seen, 'utf8');
    // The banner is built from the items, not from the prose: a title that is
    // one line and a body that is two.
    assert.match(notified, /title=ppr · call the dentist/);
    assert.match(notified, /—/);
    // I10: --notify is a side effect, so stdout is what it was without it.
    assert.equal(stdout, (await ppr(dir, ['brief'])).stdout);

    // And with nothing on PATH the convention is named rather than guessed at.
    await mkdir(join(dir, 'empty'), { recursive: true });
    const bare = await ppr(dir, ['brief', '--notify'], { env: { PATH: testPath(join(dir, 'empty')) } });
    assert.equal(bare.code, 0);
    assert.match(bare.stderr, /Nothing called ppr-notify on your PATH/);
    assert.equal(bare.stdout, stdout, 'the output is the output either way');
  });
});

test('done stops a reminder coming up, and leaves the file where it was', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['remind', 'tomorrow', 'call the dentist']);
    const [entry] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);

    const done = await ppr(dir, ['done', entry.id]);
    assert.equal(done.code, 0);
    assert.match(done.stderr, /file stays/);

    assert.equal(JSON.parse((await ppr(dir, ['brief', '--json'])).stdout).length, 0);
    const raw = await readFile(join(dir, entry.path), 'utf8');
    assert.match(raw, /status: done/);
    assert.match(raw, /call the dentist/);
    // Still an entry: `ppr ls` is a record of what you wrote, not a queue.
    assert.equal(JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).length, 1);

    // A log has nothing to complete, and a mistyped ref must not look like one.
    await ppr(dir, ['+', 'lunch was fine']);
    const refused = await ppr(dir, ['done', 'lunch']);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /nothing to complete/);
  });
});

test('a reminder nobody finished is shown as overdue, not hidden', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['remind', 'tomorrow', 'call the dentist']);
    const [entry] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);

    // Move its day into the past by hand — which is also the point: the date
    // is one line of frontmatter, editable like everything else.
    const path = join(dir, entry.path);
    const raw = await readFile(path, 'utf8');
    const past = dayFromNow(-3);
    await writeFile(path, raw.replace(/^date: .*$/m, `date: ${past}`));

    const [item] = JSON.parse((await ppr(dir, ['brief', '--json'])).stdout);
    assert.equal(item.days, -3);
    assert.equal(item.overdue, true);
    assert.match((await ppr(dir, ['brief', '--plain'])).stdout, /3 days overdue/);
    assert.match((await ppr(dir, ['context'])).stdout, /3 days overdue/);

    // A fortnight late and it stops asking; a brief that never forgets is a
    // guilt list, not a heads-up.
    const older = dayFromNow(-14);
    await writeFile(path, raw.replace(/^date: .*$/m, `date: ${older}`));
    assert.equal(JSON.parse((await ppr(dir, ['brief', '--json'])).stdout).length, 0);
  });
});

test('a date typed into any file by hand reaches the brief', async () => {
  await withVault(async (dir) => {
    const soon = dayFromNow(5);
    await writeFile(
      join(dir, 'entries', 'lease.md'),
      `---\ntitle: Lease renewal\nkind: note\ndate: ${soon}\n---\n\nThe landlord wants an answer.\n`,
    );

    const [item] = JSON.parse((await ppr(dir, ['brief', '--json'])).stdout);
    assert.equal(item.text, 'Lease renewal');
    assert.equal(item.kind, 'note', 'no ppr command was involved in making this');
    assert.equal(item.days, 5);
  });
});

test('a fact you add by hand is stored outside the journal and stays out of it', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['+', 'shipped the importer']);
    const added = await ppr(dir, ['memory', 'add', "Emily's birthday is 20 October"]);
    assert.equal(added.code, 0);

    // It is a file in memory/, not an entry in the timeline.
    const [fact] = JSON.parse((await ppr(dir, ['memory', 'ls', '--json'])).stdout);
    assert.match(fact.path, /^memory\//);
    assert.equal(fact.origin, 'manual');

    const list = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    assert.equal(list.length, 1, 'a fact is not a thing that happened');
    assert.equal(list[0].kind, 'log');

    // …but it is still addressable, so `show` and `rm` work on it.
    const shown = await ppr(dir, ['show', fact.id, '--body']);
    assert.match(shown.stdout, /20 October/);
    assert.match((await ppr(dir, ['memory', 'why', fact.id])).stdout, /yourself/);
  });
});

test('an empty brief posts nothing, and says that is what it did', async () => {
  await withVault(async (dir) => {
    // The one --notify case a test may exercise for real: with nothing
    // upcoming there is no banner to post, on any platform. A daily "nothing
    // coming up" ping is how a notification channel stops being read.
    const { code, stdout, stderr } = await ppr(dir, ['brief', '--notify']);
    assert.equal(code, 0);
    assert.match(stdout, /Nothing coming up\./);
    assert.match(stderr, /no notification sent/i);
    // I10: --notify is a side effect, so stdout is what it was without it.
    assert.equal(stdout, (await ppr(dir, ['brief'])).stdout);
  });
});

test('brief counts down to a dated fact with no model at all', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['memory', 'add', "Priya's birthday is 12 September"]);
    // `memory add` stores no date; a person editing the file supplies one.
    const [fact] = JSON.parse((await ppr(dir, ['memory', 'ls', '--json'])).stdout);
    const path = join(dir, fact.path);
    const raw = await readFile(path, 'utf8');
    await writeFile(path, raw.replace(/^---\n/, '---\ndate: 0000-09-12\nrecurs: yearly\n'));

    const { code, stdout } = await ppr(dir, ['brief', '--within', '400', '--json']);
    assert.equal(code, 0);
    const [item] = JSON.parse(stdout);
    assert.match(item.date, /-09-12$/);
    assert.ok(item.days >= 0 && item.days <= 366);

    assert.match((await ppr(dir, ['brief', '--within', '400', '--plain'])).stdout, /12 Sep/);

    // The date is what `brief` runs on, so a script has to be able to read it
    // back off the fact — it lives in `extra`, which the entry projection
    // deliberately does not carry.
    const [dated] = JSON.parse((await ppr(dir, ['memory', 'ls', '--json'])).stdout);
    assert.equal(dated.date, '0000-09-12');
    assert.equal(dated.recurs, 'yearly');
  });
});

test('a fact added by hand can carry its date, and is never read for one', async () => {
  await withVault(async (dir) => {
    const added = await ppr(dir, [
      'memory', 'add', "Emily's birthday is 20 October", '--date', '2002-10-20', '--recurs', 'yearly',
    ]);
    assert.equal(added.code, 0);

    const [fact] = JSON.parse((await ppr(dir, ['memory', 'ls', '--json'])).stdout);
    assert.equal(fact.date, '2002-10-20');
    assert.equal(fact.recurs, 'yearly');
    assert.equal(fact.origin, 'manual');

    // The point of the flag: a hand-added birthday now reaches the brief,
    // which it never could before.
    const [item] = JSON.parse((await ppr(dir, ['brief', '--within', '400', '--json'])).stdout);
    assert.equal(item.id, fact.id);
    assert.ok(item.ordinal >= 24, 'and it knows which birthday this is');

    // Without the flag the date stays unread — a manual fact is your words,
    // not something to be parsed — but the flag gets named.
    const bare = await ppr(dir, ['memory', 'add', "Priya's birthday is 12 September"]);
    assert.match(bare.stderr, /--date/);
    const [, priya] = JSON.parse((await ppr(dir, ['memory', 'ls', '--json'])).stdout).reverse();
    assert.equal(priya.date, undefined, 'nothing inferred it for you');

    // A fact with nothing dateish about it gets no advice.
    const plain = await ppr(dir, ['memory', 'add', 'Emily likes dark chocolate']);
    assert.doesNotMatch(plain.stderr, /--date/);

    for (const [argv, message] of [
      [['memory', 'add', 'x', '--date', 'whenever'], /Could not understand --date/],
      [['memory', 'add', 'x', '--date', '2002-10-20', '--recurs', 'monthly'], /only understands "yearly"/],
      [['memory', 'add', 'x', '--recurs', 'yearly'], /needs a --date/],
    ]) {
      const bad = await ppr(dir, argv);
      assert.equal(bad.code, 2, argv.join(' '));
      assert.match(bad.stderr, message);
    }
  });
});

test('context hands another tool everything ppr knows, without a model', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['+', 'rewrote the CSV importer today']);
    await ppr(dir, ['memory', 'add', 'Emily likes dark chocolate']);

    const { code, stdout } = await ppr(dir, ['context', 'emily']);
    assert.equal(code, 0);
    assert.match(stdout, /## What is known/);
    assert.match(stdout, /Emily likes dark chocolate/);

    const parsed = JSON.parse((await ppr(dir, ['context', 'emily', '--json'])).stdout);
    assert.equal(parsed.query, 'emily');
    assert.equal(parsed.facts.length, 1);
    assert.ok(parsed.now);

    // NaN is a silent "no limit" to a slice, so a number ppr cannot read has
    // to be refused rather than passed through as one.
    for (const argv of [['context', '--limit', 'abc'], ['memory', 'ls', '--limit', 'abc'], ['brief', '--within', 'soon']]) {
      const bad = await ppr(dir, argv);
      assert.equal(bad.code, 2, `${argv.join(' ')} was accepted`);
      assert.match(bad.stderr, /must be a number/);
    }
  });
});

test('a search that would have matched a fact says so, on stderr', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['+', 'lunch was fine']);
    await ppr(dir, ['memory', 'add', 'Emily likes dark chocolate']);

    const { code, stdout, stderr } = await ppr(dir, ['search', 'emily']);
    assert.equal(code, 0);
    assert.match(stderr, /1 fact match too/);
    assert.match(stderr, /ppr search emily -k memory/, 'and the search that finds it');
    assert.doesNotMatch(stdout, /fact match too/, 'stdout stays pipeable');
    assert.doesNotMatch(stdout, /dark chocolate/, 'the fact itself is still out of the timeline');

    // Nothing to point at once the kind was asked for, or when piping data.
    assert.doesNotMatch((await ppr(dir, ['search', 'emily', '-k', 'memory'])).stderr, /match too/);
    const json = await ppr(dir, ['search', 'emily', '--json']);
    assert.deepEqual(JSON.parse(json.stdout), []);
    assert.doesNotMatch(json.stderr, /match too/);
  });
});

test('learning needs a model, and says so instead of failing silently', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['+', 'something worth remembering']);
    const { code, stderr } = await ppr(dir, ['memory', 'learn']);
    assert.equal(code, 4);
    assert.match(stderr, /needs a model/);
    assert.match(stderr, /memory add/, 'the offline way to do it is named');
  });
});

test('nothing to settle is a normal outcome, not an error', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['memory', 'add', 'Emily likes chocolate']);
    const { code, stdout } = await ppr(dir, ['memory', 'review']);
    assert.equal(code, 0);
    assert.match(stdout, /Nothing to settle/);
    assert.equal(JSON.parse((await ppr(dir, ['memory', 'review', '--json'])).stdout).length, 0);
  });
});

/**
 * A vault holding one real story: a business idea worked through over a
 * fortnight, dropped for half a year, picked up again — with the tags and the
 * links drifting the way they actually do, and noise around it that shares a
 * word and nothing else.
 *
 * Written as files rather than through `ppr +`, because the whole point is
 * that the entries sit months apart and a capture command can only write
 * today. Days are relative so the fixture never goes stale, and every one of
 * them is in the past.
 */
async function coffeeStory(dir) {
  const entry = async (name, daysAgo, title, kind, tags, body) =>
    writeFile(
      join(dir, 'entries', `${name}.md`),
      `---\nkind: ${kind}\ntitle: "${title}"\ncreated: ${dayFromNow(-daysAgo)}T09:00:00\n${tags.length ? `tags: [${tags.join(', ')}]\n` : ''}---\n\n${body}\n`,
    );

  await entry('s1', 320, 'Coffee subscription idea', 'log', ['coffee', 'idea'],
    'Idea: a monthly subscription shipping office-sized bags to small studios.');
  await entry('s2', 318, 'What the beans actually cost', 'log', ['coffee', 'idea'],
    'Rang two wholesalers about the [[Coffee subscription idea]]. £11-14/kg at the volumes I could commit to.');
  await entry('s3', 305, 'Talked to a roaster', 'note', ['coffee', 'idea'],
    'The roaster on Mare Street would white-label the [[Coffee subscription idea]] at 40 bags a month.');
  await entry('s4', 290, 'Unit economics, roughly', 'note', ['coffee', 'numbers'],
    'Worked the numbers after [[Talked to a roaster]]. Margin is 22% at 40 bags, 31% at 120.');
  await entry('s5', 275, 'Shelving the coffee idea', 'log', ['coffee'],
    'Parking it. [[Unit economics, roughly]] says it only works above 200 subscribers.');
  // Half a year of silence, and then the thing comes back.
  await entry('s6', 90, 'Back to the coffee idea', 'log', ['coffee', 'business'],
    'Two studios asked where I get my beans. Reopening [[Shelving the coffee idea]].');
  await entry('s7', 83, 'Subscription versus one-off boxes', 'note', ['coffee', 'business'],
    'Following [[Back to the coffee idea]]: a one-off box has no retention problem and no margin either.');
  await entry('s8', 70, 'Where the coffee idea stands', 'note', ['business'],
    'After [[Subscription versus one-off boxes]] the open question is whether referrals get me to 200.');
  // Dealt with, and still part of the story.
  await writeFile(
    join(dir, 'entries', 'done.md'),
    `---\nkind: reminder\ntitle: "email the roaster about wholesale pricing"\ncreated: ${dayFromNow(-78)}T09:00:00\ndate: ${dayFromNow(-76)}\nstatus: done\n---\n\nemail the roaster about pricing for [[Back to the coffee idea]]\n`,
  );

  await entry('n1', 319, 'The office coffee machine broke again', 'log', ['office'],
    'Third time this quarter. The office coffee machine is done for.');
  await entry('n2', 289, 'Blocked on the auth review', 'log', ['work'], 'Blocked on the auth review again.');
  await entry('n3', 89, 'The redis migration went badly', 'log', ['infra'], 'Rolled back the redis migration at 2am.');
  await entry('n4', 82, 'Renewed the design tool subscription', 'log', ['tools'],
    'Renewed the annual subscription for the design tool.');
}

test('a thread picks up the story it was about, and leaves the noise alone', async () => {
  await withVault(async (dir) => {
    await coffeeStory(dir);
    const { code, stdout } = await ppr(dir, ['thread', 'coffee', 'subscription']);
    assert.equal(code, 0);

    for (const title of [
      'Coffee subscription idea',
      'What the beans actually cost',
      'Talked to a roaster',
      'Unit economics, roughly',
      'Shelving the coffee idea',
      'Back to the coffee idea',
      'Subscription versus one-off boxes',
      'Where the coffee idea stands',
      'email the roaster about wholesale pricing',
    ]) {
      assert.match(stdout, new RegExp(title), `${title} is part of the story`);
    }
    // A shared word, a shared tag nobody else has, and a coincidence of the
    // word "subscription" are all not threads.
    for (const noise of ['coffee machine', 'auth review', 'redis migration', 'design tool']) {
      assert.doesNotMatch(stdout, new RegExp(noise), `${noise} is not part of it`);
    }

    // Oldest first, and the half-year silence is visible in the middle of it.
    assert.ok(
      stdout.indexOf('Coffee subscription idea') < stdout.indexOf('Where the coffee idea stands'),
      'a thread is read forwards',
    );
    assert.match(stdout, /months later/, 'the shape of time is in the offline view too');
    assert.doesNotMatch(stdout, /\[\?1049h/, 'the browser never engages on a pipe (I4)');
  });
});

test('a thread is the same thread to a script, whatever it looks like on a terminal', async () => {
  await withVault(async (dir) => {
    await coffeeStory(dir);
    const { stdout } = await ppr(dir, ['thread', 'coffee', 'subscription', '--json']);
    const thread = JSON.parse(stdout);

    assert.equal(thread.query, 'coffee subscription');
    assert.equal(thread.seededBy, 'query');
    assert.equal(thread.entries.length, 9);
    assert.ok(thread.entries.every((e) => e.id && e.reason && e.why));
    assert.ok(thread.entries.some((e) => e.reason === 'linked' && e.hops >= 1));
    assert.equal(thread.gaps.length, 1);
    assert.ok(thread.gaps[0].days > 150, 'the silence is measured, not described');
    assert.ok(
      thread.entries.some((e) => e.id === thread.gaps[0].before),
      'a gap names the entries either side of it',
    );

    // -q is the pipe: ids, in the same order, and nothing else.
    const quiet = await ppr(dir, ['thread', 'coffee', 'subscription', '-q']);
    assert.deepEqual(
      quiet.stdout.trim().split('\n'),
      thread.entries.map((e) => e.id),
    );

    // An id names one entry, and the walk from it finds the same story.
    const byRef = JSON.parse((await ppr(dir, ['thread', thread.entries[4].id, '--json'])).stdout);
    assert.equal(byRef.seededBy, 'ref');
    assert.equal(byRef.entries.length, 9);
  });
});

test('no thread is said out loud, with the nearest entries instead of an invented one', async () => {
  await withVault(async (dir) => {
    await coffeeStory(dir);

    const missing = await ppr(dir, ['thread', 'quantum', 'computing']);
    assert.equal(missing.code, 0, 'nothing to follow is not an error');
    assert.match(missing.stdout, /No thread here/);

    // One entry mentions redis, and one entry is not a line of thought.
    const thin = await ppr(dir, ['thread', 'redis']);
    assert.match(thin.stdout, /No thread here/);
    assert.doesNotMatch(thin.stdout, /months later/);

    // Something that does connect, offered as a place to start.
    const near = await ppr(dir, ['thread', 'machine']);
    assert.match(near.stdout, /No thread here/);
    assert.match(near.stdout, /Nearest/);
    assert.match(near.stdout, /coffee machine/);
  });
});

test('a thought coming back for the third time says so, once, on stderr', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['write', '-T', 'Redis migration', 'the redis migration is going ahead']);
    const second = await ppr(dir, ['+', 'planning the [[redis migration]] rollout']);
    assert.doesNotMatch(second.stderr, /continues a thread/, 'two entries are a pair, not a thread');

    const third = await ppr(dir, ['+', 'rolled back the [[redis migration]] at 2am']);
    assert.match(third.stderr, /continues a thread \(3 entries\)/);
    assert.match(third.stderr, /ppr thread \w{6}/, 'and says how to read it');
    assert.doesNotMatch(third.stdout, /continues a thread/, 'stdout is still only the entry (I10)');

    // The count is the thread the command it names will show.
    const id = /ppr thread (\w{6})/.exec(third.stderr)[1];
    assert.equal((await ppr(dir, ['thread', id, '-q'])).stdout.trim().split('\n').length, 3);

    // Nothing in common but the English language.
    const stray = await ppr(dir, ['+', 'lunch was fine and the weather held']);
    assert.doesNotMatch(stray.stderr, /continues a thread/);
  });
});

test('a capture that is being parsed is never chatted to', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['write', '-T', 'Redis migration', 'the redis migration is going ahead']);
    await ppr(dir, ['+', 'planning the [[redis migration]] rollout']);

    const asJson = await ppr(dir, ['--json', '+', 'rolled back the [[redis migration]]']);
    assert.doesNotMatch(asJson.stderr, /continues a thread/);
    assert.ok(JSON.parse(asJson.stdout).id, 'and stdout is exactly the entry');

    const quiet = await ppr(dir, ['-q', '+', 'still on the [[redis migration]]']);
    assert.doesNotMatch(quiet.stderr, /continues a thread/);
    assert.match(quiet.stdout.trim(), /^\w{16}$/);
  });
});

/**
 * A `porcelain` binding: what `--notify` and `--push` mean when a name on PATH
 * is not enough. The security half is the same claim as the hooks tests above
 * and is asserted the same way — whether a *vault* may say which program runs
 * is a fact about a whole run, so it lives out here rather than in a unit test.
 */
test('a binding says what --notify means, and a vault never gets to', async () => {
  await withVault(async (dir) => {
    const seen = join(dir, 'bound.txt');
    const conventional = join(dir, 'convention-ran');
    await writeScript(dir, 'my-notifier', `printf '%s\\n' "$@" > "${seen}"\ncat >> "${seen}"`);
    // The conventional name, sitting right there on PATH. A binding has to win
    // over it, or it has not solved the thing it exists for: saying what
    // `--notify` means without owning a name and winning PATH order.
    await writeScript(dir, 'ppr-notify', `touch "${conventional}"`);
    const env = { PATH: testPath(join(dir, 'bin')) };
    const binding = { notify: `"${join(dir, 'bin', 'my-notifier')}" --urgent` };

    await ppr(dir, ['remind', 'tomorrow', 'call the dentist']);
    await writeUserConfig(dir, { porcelain: binding });

    const notified = await ppr(dir, ['brief', '--notify'], { env });
    assert.equal(notified.code, 0);
    assert.equal(existsSync(conventional), false, 'a binding wins over the name on PATH');

    // Same contract as `ppr-notify`, to the argument: the binding's own
    // arguments, then --title, then the title, and the body on stdin. Anything
    // else and a published plugin would break the moment somebody bound it.
    const recorded = await readFile(seen, 'utf8');
    assert.match(recorded, /^--urgent\n--title\nppr · call the dentist\n/);
    assert.match(recorded, /—/, 'the body still arrives on stdin');
    // I10: a notification is a side effect either way.
    assert.equal(notified.stdout, (await ppr(dir, ['brief'])).stdout);

    // The same block, moved into the vault — the shape of a cloned repo, and
    // the layer that wins every ordinary key. It is not honoured, and the
    // convention answers instead, so what is asserted is the layer and not a
    // broken fixture.
    await writeUserConfig(dir, {});
    await writeFile(join(dir, '.ppr', 'config.json'), JSON.stringify({ porcelain: binding }));
    const cloned = await ppr(dir, ['brief', '--notify'], { env });
    assert.equal(cloned.code, 0);
    assert.equal(existsSync(conventional), true, 'a vault cannot redirect a flag at its own program');

    // Not merged into the config either, so nothing downstream can find one.
    const config = JSON.parse((await ppr(dir, ['config', 'list', '--json'])).stdout);
    assert.equal(config.porcelain, undefined);

    // And `config set` sends people to the file that is honoured, at any scope.
    for (const args of [
      ['config', 'set', 'porcelain.notify', 'my-notifier'],
      ['config', 'set', '--local', 'porcelain.notify', 'my-notifier'],
    ]) {
      const set = await ppr(dir, args);
      assert.equal(set.code, 2);
      assert.match(set.stderr, /~\/\.config\/ppr\/config\.json/);
    }
  });
});

test('a bound push is a push, and gets the event a hook would get', async () => {
  await withVault(async (dir) => {
    const seen = join(dir, 'pushed.json');
    await writeScript(dir, 'todoist-add', `cat > "${seen}"\necho "$PPR_EVENT|$PPR_VAULT" > "${seen}.env"`);
    // Nothing called `ppr-reminders-push` anywhere: the binding is the only
    // reason this can work at all.
    const env = { PATH: testPath(join(dir, 'bin')) };
    await writeUserConfig(dir, {
      porcelain: { 'reminders-push': `${join(dir, 'bin', 'todoist-add')} --project Inbox` },
    });

    const { code, stderr } = await ppr(dir, ['remind', 'tomorrow', 'call the dentist', '--push'], { env });
    assert.equal(code, 0);
    // `pushDecision` has to see a binding as available, or this would say
    // "nothing installed" with the binding sitting right there.
    assert.doesNotMatch(stderr, /Nothing called/);
    assert.match(stderr, /→ .*todoist-add --project Inbox/, 'and it said where the copy went');

    const event = JSON.parse(await readFile(seen, 'utf8'));
    assert.equal(event.event, 'entry.created');
    assert.equal(event.entry.kind, 'reminder');
    assert.equal(event.vault, dir);
    assert.equal((await readFile(`${seen}.env`, 'utf8')).trim(), `entry.created|${dir}`);
  });
});

test('`ppr plugins` reports a binding, and whether the program at its front is there', async () => {
  await withVault(async (dir) => {
    await writeScript(dir, 'my-notifier', 'exit 0');
    const env = { PATH: testPath(join(dir, 'bin')) };
    await writeUserConfig(dir, {
      porcelain: {
        notify: `${join(dir, 'bin', 'my-notifier')} --urgent`,
        // A typo in a file. The report has to show it as one.
        'reminders-push': 'todoist-add --project Inbox',
      },
    });

    const report = JSON.parse((await ppr(dir, ['plugins', '--json'], { env })).stdout);
    const notify = report.intents.find((i) => i.flag === 'brief --notify');
    assert.equal(notify.intent, 'notify');
    assert.equal(notify.bound, `${join(dir, 'bin', 'my-notifier')} --urgent`);
    assert.equal(notify.tool, notify.bound, 'the command line is what runs');
    assert.equal(notify.path, join(dir, 'bin', 'my-notifier'), 'resolved from the program at its front');

    const push = report.intents.find((i) => i.flag === 'remind --push');
    assert.equal(push.bound, 'todoist-add --project Inbox');
    assert.equal(push.path, null, 'and a report that claimed it was there would be worse than none');

    const table = (await ppr(dir, ['plugins'], { env })).stdout;
    assert.match(table, /porcelain\.notify → /);

    // The other half of the same fact: what a person is told when the binding
    // names something that is not there. A typo in a file, said as one.
    const broken = await ppr(dir, ['remind', 'tomorrow', 'call the dentist', '--push'], { env });
    assert.match(broken.stderr, /porcelain\.reminders-push is set to/);
    assert.match(broken.stderr, /nothing called todoist-add to run/);
    assert.match(broken.stderr, /entry is in your vault/i);
    assert.equal(JSON.parse((await ppr(dir, ['ls', '--json'])).stdout).length, 1);
  });
});
