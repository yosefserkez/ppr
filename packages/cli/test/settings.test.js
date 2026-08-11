import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, mergeConfig, redactConfig, redactSecret, redactValue, setPath } from '@ppr/core';
import { aiCommand, aiStatusJson, configRows } from '../dist/commands/settings.js';
import { pluginSettings, settingRows } from '../dist/commands/plugins.js';

/**
 * What a config file is allowed to say out loud.
 *
 * `guardSecret` only runs on `ppr config set`, so it never sees a key that was
 * hand-edited in, merged up from a vault layer, or written before that guard
 * existed. Everything here is about the other end: I7's "redact before it can
 * reach a screen", on the commands that print a config back.
 */

const KEY = 'sk-or-v1-0123456789abcdefghij';
const TOKEN = 'abcd1234efgh5678ijkl';

/** Colour stays on until `setColor` runs, and only index.ts runs it. */
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const configWith = (overrides) => mergeConfig(structuredClone(DEFAULT_CONFIG), overrides);

const rowFor = (rows, key) => {
  const row = rows.find(([k]) => plain(k) === key);
  assert.ok(row, `no ${key} row`);
  return plain(row[1]);
};

const thrown = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return assert.fail('nothing was thrown');
};

/** `addHelpText` reaches the writer, never the string `helpInformation()` returns. */
const helpFor = (command) => {
  let captured = '';
  command.configureOutput({ writeOut: (s) => (captured += s) });
  command.outputHelp();
  return plain(captured);
};

const pastedIntoConfig = () =>
  configWith({
    ai: { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: KEY },
    transcribe: { provider: 'openai', apiKeyEnv: KEY },
    plugins: { todoist: { token: TOKEN, list: 'Errands' } },
  });

test('a key already in a config file is redacted before `config list` shows it', () => {
  const rows = configRows(pastedIntoConfig());

  assert.equal(rowFor(rows, 'ai.apiKeyEnv'), redactSecret(KEY));
  assert.equal(rowFor(rows, 'transcribe.apiKeyEnv'), redactSecret(KEY));
  assert.equal(rowFor(rows, 'plugins.todoist.token'), redactSecret(TOKEN));

  const printed = rows.map((r) => plain(r.join(' '))).join('\n');
  assert.ok(!printed.includes(KEY), 'the whole key reached the table');
  assert.ok(!printed.includes(TOKEN), 'the whole token reached the table');
});

/**
 * The other half of the same rule, and the one that keeps `config list` worth
 * running: a model id, an endpoint, and a plugin's ordinary setting are not
 * secrets, and hiding them would be the more expensive bug.
 */
test('everything that is not a key still prints as itself', () => {
  const rows = configRows(pastedIntoConfig());

  assert.equal(rowFor(rows, 'ai.model'), 'gpt-4o-mini');
  assert.equal(rowFor(rows, 'ai.baseUrl'), 'https://openrouter.ai/api/v1');
  assert.equal(rowFor(rows, 'plugins.todoist.list'), 'Errands');
  assert.equal(rowFor(rows, 'ai.provider'), 'openai');
  // An unset optional key stays visible as unset, which is how it is discovered.
  assert.equal(rowFor(rows, 'ai.command'), '—');
});

test('`config list --json` hands over a redacted copy, not the live config', () => {
  const config = pastedIntoConfig();
  const safe = redactConfig(config);

  assert.equal(safe.ai.apiKeyEnv, redactSecret(KEY));
  assert.equal(safe.transcribe.apiKeyEnv, redactSecret(KEY));
  assert.equal(safe.plugins.todoist.token, redactSecret(TOKEN));
  assert.equal(safe.ai.model, 'gpt-4o-mini');
  assert.ok(!JSON.stringify(safe).includes(KEY));
  // Redacting must not be a mutation: the vault goes on using the real value.
  assert.equal(config.ai.apiKeyEnv, KEY);
});

