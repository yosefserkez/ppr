import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

/**
 * Runs the real binary against a throwaway vault, with AI forced off and the
 * config dir redirected so tests can never touch the developer's own setup.
 */
function ppr(vault, args, { input, editor } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        PPR_DIR: vault,
        PPR_NO_AI: '1',
        NO_COLOR: '1',
        XDG_CONFIG_HOME: join(vault, '.xdg'),
        ...(editor ? { PPR_EDITOR: editor } : {}),
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

    // The browser must never engage on a pipe — this is what keeps ppr scriptable.
    for (const args of [['ls'], ['ls', '--plain'], ['today'], ['browse'], ['search', 'alpha']]) {
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

test('a reminder with no readable date is logged, and says so', async () => {
  await withVault(async (dir) => {
    const { code, stderr } = await ppr(dir, ['remind me about the passport thing']);
    // Exit 0: nothing failed. The words are on disk either way (I2).
    assert.equal(code, 0);
    assert.match(stderr, /No date in that — logged it instead/);
    assert.match(stderr, /ppr remind tomorrow/, 'and the way to do it explicitly');

    const [entry] = JSON.parse((await ppr(dir, ['ls', '--json'])).stdout);
    assert.equal(entry.kind, 'log', 'a reminder with no day would never surface at all');
    assert.match(entry.title, /passport thing/);
    assert.equal(JSON.parse((await ppr(dir, ['brief', '--json'])).stdout).length, 0);

    // A day the user typed out is a different matter: that is an error.
    const bad = await ppr(dir, ['remind', 'call the dentist', '--at', 'whenever']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /Could not understand --at/);
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
