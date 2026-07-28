import { Command } from 'commander';
import {
  DEFAULT_CONFIG,
  PROVIDER_DEFAULTS,
  PprError,
  flattenConfig,
  getPath,
  mergeConfig,
  setPath,
  validateConfig,
  type Config,
} from '@ppr/core';
import {
  createTranscriber,
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
      const effective = await loadConfig(found.root);
      // Validate against the effective config, then persist only the delta.
      setPath(effective, key, value);

      const path = configTarget(flags, found.root);
      const layer = await readConfigLayer(path);
      const merged = setPath(
        validateConfig(mergeConfig(structuredClone(DEFAULT_CONFIG), layer)),
        key,
        value,
      );
      await writeConfigLayer(path, pruneDefaults(merged, layer, key));
      if (g.json) json({ key, value: getPath(merged, key), file: path });
      else out(`${color.green('✓')} ${key} = ${String(getPath(merged, key))}  ${color.dim(path)}`);
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

export function aiCommand(): Command {
  const cmd = new Command('ai').description('configure and test the model backend');

  cmd
    .command('status', { isDefault: true })
    .description('show the current AI setup')
    .action(async (_flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const { ai, transcribe } = vault.config;
        const secrets = await loadSecrets();
        const keyName = ai.apiKeyEnv ?? PROVIDER_DEFAULTS[ai.provider]?.apiKeyEnv;
        const hasKey = keyName ? Boolean(secrets(keyName)) : true;

        if (globals(self).json) {
          return json({ ai, transcribe, keyAvailable: hasKey, enabled: vault.hasAI });
        }
        out(
          table([
            ['provider', `${ai.provider}  ${color.dim(PROVIDER_HELP[ai.provider] ?? '')}`],
            ['model', ai.model || color.dim('—')],
            ...(ai.baseUrl ? [['endpoint', ai.baseUrl] as [string, string]] : []),
            ...(keyName ? [['key', hasKey ? color.green(`${keyName} ✓`) : color.red(`${keyName} missing`)] as [string, string]] : []),
            ['transcription', transcribe.provider],
          ]),
        );
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

      if (defaults.apiKeyEnv) {
        const existing = (await loadSecrets())(defaults.apiKeyEnv);
        if (!existing && (await confirm(`Store an API key for ${defaults.apiKeyEnv}?`, true))) {
          const key = await promptLine('API key: ');
          if (key) {
            const path = await saveSecret(defaults.apiKeyEnv, key);
            out(color.dim(`Key saved to ${path} (0600). Keys never go in the vault.`));
          }
        }
      }

      out(`\n${color.green('✓')} configured ${color.bold(provider)}  ${color.dim(layerPath)}`);
      if (provider !== 'none') out(color.dim('Test it: ppr ai test'));
      void globals(self);
    });

  cmd
    .command('key')
    .description('store an API key in the 0600 credentials file')
    .argument('<env-var>', 'e.g. ANTHROPIC_API_KEY')
    .argument('[value]', 'the key; omit to be prompted')
    .action(async (name: string, value: string | undefined, _flags: unknown, self: Command) => {
      const key = value ?? (await promptLine(`${name}: `));
      if (!key) throw new PprError('EINVALID', 'No key given');
      const path = await saveSecret(name, key);
      if (globals(self).json) json({ name, file: path });
      else out(`${color.green('✓')} stored ${name} in ${path}`);
    });

  cmd
    .command('test')
    .description('send one prompt to the configured model')
    .action(async (_flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        if (!vault.provider) throw new PprError('ENOAI', 'No provider configured', 'Run `ppr ai setup`.');
        const started = Date.now();
        const reply = await vault.provider.generate({
          prompt: 'Reply with exactly: ppr ok',
          maxTokens: 20,
          temperature: 0,
        });
        const ms = Date.now() - started;
        if (globals(self).json) return json({ provider: vault.provider.id, model: vault.provider.model, reply, ms });
        out(`${color.green('✓')} ${vault.provider.id}/${vault.provider.model} replied in ${ms}ms`);
        out(color.dim(`  ${reply.slice(0, 120)}`));
      }),
    );

  return cmd;
}

/** `ppr doctor` — every dependency, checked, with the fix printed next to it. */
export function doctorCommand(): Command {
  return new Command('doctor')
    .description('check the environment and report anything that needs attention')
    .action(async (_flags: unknown, self: Command) => {
      const g = globals(self);
      const checks: Array<{ name: string; ok: boolean; detail: string; hint?: string }> = [];
      const add = (name: string, ok: boolean, detail: string, hint?: string) =>
        checks.push({ name, ok, detail, ...(hint ? { hint } : {}) });

      const found = findVault(g.vault ? { explicit: g.vault } : {});
      add('vault', found.exists, found.root, found.exists ? undefined : 'Run `ppr init`');

      const node = process.versions.node;
      add('node', Number(node.split('.')[0]) >= 20, `v${node}`, 'ppr needs Node 20.11+');

      if (found.exists) {
        const config = await loadConfig(found.root);
        const secrets = await loadSecrets();
        const { ai, transcribe } = config;

        if (ai.provider === 'none') {
          add('ai', true, 'not configured (offline heuristics)', 'Run `ppr ai setup` to enable');
        } else {
          const keyName = ai.apiKeyEnv ?? PROVIDER_DEFAULTS[ai.provider]?.apiKeyEnv;
          const ok = !keyName || Boolean(secrets(keyName));
          add('ai', ok, `${ai.provider}/${ai.model}`, ok ? undefined : `Set ${keyName} or run \`ppr ai key ${keyName}\``);
        }
        if (ai.provider === 'apple') {
          const swiftc = await which('swiftc');
          add('swiftc', Boolean(swiftc), swiftc ?? 'not found', 'xcode-select --install');
        }
        if (transcribe.provider === 'none') {
          add('voice', true, 'not configured', 'Set transcribe.provider to use `ppr voice`');
        } else {
          const t = createTranscriber(transcribe, secrets);
          add('voice', Boolean(t), transcribe.provider);
          if (transcribe.provider === 'whisper-cpp') {
            const bin = await which(transcribe.binary || 'whisper-cli');
            add('whisper', Boolean(bin), bin ?? 'not found', 'brew install whisper-cpp');
            add('whisper model', Boolean(transcribe.model), transcribe.model ?? 'not set', 'ppr config set transcribe.model <path>');
          }
        }
        const recorder = (await which('rec')) ?? (await which('ffmpeg'));
        add('recorder', Boolean(recorder), recorder ?? 'not found', 'brew install sox (only needed for `ppr voice`)');

        const vault = await openVault({ ...(g.vault ? { vault: g.vault } : {}) });
        add('entries', true, String(vault.stats().entries));
        await vault.close();
      }

      if (g.json) return json(checks);
      for (const check of checks) {
        const mark = check.ok ? color.green('✓') : color.yellow('!');
        out(`${mark} ${check.name.padEnd(14)} ${check.detail}`);
        if (!check.ok && check.hint) out(`  ${color.dim(check.hint)}`);
      }
      const failed = checks.filter((c) => !c.ok).length;
      if (failed) errline(`\n${color.yellow(`${failed} thing${failed === 1 ? '' : 's'} to look at`)}`);
    });
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
