import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findVault } from '../dist/node.js';

/**
 * Builds a throwaway tree and hands `findVault` nothing it did not make: cwd,
 * `explicit`, and env are all injected, so the developer's own `~/ppr` and
 * `$PPR_DIR` cannot decide whether these pass. `realpath` because on macOS
 * `mkdtemp` hands back a `/var/...` symlink while `findVault` returns the path
 * it was given — comparing the two would fail for the wrong reason.
 */
async function withTree(dirs, fn) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ppr-paths-')));
  try {
    for (const dir of dirs) await mkdir(join(base, dir), { recursive: true });
    return await fn(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('the vault you name beats $PPR_DIR, and $PPR_DIR beats the one under your feet', async () => {
  await withTree(['named/.ppr', 'env/.ppr', 'project/.ppr', 'project/src/deep'], async (base) => {
    const home = join(base, 'home');
    const named = join(base, 'named');
    const fromEnv = join(base, 'env');
    const project = join(base, 'project');
    const cwd = join(project, 'src', 'deep');

    for (const [what, opts, want] of [
      [
        '--vault wins over everything else',
        { cwd, explicit: named, env: { HOME: home, PPR_DIR: fromEnv } },
        { root: named, exists: true },
      ],
      [
        '$PPR_DIR wins over the .ppr you are standing in',
        { cwd, env: { HOME: home, PPR_DIR: fromEnv } },
        { root: fromEnv, exists: true },
      ],
      [
        'with neither set, the .ppr above you is the vault',
        { cwd, env: { HOME: home } },
        { root: project, exists: true },
      ],
    ]) {
      assert.deepEqual(findVault(opts), want, what);
    }
  });
});

test('a project carries its own journal: the nearest .ppr walking up wins', async () => {
  await withTree(['outer/.ppr', 'outer/inner/.ppr', 'outer/inner/leaf/deeper', 'outer/other'], async (base) => {
    const env = { HOME: join(base, 'home') };
    const outer = join(base, 'outer');
    const inner = join(outer, 'inner');

    for (const [what, cwd, want] of [
      ['standing in it', inner, inner],
      ['two levels below it', join(inner, 'leaf', 'deeper'), inner],
      ['a sibling branch falls back to the outer one', join(outer, 'other'), outer],
    ]) {
      assert.deepEqual(findVault({ cwd, env }), { root: want, exists: true }, what);
    }
  });
});

test('with no marker anywhere, the vault is the default one under $HOME', async () => {
  await withTree(['bare/deep', 'home', 'made/ppr/.ppr'], async (base) => {
    const cwd = join(base, 'bare', 'deep');

    // Nothing on disk, so the answer is where a vault *would* go — which is
    // what lets the CLI say "no vault at ~/ppr" instead of guessing.
    assert.deepEqual(findVault({ cwd, env: { HOME: join(base, 'home') } }), {
      root: join(base, 'home', 'ppr'),
      exists: false,
    });

    assert.deepEqual(findVault({ cwd, env: { HOME: join(base, 'made') } }), {
      root: join(base, 'made', 'ppr'),
      exists: true,
    });
  });
});

test('naming a directory that is not a vault yet says so rather than searching on', async () => {
  await withTree(['empty', 'project/.ppr', 'project/src'], async (base) => {
    const env = { HOME: join(base, 'home') };
    const empty = join(base, 'empty');
    const cwd = join(base, 'project', 'src');

    // Both explicit forms stop the walk dead: an unmarked directory reports
    // itself with exists:false, never the .ppr that happens to be nearby.
    assert.deepEqual(findVault({ cwd, explicit: empty, env }), { root: empty, exists: false });
    assert.deepEqual(findVault({ cwd, env: { ...env, PPR_DIR: empty } }), { root: empty, exists: false });
  });
});

test('the walk up stops at the filesystem root instead of spinning', async () => {
  await withTree(['home'], async (base) => {
    // `dirname('/')` is `/`, so a walk that did not notice would never return.
    // Reaching the assertion at all is half of what this test checks.
    assert.deepEqual(findVault({ cwd: '/', env: { HOME: join(base, 'home') } }), {
      root: join(base, 'home', 'ppr'),
      exists: false,
    });
  });
});
