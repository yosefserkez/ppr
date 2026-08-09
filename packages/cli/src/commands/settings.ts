import { Command } from 'commander';
import {
  DEFAULT_CONFIG,
  PROVIDER_DEFAULTS,
  PprError,
  flattenConfig,
  getPath,
  keyEnvFor,
  looksLikeSecret,
  mergeConfig,
  parseJsonLoose,
  redactSecret,
  setPath,
  validateConfig,
  type AIConfig,
  type Config,
} from '@ppr/core';
import {
  createTranscriber,
  credentialsPath,
  findVault,
  globalConfigPath,
  initVault,
  loadConfig,
  loadSecrets,
  openVault,
  readConfigLayer,
  saveSecret,
  which,
  writeConfigLayer,
  VAULT_CONFIG,
} from '@ppr/core/node';
import { join } from 'node:path';
import { globals, withVault } from '../context.js';
import { writeSetting } from '../config-io.js';
import { dryRun, refuseDryRun, would } from '../dryrun.js';
import { confirm, promptLine } from '../input.js';
import { select } from '../ui/select.js';
import { color, json, out, errline, table } from '../render.js';

/** `ppr init` — the only command that runs without a vault. */
export function initCommand(): Command {
  return new Command('init')
    .description('create a vault (defaults to ~/ppr, or $PPR_DIR)')
    .argument('[dir]', 'where to create it')
    .action(async (dir: string | undefined, _flags: unknown, self: Command) => {
      const g = globals(self);
      const target = findVault({ ...(dir || g.vault ? { explicit: dir ?? g.vault! } : {}) });
      if (dryRun()) {
        would(`create a vault at ${target.root}`, ['entries/, .ppr/config.json, README.md, .gitignore']);
        return void (g.json ? json({ root: target.root, created: false }) : out(target.root));
      }
      const { root, created } = await initVault(target.root);

      if (g.json) return json({ root, created });
      if (!created) return void out(`${color.dim('Vault already exists at')} ${root}`);
      out(`${color.green('✓')} vault created at ${color.bold(root)}`);
      out('');
      out(table([
        ['ppr "shipped the thing"', color.dim('quick log')],
        ['ppr dump', color.dim('brain dump, cleaned up')],
        ['ppr ls', color.dim('recent entries')],
        ['ppr ai setup', color.dim('turn on AI (local models included)')],
      ]));
    });
}

/** Where a config write should land: this vault only, or every vault. */
function configTarget(scope: { local?: boolean }, root: string): string {
  return scope.local ? join(root, VAULT_CONFIG) : globalConfigPath();
}

export function configCommand(): Command {
  const cmd = new Command('config').description('read and write configuration');

  cmd
    .command('list', { isDefault: true })
    .alias('ls')
    .description('show the effective configuration')
    .action(async (_flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        if (globals(self).json) return json(vault.config);
        out(
          table(
            flattenConfig(vault.config).map(([k, v]) => [
              color.cyan(k),
              v === undefined ? color.dim('—') : String(v),
            ]),
          ),
        );
      }),
    );

  cmd
    .command('get')
    .description('print one value')
    .argument('<key>', 'dotted key, e.g. ai.provider')
    .action(async (key: string, _flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const value = getPath(vault.config, key);
        if (value === undefined) throw new PprError('ECONFIG', `Not set: ${key}`);
        if (globals(self).json) return json(value);
        out(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
      }),
    );

  cmd
    .command('set')
    .description('set a value')
    .argument('<key>', 'dotted key, e.g. ai.provider')
    .argument('<value>', 'new value')
    .option('-l, --local', 'write to this vault only, not the global config')
    .action(async (key: string, value: string, flags: { local?: boolean }, self: Command) => {
      const g = globals(self);
      const found = findVault(g.vault ? { explicit: g.vault } : {});
      const written = await writeSetting(found.root, key, value, flags);

      if (g.json) json({ key, value: written.value, file: written.file });
      else out(`${color.green('✓')} ${key} = ${String(written.value)}  ${color.dim(written.file)}`);
    });

  cmd
    .command('path')
    .description('print config file locations')
    .action(async (_flags: unknown, self: Command) => {
      const g = globals(self);
      const found = findVault(g.vault ? { explicit: g.vault } : {});
      const paths = { global: globalConfigPath(), vault: join(found.root, VAULT_CONFIG) };
      if (g.json) return json(paths);
      out(table([['global', paths.global], ['vault', paths.vault]]));
    });

  return cmd;
}

