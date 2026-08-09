import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, MemoryStorage, DEFAULT_CONFIG, serializeEntry, createEntry } from '../dist/index.js';

/** A vault backed by memory: the same code paths the CLI uses, no filesystem. */
async function makeVault(overrides = {}) {
  const storage = new MemoryStorage();
  const vault = await Vault.open({
    root: '/memory',
    storage,
    config: structuredClone({ ...DEFAULT_CONFIG, ...overrides }),
  });
  return { vault, storage };
}

test('entries are written as markdown under a date path', async () => {
  const { vault, storage } = await makeVault();
  const entry = await vault.add({ body: 'Shipped it #work', kind: 'log' });

  assert.match(entry.path, /^entries\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-\d{4}-shipped-it-\w{4}\.md$/);
  const raw = await storage.read(entry.path);
  assert.match(raw, /^---\n/);
  assert.match(raw, /Shipped it #work/);
});

test('list filters by kind, tag, and time window', async () => {
  const { vault } = await makeVault();
  await vault.add({ body: 'one #alpha', kind: 'log' });
  await vault.add({ body: 'two #beta', kind: 'note' });
  await vault.add({ body: 'three #alpha #beta', kind: 'note' });

  assert.equal(vault.list({ kind: 'note' }).length, 2);
  assert.equal(vault.list({ tag: 'alpha' }).length, 2);
  assert.equal(vault.list({ tag: ['alpha', 'beta'] }).length, 1);
  assert.equal(vault.list({ since: new Date(Date.now() + 60_000) }).length, 0);
  assert.equal(vault.list({ limit: 2 }).length, 2);
});

test('refs resolve by latest, position, id prefix, id suffix, and title', async () => {
  const { vault } = await makeVault();
  const first = await vault.add({ body: 'first entry', title: 'Alpha thing' });
  const second = await vault.add({ body: 'second entry', title: 'Beta thing' });

  assert.equal(vault.get('latest').id, second.id);
  assert.equal(vault.get('^2').id, first.id);
  assert.equal(vault.get(second.id).id, second.id);
  assert.equal(vault.get(second.id.slice(-6)).id, second.id);
  assert.equal(vault.get('alpha thing').id, first.id);
  assert.throws(() => vault.get('nothing like this'), /No entry matching/);
});

test('renaming an entry moves the file and leaves no orphan', async () => {
  const { vault, storage } = await makeVault();
  const entry = await vault.add({ body: 'body', title: 'Old name' });
  const updated = await vault.update(entry.id, { title: 'New name' });

  assert.equal(await storage.read(entry.path), null);
  assert.ok(await storage.read(updated.path));
  assert.equal(vault.list().length, 1);
});

test('deleting removes the file and the index entry', async () => {
  const { vault, storage } = await makeVault();
  const entry = await vault.add({ body: 'temporary' });
  await vault.remove(entry.id);

  assert.equal(await storage.read(entry.path), null);
  assert.equal(vault.list().length, 0);
});

test('files edited outside ppr are picked up on the next open', async () => {
  const { vault, storage } = await makeVault();
  await vault.add({ body: 'original' });
  await vault.close();

  // Simulate `vim`, or a git pull from another machine.
  const external = createEntry({ body: 'Written by hand elsewhere', kind: 'note' });
  await storage.write(external.path, serializeEntry(external));

  const reopened = await Vault.open({ root: '/memory', storage, config: structuredClone(DEFAULT_CONFIG) });
  assert.equal(reopened.list().length, 2);
  assert.ok(reopened.list().some((e) => e.body === 'Written by hand elsewhere'));
});

test('the cache never hides a changed file', async () => {
  const { vault, storage } = await makeVault();
  const entry = await vault.add({ body: 'before' });
  await vault.close();

  await storage.write(entry.path, serializeEntry({ ...entry, body: 'after' }));
  const reopened = await Vault.open({ root: '/memory', storage, config: structuredClone(DEFAULT_CONFIG) });
  assert.equal(reopened.get(entry.id).body, 'after');
});

test('backlinks, forward links, and relatedness line up', async () => {
  const { vault } = await makeVault();
  const target = await vault.add({ body: 'The redis migration went badly #infra', title: 'Redis migration' });
  const source = await vault.add({ body: 'Following up on [[redis migration]] #infra', title: 'Follow up' });

  assert.deepEqual(vault.backlinks(target).map((e) => e.id), [source.id]);
  assert.deepEqual(vault.forwardLinks(source).resolved.map((e) => e.id), [target.id]);
  assert.deepEqual(vault.forwardLinks(target).missing, []);
  assert.equal(vault.related(target)[0].entry.id, source.id);

  const unresolved = await vault.add({ body: 'Points at [[nothing here]]' });
  assert.deepEqual(vault.forwardLinks(unresolved).missing, ['nothing here']);
});

test('append keeps the id and extends the body', async () => {
  const { vault } = await makeVault();
  const entry = await vault.add({ body: 'Start.' });
  const appended = await vault.append(entry.id, 'More later.');

  assert.equal(appended.id, entry.id);
  assert.match(appended.body, /Start\.\n\nMore later\./);
});

test('facts left in the journal tree are relocated on reindex', async () => {
  const { storage } = await makeVault();
  // A fact written before `memory/` existed: still parses, still resolves,
  // just in the wrong tree.
  const stale = createEntry({ body: 'Emily likes chocolate', kind: 'memory', title: 'Emily likes chocolate' });
  const journalPath = `entries/2026/01/2026-01-01-0900-emily-likes-chocolate-${stale.id.slice(-4)}.md`;
  await storage.write(journalPath, serializeEntry({ ...stale, path: journalPath }));

  const reopened = await Vault.open({ root: '/memory', storage, config: structuredClone(DEFAULT_CONFIG) });
  await reopened.reindex();

  assert.equal(await storage.read(journalPath), null);
  assert.match(reopened.get(stale.id).path, /^memory\//);
  assert.equal(reopened.facts().length, 1);
});

test('reindex leaves a hand-placed file exactly where its author put it', async () => {
  const { storage } = await makeVault();
  const odd = createEntry({ body: 'Filed by hand', kind: 'note', title: 'Filed by hand' });
  await storage.write('entries/inbox/whatever.md', serializeEntry({ ...odd, path: 'entries/inbox/whatever.md' }));

  const vault = await Vault.open({ root: '/memory', storage, config: structuredClone(DEFAULT_CONFIG) });
  await vault.reindex();

  assert.ok(await storage.read('entries/inbox/whatever.md'), 'it is just markdown; ppr does not tidy');
});

test('auto-linking follows names, not every short title', async () => {
  const { vault } = await makeVault({ capture: { ...DEFAULT_CONFIG.capture, autoLink: true } });
  await vault.add({ body: 'Emily', kind: 'note' });
  await vault.add({ body: 'Redis Migration', kind: 'note' });
  // Titles are taken from the first line when none is given, so a vault of
  // one-line logs is full of these. Length alone made all three linkable.
  await vault.add({ body: 'Fix it', kind: 'log' });
  await vault.add({ body: 'The plan', kind: 'log' });

  const entry = await vault.add({
    body: 'Told Emily about the redis migration, then had to fix it before the plan was ready',
    kind: 'log',
  });

  assert.match(entry.body, /\[\[Emily\]\]/);
  assert.match(entry.body, /\[\[redis migration\]\]/);
  assert.ok(!/\[\[fix it\]\]/.test(entry.body), 'a sentence fragment is not a name');
  assert.ok(!/\[\[the plan\]\]/.test(entry.body), 'nor is "The plan"');
});

test('stats count what is actually there', async () => {
  const { vault } = await makeVault();
  await vault.add({ body: 'one two three #a', kind: 'log' });
  await vault.add({ body: 'four five [[one]] #b', kind: 'note' });

  const stats = vault.stats();
  assert.equal(stats.entries, 2);
  assert.equal(stats.byKind.log, 1);
  assert.equal(stats.tags, 2);
  assert.equal(stats.links, 1);
  assert.ok(stats.words >= 7);
});
