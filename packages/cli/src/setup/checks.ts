import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  DEFAULT_WHISPER_MODEL,
  PROVIDER_DEFAULTS,
  WHISPER_MODELS,
  findWhisperModel,
  type Config,
} from '@ppr/core';
import {
  downloadFile,
  formatBytes,
  initVault,
  loadConfig,
  loadSecrets,
  modelsDir,
  run,
  saveSecret,
  which,
} from '@ppr/core/node';
import { color, out, errline } from '../render.js';
import { confirm, promptLine } from '../input.js';
import { select } from '../ui/select.js';
import { writeSetting } from '../config-io.js';

/**
 * One registry of "what can be wrong, and how to fix it".
 *
 * `ppr doctor` renders it as a report. `ppr setup` walks it as a guided
 * install. `--json` hands an agent the same list with the exact command for
 * each fix. Three surfaces, one definition — a wizard that knew things the
 * doctor did not would drift within a month.
 */

export type Status = 'ok' | 'missing' | 'warn';

export interface CheckContext {
  root: string;
  vaultExists: boolean;
  /** Follows the vault when a repair puts it somewhere else. */
  useRoot(root: string): Promise<void>;
  config: Config;
  secret(name: string): string | undefined;
  /** Re-reads config and secrets after a repair changed something. */
  reload(): Promise<void>;
}

export interface Finding {
  status: Status;
  detail: string;
  /** The non-interactive equivalent, so scripts and agents can do it too. */
  fix?: string;
}

export interface Check {
  id: string;
  label: string;
  /** Irrelevant checks are skipped entirely rather than reported as passing. */
  applies?(ctx: CheckContext): boolean;
  inspect(ctx: CheckContext): Promise<Finding>;
  /** Interactive remedy. Returns true when it changed something. */
  repair?(ctx: CheckContext): Promise<boolean>;
  /** Part of the guided walkthrough even when it is already fine. */
  guided?: boolean;
}

export interface CheckReport extends Finding {
  id: string;
  label: string;
  repairable: boolean;
}

// ---------------------------------------------------------------- helpers

const ok = (detail: string): Finding => ({ status: 'ok', detail });
const missing = (detail: string, fix?: string): Finding => ({
  status: 'missing',
  detail,
  ...(fix ? { fix } : {}),
});
const warn = (detail: string, fix?: string): Finding => ({
  status: 'warn',
  detail,
  ...(fix ? { fix } : {}),
});

const expandHome = (path: string): string =>
  path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

const keyEnvFor = (config: Config): string | undefined =>
  config.ai.apiKeyEnv ?? PROVIDER_DEFAULTS[config.ai.provider]?.apiKeyEnv;

const ollamaUrl = (config: Config): string =>
  config.ai.baseUrl ?? PROVIDER_DEFAULTS.ollama.baseUrl ?? 'http://127.0.0.1:11434';

/** Offers to run an install command, showing exactly what will run. */
async function offerInstall(what: string, command: string): Promise<boolean> {
  const [bin] = command.split(/\s+/);
  if (!(await which(bin!))) {
    out(`  ${color.dim(`install it with: ${command}`)}`);
    return false;
  }
  if (!(await confirm(`Install ${what} with \`${command}\`?`, true))) return false;

  out(color.dim(`  $ ${command}`));
  const [cmd, ...args] = command.split(/\s+/);
  const { code } = await run(cmd!, args, { timeoutMs: 900_000 });
  if (code !== 0) {
    errline(color.yellow(`  ${command} failed — install it yourself and re-run \`ppr setup\``));
    return false;
  }
  return true;
}

/** A single stderr line that rewrites itself, so downloads do not spam the log. */
function progressLine(): (text: string) => void {
  let active = false;
  return (text: string) => {
    if (!process.stderr.isTTY) return;
    process.stderr.write(`\r${text}\x1b[K`);
    active = true;
    if (!text) {
      process.stderr.write('\n');
      active = false;
    }
    void active;
  };
}

// ----------------------------------------------------------------- checks

