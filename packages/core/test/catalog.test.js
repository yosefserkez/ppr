import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Catalog,
  DEFAULT_CONFIG,
  MemoryStorage,
  Vault,
  createEntry,
  serializeEntry,
  shortId,
} from '../dist/index.js';

const CACHE = '.ppr/cache/index.json';

/**
 * A file holding three things YAML can say and JSON cannot: `.inf` and `.nan`
 * are numbers, and a `!!timestamp` is a Date. Obsidian and anything else
 * sharing the vault are allowed to write all three (I3).
 */
const EXOTIC = 'entries/2026/08/2026-08-05-0900-budget-cc33.md';
const EXOTIC_FILE = [
  '---',
  'id: 0a1b2c3d4e5fcc33',
  'kind: note',
  'title: Budget',
  'created: 2026-08-05T09:00:00',
  'budget: .inf',
  'score: .nan',
  'obsidian-due: !!timestamp 2026-08-12T00:00:00Z',
  '---',
  '',
  'No cap on the quarter.',
  '',
].join('\n');

/** A storage that says which files were actually opened, and nothing else. */
function counting(storage, reads) {
  return {
    read: (path) => {
      reads.push(path);
      return storage.read(path);
    },
    write: (path, data) => storage.write(path, data),
    remove: (path) => storage.remove(path),
    list: (prefix) => storage.list(prefix),
    stat: (path) => storage.stat(path),
  };
}

test('two entries under one title is a question, not a silent pick', async () => {
  const catalog = await new Catalog(new MemoryStorage()).load();
  const monday = createEntry({ body: 'blocked on the migration', title: 'Standup' }, new Date(2026, 0, 5, 9, 0));
  const tuesday = createEntry({ body: 'unblocked it', title: 'Standup' }, new Date(2026, 0, 6, 9, 0));
  catalog.upsert(monday);
  catalog.upsert(tuesday);

  // This used to hand back Tuesday's, because it was newer, and say nothing.
  assert.throws(
    () => catalog.resolve('Standup'),
    (err) => {
      assert.equal(err.code, 'EAMBIGUOUS');
      assert.match(err.message, /matches 2 entries/);
      // Offered under the handle every listing prints, so a line of the hint
      // can be typed straight back.
      assert.ok(err.hint.includes(shortId(monday.id)), err.hint);
      assert.ok(err.hint.includes(shortId(tuesday.id)), err.hint);
      return true;
    },
  );
  assert.equal(catalog.resolve(shortId(monday.id)).id, monday.id, 'and the hint is answerable');

  catalog.forget(tuesday);
  assert.equal(catalog.resolve('Standup').id, monday.id, 'one match still needs no ceremony');
});

test('a cached order never outlives the change that broke it', async () => {
  const storage = new MemoryStorage();
  const catalog = await new Catalog(storage).load();
  const older = createEntry({ body: 'older', kind: 'log' }, new Date(2026, 0, 1, 9, 0));
  const newer = createEntry({ body: 'newer', kind: 'log' }, new Date(2026, 0, 2, 9, 0));
  const fact = createEntry({ body: 'Emily likes chocolate', kind: 'memory' }, new Date(2026, 0, 3, 9, 0));

  // Each list is asked for between mutations: a stale answer is only visible
  // if something read the previous one.
  catalog.upsert(older);
  assert.deepEqual(catalog.entries().map((e) => e.id), [older.id]);
  catalog.upsert(newer);
  assert.deepEqual(catalog.entries().map((e) => e.id), [newer.id, older.id]);
  catalog.upsert(fact);
  assert.deepEqual(catalog.entries().map((e) => e.id), [fact.id, newer.id, older.id]);
  assert.deepEqual(catalog.timeline().map((e) => e.id), [newer.id, older.id], 'a fact is on no timeline (I12)');
  catalog.forget(newer);
  assert.deepEqual(catalog.timeline().map((e) => e.id), [older.id]);
  assert.deepEqual(catalog.entries().map((e) => e.id), [fact.id, older.id]);

  // Nothing was ever written to storage, so a reload empties the vault — and
  // an emptying reload calls nothing that would notice a change file by file.
  await catalog.load();
  assert.deepEqual(catalog.entries(), []);
  assert.deepEqual(catalog.timeline(), []);
});

test('the order a caller is handed is its own to sort', async () => {
  const catalog = await new Catalog(new MemoryStorage()).load();
  const older = createEntry({ body: 'older', kind: 'log' }, new Date(2026, 0, 1, 9, 0));
  const newer = createEntry({ body: 'newer', kind: 'log' }, new Date(2026, 0, 2, 9, 0));
  catalog.upsert(older);
  catalog.upsert(newer);

  // `Vault.all()` hands this straight through to a host. A consumer reversing
  // or truncating what it was given must not reorder the vault for the next
  // reader — which is the whole risk of remembering the sort at all.
  const mine = catalog.entries();
  mine.reverse();
  mine.pop();
  catalog.timeline().reverse();

  assert.deepEqual(catalog.entries().map((e) => e.id), [newer.id, older.id]);
  assert.deepEqual(catalog.timeline().map((e) => e.id), [newer.id, older.id]);
});