/** Keeps written config files to what the user actually changed. */
function pruneDefaults(merged: Config, layer: Record<string, unknown>, key: string): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(layer);
  const keys = key.split('.');
  const leaf = keys.pop()!;
  let node = out;
  for (const k of keys) {
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  node[leaf] = getPath(merged, key);
  return out;
}

const PROVIDER_HELP: Record<string, string> = {
  none: 'offline only — heuristics, no model',
  apple: 'on-device Apple Foundation Models (macOS 26+, no key)',
  ollama: 'local models via Ollama (no key)',
  anthropic: 'Claude API (bring your own key)',
  openai: 'OpenAI or any OpenAI-compatible endpoint',
  command: 'any command that reads a prompt on stdin',
};

const TRANSCRIBE_HELP: Record<string, string> = {
  none: 'no voice capture',
  'whisper-cpp': 'local whisper.cpp binary (no key)',
  openai: 'OpenAI transcription API',
  command: 'any command that takes {file} and prints text',
};

/** Local-first ordering: the options that need no account come first. */
const asChoices = (help: Record<string, string>) =>
  Object.entries(help).map(([value, hint]) => ({ value, label: value, hint }));

const TEST_HINT =
  'Usual causes: a model id this endpoint does not have, an endpoint that is down, or a model that cannot return JSON. `ppr ai status` shows what is configured.';

/** One line of a reply, short enough to read and long enough to recognise. */
const snippet = (raw: string): string => {
  const line = raw.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};

/**
 * Why the model never answered.
 *
 * A missing key or an unconfigured backend keeps its own code: those are
 * "your setup is wrong" (exit 4), not "the model is broken" (exit 5), and the
 * exit code is the only thing a script has to tell them apart.
 */
function unreachable(err: unknown, provider: string, model: string): PprError {
  const known = err instanceof PprError ? err : null;
  const message = `${provider}/${model} did not answer: ${known?.message ?? (err as Error)?.message ?? String(err)}`;
  if (known && (known.code === 'ECONFIG' || known.code === 'ENOAI')) {
    return new PprError(known.code, message, known.hint ?? TEST_HINT);
  }
  return new PprError('EAI', message, TEST_HINT);
}