const vaultCheck: Check = {
  id: 'vault',
  label: 'Vault',
  guided: true,
  async inspect(ctx) {
    return ctx.vaultExists ? ok(ctx.root) : missing(`none at ${ctx.root}`, 'ppr init');
  },
  async repair(ctx) {
    if (ctx.vaultExists) {
      out(`  ${color.dim('already at')} ${ctx.root}`);
      return false;
    }
    const where = (await promptLine(`  Where should notes live? [${ctx.root}] `)) || ctx.root;
    const target = resolve(expandHome(where));
    const { created } = await initVault(target);
    out(`  ${color.green('✓')} ${created ? 'created' : 'already there'} ${target}`);
    out(color.dim(`  → ppr init ${target}`));
    // Later steps read config from the vault, so they have to follow it there.
    await ctx.useRoot(target);
    return created;
  },
};

const nodeCheck: Check = {
  id: 'node',
  label: 'Node',
  async inspect() {
    const version = process.versions.node;
    const major = Number(version.split('.')[0]);
    return major >= 20 ? ok(`v${version}`) : missing(`v${version}`, 'upgrade to Node 20.11+');
  },
};

const backendCheck: Check = {
  id: 'ai',
  label: 'Model backend',
  guided: true,
  async inspect(ctx) {
    const { provider, model } = ctx.config.ai;
    if (provider === 'none') {
      return warn('not configured — offline heuristics only', 'ppr config set ai.provider ollama');
    }
    return ok(`${provider}${model ? `/${model}` : ''}`);
  },
  async repair(ctx) {
    const choices = [
      { value: 'none', label: 'none', hint: 'offline only — heuristics, no model' },
      { value: 'apple', label: 'apple', hint: 'on-device, macOS 26+, no key, no download' },
      { value: 'ollama', label: 'ollama', hint: 'local models on your machine, no key' },
      { value: 'anthropic', label: 'anthropic', hint: 'Claude API, bring your own key' },
      { value: 'openai', label: 'openai', hint: 'OpenAI or any compatible endpoint' },
      { value: 'command', label: 'command', hint: 'any command that reads a prompt on stdin' },
    ];
    const current = choices.findIndex((c) => c.value === ctx.config.ai.provider);
    const picked = await select({
      title: 'Model backend',
      choices,
      initial: Math.max(0, current),
    });
    await writeSetting(ctx.root, 'ai.provider', picked.value);
    out(color.dim(`  → ppr config set ai.provider ${picked.value}`));

    if (picked.value !== 'none') {
      const fallback = PROVIDER_DEFAULTS[picked.value as keyof typeof PROVIDER_DEFAULTS]?.model ?? '';
      const model = (await promptLine(`  Model [${fallback}]: `)) || fallback;
      if (model) {
        await writeSetting(ctx.root, 'ai.model', model);
        out(color.dim(`  → ppr config set ai.model ${model}`));
      }
    }
    if (picked.value === 'command') {
      const command = await promptLine('  Command (prompt arrives on stdin): ');
      if (command) {
        await writeSetting(ctx.root, 'ai.command', command);
        out(color.dim(`  → ppr config set ai.command ${JSON.stringify(command)}`));
      }
    }
    await ctx.reload();
    return true;
  },
};

const apiKeyCheck: Check = {
  id: 'ai.key',
  label: 'API key',
  applies: (ctx) => Boolean(keyEnvFor(ctx.config)),
  async inspect(ctx) {
    const name = keyEnvFor(ctx.config)!;
    return ctx.secret(name) ? ok(`${name} found`) : missing(`${name} not set`, `ppr ai key ${name}`);
  },
  async repair(ctx) {
    const name = keyEnvFor(ctx.config)!;
    if (ctx.secret(name)) {
      out(`  ${color.dim(`${name} already set`)}`);
      return false;
    }
    const key = await promptLine(`  ${name}: `);
    if (!key) return false;
    const path = await saveSecret(name, key);
    out(`  ${color.green('✓')} saved to ${path} ${color.dim('(0600, never in the vault)')}`);
    out(color.dim(`  → ppr ai key ${name} <value>`));
    await ctx.reload();
    return true;
  },
};

