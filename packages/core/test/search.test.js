import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, MemoryStorage, DEFAULT_CONFIG, searchEntries, setPath, getPath, flattenConfig } from '../dist/index.js';

async function seeded(bodies) {
  const vault = await Vault.open({
    root: '/memory',
    storage: new MemoryStorage(),
    config: structuredClone(DEFAULT_CONFIG),
  });
  for (const body of bodies) await vault.add(typeof body === 'string' ? { body } : body);
  return vault;
}

test('title matches outrank body matches', async () => {
  const vault = await seeded([
    { body: 'A long note that happens to mention kubernetes somewhere in the middle.', title: 'Unrelated' },
    { body: 'Short note.', title: 'Kubernetes upgrade' },
  ]);
  const hits = vault.search('kubernetes');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].entry.title, 'Kubernetes upgrade');
});

test('matching every token beats matching one', async () => {
  const vault = await seeded([
    { body: 'redis was slow', title: 'redis' },
    { body: 'redis latency measurements', title: 'redis latency' },
  ]);
  const hits = vault.search('redis latency');
  assert.equal(hits[0].entry.title, 'redis latency');
});

test('search returns an excerpt around the match', async () => {
  const vault = await seeded([{ body: `${'padding '.repeat(40)}the needle is here${' padding'.repeat(40)}` }]);
  const [hit] = vault.search('needle');
  assert.match(hit.excerpt, /needle/);
  assert.ok(hit.excerpt.length < 200);
});

test('search respects filters', async () => {
  const vault = await seeded([
    { body: 'deploy notes #ops', kind: 'log' },
    { body: 'deploy notes again #ops', kind: 'note' },
  ]);
  assert.equal(vault.search('deploy', { kind: 'note' }).length, 1);
  assert.equal(vault.search('deploy', { tag: 'ops' }).length, 2);
  assert.equal(vault.search('deploy', { limit: 1 }).length, 1);
});

test('empty and junk queries return nothing rather than everything', async () => {
  const vault = await seeded(['some content here']);
  assert.deepEqual(vault.search(''), []);
  assert.deepEqual(vault.search('   '), []);
  assert.deepEqual(searchEntries(vault.all(), 'zzzzzz'), []);
});

test('config paths read, write, and coerce types', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  assert.equal(getPath(config, 'ai.provider'), 'none');

  const withOllama = setPath(config, 'ai.provider', 'ollama');
  assert.equal(withOllama.ai.provider, 'ollama');
  assert.equal(withOllama.ai.model, 'llama3.2', 'provider defaults fill in the model');

  assert.equal(setPath(config, 'display.color', 'false').display.color, false);
  assert.equal(setPath(config, 'capture.maxTags', '3').capture.maxTags, 3);
  assert.throws(() => setPath(config, 'capture.maxTags', 'lots'), /number/);
  assert.throws(() => setPath(config, 'ai.provider', 'nonsense'), /Unknown AI provider/);
  assert.throws(() => setPath(config, 'made.up.key', 'x'), /Unknown config/);
});

test('config flattens to dotted keys for display', () => {
  const flat = Object.fromEntries(flattenConfig(structuredClone(DEFAULT_CONFIG)));
  assert.equal(flat['ai.provider'], 'none');
  assert.equal(flat['capture.distill'], true);
});