export function aiCommand(): Command {
  const cmd = new Command('ai').description('configure and test the model backend');

  cmd
    .command('status', { isDefault: true })
    .description('show the current AI setup')
    .action(async (_flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const { ai, transcribe } = vault.config;
        const secrets = await loadSecrets();
        const pasted = ai.apiKeyEnv && looksLikeSecret(ai.apiKeyEnv) ? ai.apiKeyEnv : undefined;
        const keyName = keyEnvFor(ai);
        // Which of the two places won matters when you are debugging a stale key,
        // and `hasKey` alone cannot tell you.
        const source = !keyName || pasted
          ? undefined
          : process.env[keyName]
            ? 'environment'
            : secrets(keyName)
              ? credentialsPath()
              : undefined;

        if (globals(self).json) {
          return json({
            ai,
            transcribe,
            keyEnv: keyName,
            keyAvailable: Boolean(source),
            keySource: source,
            ...(pasted ? { problem: 'ai.apiKeyEnv holds a key, not a variable name' } : {}),
            enabled: vault.hasAI,
          });
        }
        out(
          table([
            ['provider', `${ai.provider}  ${color.dim(PROVIDER_HELP[ai.provider] ?? '')}`],
            ['model', ai.model || color.dim('—')],
            ...(ai.baseUrl ? [['endpoint', ai.baseUrl] as [string, string]] : []),
            ...(keyName
              ? [[
                  'key',
                  source
                    ? color.green(`${keyName} ✓  ${color.dim(`from ${source}`)}`)
                    : color.red(`${keyName} — not set`),
                ] as [string, string]]
              : []),
            ['transcription', transcribe.provider],
          ]),
        );
        if (pasted) {
          errline(color.red(`ai.apiKeyEnv holds a key (${redactSecret(pasted)}), not a variable name.`));
          errline(color.dim(`Run \`ppr ai key\` to move it out of your config file.`));
        } else if (keyName && !source) {
          out(color.dim(`\nSet it with: ppr ai key  ${color.dim('(or export ')}${keyName}${color.dim(')')}`));
        }
      }),
    );

  cmd
    .command('list')
    .description('list available providers')
    .action(async (_flags: unknown, self: Command) => {
      if (globals(self).json) return json({ ai: PROVIDER_HELP, transcribe: TRANSCRIBE_HELP });
      out(color.bold('Model backends'));
      out(table(Object.entries(PROVIDER_HELP).map(([k, v]) => [`  ${color.cyan(k)}`, v])));
      out(`\n${color.bold('Transcription')}`);
      out(table(Object.entries(TRANSCRIBE_HELP).map(([k, v]) => [`  ${color.cyan(k)}`, v])));
    });

  cmd
    .command('setup')
    .description('interactive setup')
    .action(async (_flags: unknown, self: Command) => {
      const picked = await select({
        title: 'Model backend',
        choices: asChoices(PROVIDER_HELP),
      });
      const provider = picked.value;
      const defaults = PROVIDER_DEFAULTS[provider as keyof typeof PROVIDER_DEFAULTS] ?? {};

      refuseDryRun('ppr ai setup', 'It asks questions and stores an API key as it goes.');
      const layerPath = globalConfigPath();
      const layer = await readConfigLayer(layerPath);
      const ai: Record<string, unknown> = { ...(layer.ai as Record<string, unknown>), provider };

      if (provider !== 'none') {
        const model = await promptLine(`Model [${defaults.model ?? 'none'}]: `);
        ai.model = model || defaults.model || '';
      }
      if (provider === 'openai' || provider === 'ollama') {
        const url = await promptLine(`Endpoint [${defaults.baseUrl ?? ''}]: `);
        if (url) ai.baseUrl = url;
      }
      if (provider === 'command') {
        const command = await promptLine('Command (prompt arrives on stdin): ');
        if (!command) throw new PprError('EINVALID', 'A command is required');
        ai.command = command;
      }

      const transcribe = { ...(layer.transcribe as Record<string, unknown>) };
      // Voice is the one thing `doctor` used to nag about with no way to set it here.
      if (await confirm('Set up voice capture too?', false)) {
        const backend = await select({
          title: 'Transcription',
          choices: asChoices(TRANSCRIBE_HELP),
        });
        transcribe.provider = backend.value;
        if (backend.value === 'whisper-cpp') {
          const model = await promptLine('Path to a whisper model (.bin): ');
          if (model) transcribe.model = model;
        }
        if (backend.value === 'command') {
          const command = await promptLine('Command ({file} is the audio path): ');
          if (command) transcribe.command = command;
        }
      }

      // Only record a transcribe section if there is something in it.
      const next: Record<string, unknown> = { ...layer, ai };
      if (Object.keys(transcribe).length) next.transcribe = transcribe;
      await writeConfigLayer(layerPath, next);

      // Resolve against the endpoint just chosen, so a custom host asks for its
      // own variable (OPENROUTER_API_KEY) rather than the provider-wide default.
      const keyName = keyEnvFor({ ...DEFAULT_CONFIG.ai, ...ai } as AIConfig);
      if (keyName) {
        const existing = (await loadSecrets())(keyName);
        if (!existing && (await confirm(`Store an API key for ${keyName}?`, true))) {
          const key = await promptLine('API key: ');
          if (key) {
            const path = await saveSecret(keyName, key);
            ai.apiKeyEnv = keyName;
            await writeConfigLayer(layerPath, { ...next, ai });
            out(color.dim(`Key saved to ${path} (0600). Keys never go in the vault or in config.`));
          }
        } else if (existing) {
          out(color.dim(`Using the ${keyName} you already have. Replace it with \`ppr ai key\`.`));
        }
      }

      out(`\n${color.green('✓')} configured ${color.bold(provider)}  ${color.dim(layerPath)}`);
      if (provider !== 'none') out(color.dim('Test it: ppr ai test'));
      void globals(self);
    });

  cmd
    .command('key')
    .description('store an API key outside the vault and outside your config')
    .argument('[env-var]', 'variable name; worked out from your backend when omitted')
    .argument('[value]', 'the key itself; omit to be prompted')
    .action(async (first: string | undefined, second: string | undefined, _flags: unknown, self: Command) => {
      refuseDryRun('ppr ai key', 'A key is stored outside the vault, in a 0600 file.');
      const g = globals(self);
      const root = findVault(g.vault ? { explicit: g.vault } : {}).root;
      const config = await loadConfig(root);

      // Both arguments are optional and either can be given alone, so tell them
      // apart by shape: a variable name never looks like a key, and vice versa.
      // That makes `ppr ai key` on its own the answer to "where does it go?".
      const named = first !== undefined && !looksLikeSecret(first);
      const name = named ? first : keyEnvFor(config.ai);
      const given = named ? second : first;

      if (!name) {
        throw new PprError(
          'ECONFIG',
          `The ${config.ai.provider} backend does not use an API key`,
          'Run `ppr ai setup` to pick one that does, or name the variable yourself: ppr ai key NAME <value>',
        );
      }

      const key = given ?? (await promptLine(`${name}: `));
      if (!key) throw new PprError('EINVALID', 'No key given');
      const path = await saveSecret(name, key);

      // When ppr picked the name, record it — so the config says out loud which
      // variable is in play instead of leaving it to an inferred default.
      const point = !named && config.ai.apiKeyEnv !== name;
      if (point) await writeSetting(root, 'ai.apiKeyEnv', name);

      if (g.json) return json({ name, file: path, apiKeyEnv: point ? name : config.ai.apiKeyEnv });
      out(`${color.green('✓')} ${color.bold(name)} stored in ${path} ${color.dim('(0600)')}`);
      if (point) out(color.dim(`  → ppr config set ai.apiKeyEnv ${name}`));
      out(color.dim(`  ${name} in your environment overrides this file.`));
    });

  cmd
    .command('test')
    .description('check the configured model answers, and answers in JSON')
    .action(async (_flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const g = globals(self);
        if (!vault.provider) {
          throw new PprError(
            'ENOAI',
            'No model backend configured',
            'Run `ppr ai setup` to pick one — the local options need no key.',
          );
        }
        const { id: provider, model } = vault.provider;
        const started = Date.now();

        let raw: string;
        try {
          // Every AI task in ppr asks for JSON, so this is the thing worth
          // testing: a model that answers politely in prose passes a "does it
          // reply" check and fails every real command silently (L21).
          raw = await vault.provider.generate({
            system: 'Return exactly this JSON object and nothing else.',
            prompt: '{"ok": true, "model_heard": "<one word: the model answering>"}',
            json: true,
            temperature: 0,
            // No maxTokens override: the point is to exercise what the real
            // tasks get. A tight budget of its own would have this pass or
            // fail on a reasoning model's thinking tokens rather than on
            // whether the backend works.
          });
        } catch (err) {
          if (g.json) json({ ok: false, provider, model, latencyMs: Date.now() - started });
          throw unreachable(err, provider, model);
        }

        const latencyMs = Date.now() - started;
        const parsed = parseJsonLoose<Record<string, unknown>>(raw);
        if (g.json) {
          json({ ok: Boolean(parsed), provider, model, latencyMs, ...(parsed ? {} : { raw }) });
        }
        if (!parsed) {
          throw new PprError(
            'EAI',
            `${provider}/${model} answered in ${latencyMs}ms, but not with JSON: ${snippet(raw)}`,
            TEST_HINT,
          );
        }
        if (g.json) return;
        out(`${color.green('✓')} ${provider}/${model} answered in ${latencyMs}ms, and it was JSON`);
        out(color.dim(`  ${snippet(raw)}`));
      }),
    );

  return cmd;
}

/** `ppr reindex` — for when files changed underneath ppr. */
export function reindexCommand(): Command {
  return new Command('reindex')
    .description('rebuild the parse cache from the markdown files')
    .action(async (_flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const count = await vault.reindex();
        if (globals(self).json) json({ entries: count });
        else out(`${color.green('✓')} indexed ${count} entries`);
      }),
    );
}