const ollamaCheck: Check = {
  id: 'ai.ollama',
  label: 'Ollama',
  applies: (ctx) => ctx.config.ai.provider === 'ollama',
  async inspect(ctx) {
    const url = ollamaUrl(ctx.config);
    const wanted = ctx.config.ai.model;
    let tags: { models?: Array<{ name?: string }> };
    try {
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return missing(`${url} returned ${res.status}`, 'ollama serve');
      tags = (await res.json()) as typeof tags;
    } catch {
      return missing(
        `not reachable at ${url}`,
        (await which('ollama')) ? 'ollama serve' : 'brew install ollama',
      );
    }
    const names = (tags.models ?? []).map((m) => m.name ?? '');
    const has = names.some((n) => n === wanted || n.startsWith(`${wanted}:`));
    return has
      ? ok(`${wanted} ready`)
      : missing(`${wanted} not pulled (${names.length} other models)`, `ollama pull ${wanted}`);
  },
  async repair(ctx) {
    const url = ollamaUrl(ctx.config);
    if (!(await which('ollama'))) {
      if (!(await offerInstall('Ollama', 'brew install ollama'))) return false;
    }
    const reachable = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (!reachable) {
      out(color.yellow(`  Ollama is not running. Start it, then re-run this step.`));
      out(color.dim('  → ollama serve'));
      return false;
    }

    const model = ctx.config.ai.model || 'llama3.2';
    if (!(await confirm(`Pull \`${model}\`? This downloads a few GB`, true))) return false;
    out(color.dim(`  $ ollama pull ${model}`));
    // Inherit stdio so the user sees ollama's own progress bar.
    const code = await new Promise<number>((settle) => {
      import('node:child_process').then(({ spawn }) => {
        const child = spawn('ollama', ['pull', model], { stdio: 'inherit' });
        child.on('error', () => settle(-1));
        child.on('close', (c) => settle(c ?? 0));
      });
    });
    return code === 0;
  },
};

const appleCheck: Check = {
  id: 'ai.apple',
  label: 'Apple Intelligence',
  applies: (ctx) => ctx.config.ai.provider === 'apple',
  async inspect() {
    if (process.platform !== 'darwin') return missing('not macOS', 'ppr config set ai.provider ollama');
    const swiftc = await which('swiftc');
    return swiftc
      ? ok('swiftc found; the model is checked on first use')
      : missing('swiftc not found', 'xcode-select --install');
  },
  async repair() {
    if (!(await which('swiftc'))) {
      return offerInstall('the Xcode command line tools', 'xcode-select --install');
    }
    out(color.dim('  Building the on-device helper (once, ~10s) …'));
    const { ensureAppleShim } = await import('@ppr/core/node');
    try {
      await ensureAppleShim();
      out(`  ${color.green('✓')} helper ready`);
      return true;
    } catch (err) {
      errline(color.yellow(`  ${(err as Error).message}`));
      return false;
    }
  },
};

const voiceCheck: Check = {
  id: 'voice',
  label: 'Voice capture',
  guided: true,
  async inspect(ctx) {
    const { provider } = ctx.config.transcribe;
    return provider === 'none'
      ? warn('not configured', 'ppr config set transcribe.provider whisper-cpp')
      : ok(provider);
  },
  async repair(ctx) {
    const choices = [
      { value: 'none', label: 'none', hint: 'skip voice capture' },
      { value: 'whisper-cpp', label: 'whisper-cpp', hint: 'local, no key, needs a model download' },
      { value: 'openai', label: 'openai', hint: 'OpenAI transcription API, needs a key' },
      { value: 'command', label: 'command', hint: 'any command that takes {file}' },
    ];
    const current = choices.findIndex((c) => c.value === ctx.config.transcribe.provider);
    const picked = await select({ title: 'Voice capture', choices, initial: Math.max(0, current) });
    await writeSetting(ctx.root, 'transcribe.provider', picked.value);
    out(color.dim(`  → ppr config set transcribe.provider ${picked.value}`));

    if (picked.value === 'command') {
      const command = await promptLine('  Command ({file} is the audio path): ');
      if (command) {
        await writeSetting(ctx.root, 'transcribe.command', command);
        out(color.dim(`  → ppr config set transcribe.command ${JSON.stringify(command)}`));
      }
    }
    await ctx.reload();
    return true;
  },
};

const whisperBinaryCheck: Check = {
  id: 'voice.binary',
  label: 'whisper.cpp',
  applies: (ctx) => ctx.config.transcribe.provider === 'whisper-cpp',
  async inspect(ctx) {
    const binary = ctx.config.transcribe.binary || 'whisper-cli';
    const found = await which(binary);
    return found ? ok(found) : missing(`${binary} not found`, 'brew install whisper-cpp');
  },
  async repair(ctx) {
    const binary = ctx.config.transcribe.binary || 'whisper-cli';
    if (await which(binary)) return false;
    return offerInstall('whisper.cpp', 'brew install whisper-cpp');
  },
};