test('`ai status --json` cannot echo the key it is complaining about', () => {
  const { ai, transcribe } = pastedIntoConfig();
  const payload = aiStatusJson({ ai, transcribe }, { env: 'OPENROUTER_API_KEY' }, false);

  assert.equal(payload.ai.apiKeyEnv, redactSecret(KEY));
  assert.equal(payload.transcribe.apiKeyEnv, redactSecret(KEY));
  assert.equal(payload.problem, 'ai.apiKeyEnv holds a key, not a variable name');
  assert.ok(!JSON.stringify(payload).includes(KEY));
  // The rest of the answer is unchanged — this is a redaction, not a filter.
  assert.equal(payload.keyEnv, 'OPENROUTER_API_KEY');
  assert.equal(payload.keyAvailable, false);
  assert.equal(payload.enabled, false);
});

test('a variable name in apiKeyEnv is a name, and is printed', () => {
  const config = configWith({ ai: { provider: 'openai', apiKeyEnv: 'OPENROUTER_API_KEY' } });
  assert.equal(rowFor(configRows(config), 'ai.apiKeyEnv'), 'OPENROUTER_API_KEY');
  assert.equal(redactValue('ai.apiKeyEnv', 'OPENROUTER_API_KEY'), 'OPENROUTER_API_KEY');
});

/** `ppr config get ai` prints a whole section, so redaction reaches inside one. */
test('config get redacts a single value and a whole section alike', () => {
  const { ai } = pastedIntoConfig();
  assert.equal(redactValue('ai.apiKeyEnv', KEY), redactSecret(KEY));
  assert.equal(redactValue('ai', ai).apiKeyEnv, redactSecret(KEY));
  assert.equal(redactValue('ai', ai).model, 'gpt-4o-mini');
});

/**
 * `ppr plugins` is the fourth way a config value reaches a screen, and the one
 * that matters most: `plugins.*` is the namespace nothing validates and the one
 * that merges up from the vault layer, which is assumed to be in git (I7). It
 * printed `plugins.todoist.token` in full while `config list` was hiding it.
 *
 * The table is built from the same payload `--json` hands over, so both ends of
 * the report are pinned here.
 */
test('`ppr plugins` redacts a plugin key in its payload and in its table row', () => {
  const config = pastedIntoConfig();
  const settings = pluginSettings(config);

  assert.equal(settings.todoist.token, redactSecret(TOKEN));
  assert.ok(!JSON.stringify(settings).includes(TOKEN), 'the whole token reached --json');

  const rows = settingRows(settings);
  assert.equal(rowFor(rows, 'plugins.todoist.token'), redactSecret(TOKEN));

  const printed = rows.map((r) => plain(r.join(' '))).join('\n');
  assert.ok(!printed.includes(TOKEN), 'the whole token reached the table');

  // Same bargain as `config list`: an ordinary plugin setting stays readable,
  // and the vault goes on using the real value.
  assert.equal(rowFor(rows, 'plugins.todoist.list'), 'Errands');
  assert.equal(config.plugins.todoist.token, TOKEN);
});

/**
 * A value on the argv is in your shell history and in the process table before
 * ppr has seen it, so nothing ppr prints may recommend putting it there. The
 * positional argument keeps working; it just stops being the advice.
 */
test('every recommendation points at the form that asks for the key', () => {
  const key = aiCommand().commands.find((c) => c.name() === 'key');
  assert.ok(key, 'ppr ai key is gone');
  const help = helpFor(key);

  assert.match(help, /shell history/);
  assert.ok(!/ppr ai key <value>/.test(help));
  assert.ok(!/ppr ai key sk-/.test(help));
  // The positional is still there, because scripts depend on it.
  assert.match(help, /\[value\]/);

  for (const path of ['ai.apiKey', 'ai.key', 'transcribe.api_key']) {
    const err = thrown(() => setPath(structuredClone(DEFAULT_CONFIG), path, KEY));
    assert.match(err.hint, /`ppr ai key`/);
    assert.match(err.hint, /shell history/);
    assert.ok(!err.hint.includes('ppr ai key <value>'));
  }

  const pasted = thrown(() => setPath(structuredClone(DEFAULT_CONFIG), 'ai.apiKeyEnv', KEY));
  assert.match(pasted.hint, /`ppr ai key`/);
  assert.match(pasted.hint, /shell history/);
  // The error itself must not repeat the key back.
  assert.ok(!pasted.message.includes(KEY));
});