test('deleting the index cache changes nothing but speed', async () => {
  const storage = new MemoryStorage();

  // One of each thing a vault holds, because the cache has to reproduce
  // *identity* and not just words: an id-less file's id is derived from its
  // path, and a file ppr could not read as YAML carries its block verbatim.
  const written = createEntry({ body: 'Shipped it #work', kind: 'log', title: 'Shipped it' }, new Date(2026, 7, 1, 9, 0));
  await storage.write(written.path, serializeEntry(written));
  const fact = createEntry({ body: 'Emily likes chocolate', kind: 'memory' }, new Date(2026, 7, 2, 9, 0));
  await storage.write(fact.path, serializeEntry(fact));
  await storage.write('entries/2026/08/2026-08-03-0900-by-hand-aa11.md', 'Written in vim, no frontmatter at all.\n');
  await storage.write(
    'entries/2026/08/2026-08-04-0900-broken-bb22.md',
    '---\nid: [unclosed\n  tabs:\tare not YAML\n---\n\nThe words still land.\n',
  );

  const reads = [];
  const seen = counting(storage, reads);

  await (await new Catalog(seen).load()).persist();
  assert.ok(await storage.read(CACHE), 'there is a cache to delete');

  reads.length = 0;
  const warm = await new Catalog(seen).load();
  assert.deepEqual(reads, [CACHE], 'a warm load opens the cache and not one note');

  await storage.remove(CACHE);
  reads.length = 0;
  const cold = await new Catalog(seen).load();
  assert.equal(reads.length, 5, 'and with no cache every note is read and parsed again');

  const broken = cold.entries().find((e) => e.path.endsWith('broken-bb22.md'));
  assert.ok(broken?.raw, 'the fixture is still a file whose frontmatter ppr cannot read');

  assert.equal(cold.size(), 4);
  assert.deepEqual(
    cold.entries(),
    warm.entries(),
    'the same entries, down to the derived ids and the frontmatter ppr kept verbatim',
  );
});

test('a value JSON cannot carry is parsed again rather than cached wrong', async () => {
  const storage = new MemoryStorage();

  await storage.write(EXOTIC, EXOTIC_FILE);
  const written = createEntry({ body: 'Shipped it #work', kind: 'log', title: 'Shipped it' }, new Date(2026, 7, 1, 9, 0));
  await storage.write(written.path, serializeEntry(written));
  await storage.write('entries/2026/08/2026-08-03-0900-by-hand-aa11.md', 'Written in vim, no frontmatter at all.\n');
  await storage.write(
    'entries/2026/08/2026-08-04-0900-broken-bb22.md',
    '---\nid: [unclosed\n  tabs:\tare not YAML\n---\n\nThe words still land.\n',
  );

  const reads = [];
  const seen = counting(storage, reads);

  await (await new Catalog(seen).load()).persist();
  const stored = JSON.parse(await storage.read(CACHE));
  assert.equal(stored.files[EXOTIC], undefined, 'the one file the round trip would change is left out');
  assert.equal(Object.keys(stored.files).length, 3, 'and the ordinary three are still cached');

  reads.length = 0;
  const warm = await new Catalog(seen).load();
  assert.deepEqual(reads, [CACHE, EXOTIC], 'so a warm load re-reads that file and only that file');

  await storage.remove(CACHE);
  reads.length = 0;
  const cold = await new Catalog(seen).load();
  assert.equal(reads.length, 5);

  // The property, stated directly: a hit and a miss are the same entry.
  // `deepEqual` is strict here — Infinity is not null, NaN is not null, and a
  // Date is not the string JSON made of it.
  assert.deepEqual(warm.entries(), cold.entries(), 'a cached entry is the entry a parse produces');

  const budget = warm.entries().find((e) => e.path === EXOTIC);
  assert.equal(budget.extra.budget, Infinity);
  assert.ok(Number.isNaN(budget.extra.score), 'NaN, not null');
  assert.ok(budget.extra['obsidian-due'] instanceof Date, 'a timestamp, not the string it prints as');
});

test('appending through a warm cache leaves the frontmatter ppr does not own', async () => {
  const storage = new MemoryStorage();
  await storage.write(EXOTIC, EXOTIC_FILE);
  const config = () => structuredClone(DEFAULT_CONFIG);

  // Two commands: the first only looks, and leaves a cache behind for the
  // second. This is the whole bug — same vault, same append, only the cache
  // differs, and `budget` and `score` used to disappear from the user's file
  // because a null is how `serializeDocument` is told to drop a key.
  const first = await Vault.open({ root: '/memory', storage, config: config() });
  await first.close();

  const second = await Vault.open({ root: '/memory', storage, config: config() });
  const appended = await second.append(second.all().find((e) => e.path === EXOTIC).id, 'And a second thought.');
  await second.close();

  const raw = await storage.read(appended.path);
  assert.match(raw, /^budget: \.inf$/m);
  assert.match(raw, /^score: \.nan$/m);
  assert.match(raw, /^obsidian-due: 2026-08-12/m);
  assert.match(raw, /And a second thought\./, 'and the words that were the point of the command');
});
