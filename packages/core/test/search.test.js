import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, MemoryStorage, DEFAULT_CONFIG, searchEntries, setPath, getPath, flattenConfig, keyEnvFor } from '../dist/index.js';

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

test('a key pasted where a variable name belongs is refused, not written', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const key = 'sk-or-v1-2f45c9a5de610d3475826159ea58892955b79aa98026cc73acf5764';

  assert.throws(() => setPath(config, 'ai.apiKeyEnv', key), /name of an environment variable/);
  assert.throws(() => setPath(config, 'transcribe.apiKeyEnv', key), /name of an environment variable/);
  // Google's keys have no punctuation to give them away, so length and case do.
  assert.throws(() => setPath(config, 'ai.apiKeyEnv', 'AIzaSyD3f8kQ2mNp7rT1vX9wY4zA6bC0eF5gH2j'), /not the key itself/);

  // Real variable names still go through, including the unfashionable ones.
  for (const name of ['OPENROUTER_API_KEY', 'my_key', '_KEY2']) {
    assert.equal(setPath(config, 'ai.apiKeyEnv', name).ai.apiKeyEnv, name);
  }
});

test('the settings people invent for their key point them at the real one', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  for (const path of ['ai.apiKey', 'ai.key', 'transcribe.apiKey']) {
    assert.throws(() => setPath(config, path, 'sk-whatever'), (err) => {
      assert.match(err.message, new RegExp(`no ${path} setting`));
      assert.match(err.hint, /ppr ai key/, 'the hint is the next thing to type');
      return true;
    });
  }
});

test('a custom endpoint gets a key variable named after itself', () => {
  const openrouter = { ...DEFAULT_CONFIG.ai, provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1' };
  assert.equal(keyEnvFor(openrouter), 'OPENROUTER_API_KEY');
  assert.equal(keyEnvFor({ ...openrouter, baseUrl: 'https://api.groq.com/openai/v1' }), 'GROQ_API_KEY');
  assert.equal(keyEnvFor({ ...openrouter, baseUrl: undefined }), 'OPENAI_API_KEY');
  assert.equal(keyEnvFor({ ...openrouter, apiKeyEnv: 'MINE' }), 'MINE', 'an explicit name always wins');

  // Backends that need no key must not be handed one to go looking for —
  // including when an apiKeyEnv is left behind by the provider before them.
  assert.equal(keyEnvFor({ ...DEFAULT_CONFIG.ai, provider: 'ollama' }), undefined);
  assert.equal(keyEnvFor({ ...openrouter, provider: 'ollama', apiKeyEnv: 'OPENROUTER_API_KEY' }), undefined);
  assert.equal(keyEnvFor(DEFAULT_CONFIG.ai), undefined);

  // A pasted key is never treated as a name, even though it is set.
  assert.equal(keyEnvFor({ ...openrouter, apiKeyEnv: 'sk-or-v1-abc123def456ghi' }), 'OPENROUTER_API_KEY');
});

test('whitespace around a hand-edited value is not sent to a server', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  // A padded model id comes back as someone else's 400, which reads like a
  // broken model rather than a stray space in a file.
  assert.equal(setPath(config, 'ai.model', ' openrouter/auto-beta ').ai.model, 'openrouter/auto-beta');
  assert.equal(setPath(config, 'ai.baseUrl', ' https://openrouter.ai/api/v1\n').ai.baseUrl, 'https://openrouter.ai/api/v1');
});

test('config flattens to dotted keys for display', () => {
  const flat = Object.fromEntries(flattenConfig(structuredClone(DEFAULT_CONFIG)));
  assert.equal(flat['ai.provider'], 'none');
  assert.equal(flat['capture.distill'], true);
});

test('a plugin keeps its settings where the user already looks', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const set = setPath(config, 'plugins.reminders-push.list', 'Errands');

  assert.equal(getPath(set, 'plugins.reminders-push.list'), 'Errands');
  // Round-trips into the flat view `ppr config list` prints, so a plugin's
  // settings are discoverable without knowing they exist.
  assert.equal(Object.fromEntries(flattenConfig(set))['plugins.reminders-push.list'], 'Errands');
  // No schema here on purpose: ppr cannot know what is installed.
  const more = setPath(set, 'plugins.reminders-push.hour', '9');
  assert.equal(getPath(more, 'plugins.reminders-push.hour'), '9');
  assert.equal(getPath(more, 'plugins.reminders-push.list'), 'Errands');

  // And nothing else got loose with it (L5).
  assert.throws(() => setPath(config, 'made.up.key', 'x'), /Unknown config/);
  assert.throws(() => setPath(config, 'display.colour', 'true'), /Unknown config key/);
  // A plugin needs a name to keep its settings under.
  assert.throws(() => setPath(config, 'plugins.foo', 'bar'), /plugins\.<plugin>\.<key>/);
});

test('a secret is refused under plugins too, because a vault is in git', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const secret = 'sk-live-2f45c9a5de610d3475826159ea58892955b79aa98026cc73';

  for (const key of [
    'plugins.todoist.token',
    'plugins.todoist.apiKey',
    'plugins.todoist.api_key',
    'plugins.thing.password',
    'plugins.thing.secret',
  ]) {
    assert.throws(() => setPath(config, key, secret), (err) => {
      assert.match(err.message, /a config file is not one/);
      assert.match(err.hint, /environment variable/, 'the hint is the next thing to type');
      return true;
    });
  }

  // The *name* of a variable is exactly what may be stored — and the same
  // mistake one level down is caught the same way (I7).
  const named = setPath(config, 'plugins.todoist.tokenEnv', 'TODOIST_TOKEN');
  assert.equal(getPath(named, 'plugins.todoist.tokenEnv'), 'TODOIST_TOKEN');
  assert.throws(() => setPath(config, 'plugins.todoist.tokenEnv', secret), /name of an environment variable/);
});

test('compose mode is validated like any other setting', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  assert.equal(config.capture.compose, 'editor', 'the editor is the default');
  assert.equal(setPath(config, 'capture.compose', 'inline').capture.compose, 'inline');
  assert.throws(() => setPath(config, 'capture.compose', 'vim'), /Unknown compose mode/);
});