const whisperModelCheck: Check = {
  id: 'voice.model',
  label: 'Speech model',
  applies: (ctx) => ctx.config.transcribe.provider === 'whisper-cpp',
  async inspect(ctx) {
    const configured = ctx.config.transcribe.model;
    if (!configured) {
      return missing('no model file set', `ppr setup  ${color.dim('(downloads one)')}`.trim());
    }
    const path = expandHome(configured);
    const info = await stat(path).catch(() => null);
    return info?.isFile()
      ? ok(`${configured} (${formatBytes(info.size)})`)
      : missing(`${configured} is not on disk`, `ppr config set transcribe.model <path>`);
  },
  async repair(ctx) {
    const configured = ctx.config.transcribe.model;
    if (configured && existsSync(expandHome(configured))) {
      out(`  ${color.dim(`already have ${configured}`)}`);
      return false;
    }

    const picked = await select({
      title: 'Speech model to download',
      choices: WHISPER_MODELS.map((model) => ({
        value: model.id,
        label: model.id,
        hint: `${model.sizeMb} MB — ${model.note ?? ''}`,
      })),
      initial: Math.max(0, WHISPER_MODELS.findIndex((m) => m.id === DEFAULT_WHISPER_MODEL)),
    });

    const model = findWhisperModel(picked.value)!;
    const destination = join(modelsDir(), model.file);
    if (!(await confirm(`Download ${model.label} (${model.sizeMb} MB) to ${modelsDir()}?`, true))) {
      out(color.dim(`  → ppr config set transcribe.model <path to a ggml model>`));
      return false;
    }

    const draw = progressLine();
    const result = await downloadFile(model.url, destination, {
      onProgress: ({ received, total, fraction }) => {
        const pct = fraction === null ? '' : ` ${Math.round(fraction * 100)}%`;
        draw(`  ${color.dim(`downloading ${model.file}${pct} (${formatBytes(received)}/${formatBytes(total)})`)}`);
      },
    });
    draw('');

    out(`  ${color.green('✓')} ${result.skipped ? 'already downloaded' : 'downloaded'} ${destination}`);
    await writeSetting(ctx.root, 'transcribe.model', destination);
    out(color.dim(`  → ppr config set transcribe.model ${destination}`));
    await ctx.reload();
    return true;
  },
};

const recorderCheck: Check = {
  id: 'voice.recorder',
  label: 'Microphone',
  applies: (ctx) => ctx.config.transcribe.provider !== 'none',
  async inspect() {
    const tool = (await which('rec')) ?? (await which('ffmpeg'));
    if (!tool) return missing('no recorder (sox or ffmpeg)', 'brew install sox');
    const note =
      process.platform === 'darwin'
        ? ' — grant your terminal microphone access in System Settings › Privacy'
        : '';
    return ok(`${tool}${note}`);
  },
  async repair() {
    if ((await which('rec')) ?? (await which('ffmpeg'))) return false;
    return offerInstall('sox', 'brew install sox');
  },
};

export const CHECKS: Check[] = [
  vaultCheck,
  nodeCheck,
  backendCheck,
  apiKeyCheck,
  ollamaCheck,
  appleCheck,
  voiceCheck,
  whisperBinaryCheck,
  whisperModelCheck,
  recorderCheck,
];

/** Builds the context every check reads from. */
export async function checkContext(root: string, vaultExists: boolean): Promise<CheckContext> {
  let currentRoot = root;
  let config = await loadConfig(currentRoot);
  let secrets = await loadSecrets();

  const ctx: CheckContext = {
    get root() {
      return currentRoot;
    },
    vaultExists,
    get config() {
      return config;
    },
    secret: (name) => secrets(name),
    async useRoot(next: string) {
      currentRoot = next;
      await ctx.reload();
    },
    async reload() {
      config = await loadConfig(currentRoot);
      secrets = await loadSecrets();
      ctx.vaultExists = existsSync(join(currentRoot, '.ppr'));
    },
  } as CheckContext;
  return ctx;
}

export function applicable(ctx: CheckContext): Check[] {
  return CHECKS.filter((check) => !check.applies || check.applies(ctx));
}

export async function inspectAll(ctx: CheckContext): Promise<CheckReport[]> {
  const reports: CheckReport[] = [];
  for (const check of applicable(ctx)) {
    const finding = await check.inspect(ctx);
    reports.push({ id: check.id, label: check.label, repairable: Boolean(check.repair), ...finding });
  }
  return reports;
}

export const isAbsolutePath = isAbsolute;
