import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeStorage } from '../dist/node.js';
import { PprError } from '../dist/index.js';

/**
 * The vault is a subdirectory of the temp dir, so anything that escapes it
 * lands somewhere this test owns and can check is still empty.
 */
async function withStorage(fn) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ppr-storage-')));
  const root = join(base, 'vault');
  try {
    await mkdir(root, { recursive: true });
    return await fn(new NodeStorage(root), base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const refused = (promise, what) =>
  assert.rejects(
    promise,
    (err) => err instanceof PprError && err.code === 'EINVALID' && /escapes the vault/i.test(err.message),
    what,
  );

// Every one of these resolves outside the root: `..` walked up, an absolute
// path somewhere else entirely, or a relative path that climbs out mid-way.
const ESCAPES = ['..', '../escape.md', 'entries/../../escape.md', './entries/../../../escape.md', '/etc/passwd'];

test('a path that leaves the vault is refused, not followed', async () => {
  await withStorage(async (storage) => {
    for (const path of ESCAPES) {
      await refused(storage.read(path), `read ${path}`);
      await refused(storage.write(path, 'x'), `write ${path}`);
      await refused(storage.remove(path), `remove ${path}`);
      await refused(storage.list(path), `list ${path}`);
      await refused(storage.move(path, 'entries/here.md'), `move from ${path}`);
      await refused(storage.move('entries/here.md', path), `move to ${path}`);
    }
  });
});

test('an absolute path outside the vault writes nothing outside the vault', async () => {
  await withStorage(async (storage, base) => {
    await refused(storage.write(join(base, 'escape.md'), 'not yours'), 'a sibling of the vault');
    await refused(storage.write('../escape.md', 'not yours'), 'the parent directory');

    assert.deepEqual(await readdir(base), ['vault'], 'nothing was created next to the vault');
  });
});

test('ordinary vault-relative paths still round-trip', async () => {
  await withStorage(async (storage) => {
    await storage.write('entries/2026/08/note.md', 'hello');
    assert.equal(await storage.read('entries/2026/08/note.md'), 'hello');
    assert.deepEqual(
      (await storage.list('entries')).map((f) => f.path),
      ['entries/2026/08/note.md'],
    );

    await storage.remove('entries/2026/08/note.md');
    assert.equal(await storage.read('entries/2026/08/note.md'), null);
  });
});
