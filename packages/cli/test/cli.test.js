import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
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
    await ppr(dir, ['first']);
    await ppr(dir, ['second']);
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

test('everything still works without a model', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['deployed 4.2 to prod #release']);
    await ppr(dir, ['rolled it back, memory leak #release #incident']);

    const recap = await ppr(dir, ['recap', '--since', '1d']);
    assert.equal(recap.code, 0);
    assert.match(recap.stdout, /rolled it back/);

    const ask = await ppr(dir, ['ask', 'what happened with 4.2']);
    assert.equal(ask.code, 0);
    assert.match(ask.stdout, /Sources/);

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
    assert.match(stdout, /vault/);
    assert.match(stdout, /ppr init/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export round-trips through json and jsonl', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['alpha']);
    await ppr(dir, ['beta']);

    const asJson = JSON.parse((await ppr(dir, ['export'])).stdout);
    assert.equal(asJson.length, 2);

    const lines = (await ppr(dir, ['export', '-f', 'jsonl'])).stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).title, 'beta');

    const md = (await ppr(dir, ['export', '-f', 'md'])).stdout;
    assert.match(md, /# beta/);
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
    await ppr(dir, ['untouched']);
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
