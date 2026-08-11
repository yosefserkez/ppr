import { invalid } from './errors.js';

export interface AIConfig {
  /** `none` keeps ppr fully offline and falls back to heuristics everywhere. */
  provider: 'none' | 'anthropic' | 'openai' | 'ollama' | 'apple' | 'command';
  model: string;
  /** OpenAI-compatible endpoints (LM Studio, vLLM, OpenRouter, Groq) go here. */
  baseUrl?: string;
  /**
   * Name of the env var holding the key — `OPENROUTER_API_KEY`, not the key.
   * ppr never writes a key into config. See `keyEnvFor` and `looksLikeSecret`.
   */
  apiKeyEnv?: string;
  /** For `provider: command` — receives the prompt on stdin, prints the reply. */
  command?: string;
  maxTokens: number;
  temperature: number;
}

export interface TranscribeConfig {
  provider: 'none' | 'whisper-cpp' | 'openai' | 'command';
  model?: string;
  /** Path to the whisper.cpp binary, or the recording tool to shell out to. */
  binary?: string;
  command?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  language?: string;
  /**
   * Input device to record from: an avfoundation index, a device name, or
   * `default` to follow the system setting. Index 0 is a trap — see `record()`.
   */
  device?: string;
}

export interface Config {
  ai: AIConfig;
  transcribe: TranscribeConfig;
  capture: {
    /** Kind used by a bare `ppr "..."`. */
    defaultKind: string;
    /** Run dumps through the model to strip noise. Off = raw text, always. */
    distill: boolean;
    /** Keep the original text under a `<details>` block when distilling. */
    keepRaw: boolean;
    /** Ceiling on auto-suggested tags, so the vault does not grow a tag swamp. */
    maxTags: number;
    /** Follow URLs found in a dump and attach an extract. */
    followUrls: boolean;
    /**
     * Wrap names the vault already knows in `[[wikilinks]]` as entries are
     * written — every kind, not just facts.
     *
     * Off by default because it edits your words. On, a model (when there is
     * one) marks the people and projects it sees, and every later entry links
     * to them without one, which is what keeps the graph consistent offline.
     */
    autoLink: boolean;
    /**
     * How `ppr write` takes a longer entry. `editor` hands you $EDITOR, where
     * you already know how to move around; `inline` keeps the terminal prompt.
     */
    compose: 'editor' | 'inline';
  };
  remind: {
    /**
     * Hand a dated reminder to something else as it is captured.
     *
     * *What* something else is, core has no idea and does not want one: the
     * host resolves a conventional program name — `ppr-reminders-push` in the
     * CLI — and this switch only says whether to. Replacing that program
     * changes where reminders go with no change here (I13).
     *
     * Off, because writing into another app is not something a note tool may
     * do to you by default. On, the copy is one-way and never read back: the
     * markdown stays the source of truth (I1), and completing the reminder
     * over there does not reach in here.
     */
    push: boolean;
  };
  /**
   * Settings belonging to tools ppr has never heard of.
   *
   * The one namespace with no schema, on purpose: a plugin needs somewhere to
   * keep "which Reminders list" or "how loud" that survives a reinstall and
   * that the user finds where they already look. `ppr config get
   * plugins.foo.bar` is the read path, or the JSON file itself for anything
   * that would rather not shell out.
   *
   * Everything else stays strict (L5): a typo in `ai.provider` is a mistake
   * worth refusing, while a key under `plugins.` is by definition a key ppr
   * does not know. Secrets are still refused here — this file is read by
   * `<vault>/.ppr/config.json` too, and a vault is assumed to be in git (I7).
   */
  plugins: Record<string, Record<string, unknown>>;
  display: {
    color: boolean;
    /** Entries shown by `ppr ls` with no --limit. */
    listLimit: number;
    /**
     * Open the keyboard browser for list commands on a terminal. Piped output,
     * `--json`, `--quiet`, and `--plain` are never interactive regardless.
     */
    interactive: boolean;
  };
  editor?: string;
}

export const DEFAULT_CONFIG: Config = {
  ai: {
    provider: 'none',
    model: '',
    maxTokens: 1024,
    temperature: 0.2,
  },
  transcribe: { provider: 'none' },
  capture: {
    defaultKind: 'log',
    distill: true,
    keepRaw: false,
    maxTags: 5,
    followUrls: true,
    autoLink: false,
    compose: 'editor',
  },
  remind: { push: false },
  plugins: {},
  display: { color: true, listLimit: 20, interactive: true },
};

/** Sensible model + endpoint per provider, applied when the user does not pick one. */
export const PROVIDER_DEFAULTS: Record<AIConfig['provider'], Partial<AIConfig>> = {
  none: {},
  anthropic: { model: 'claude-sonnet-5', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  openai: {
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  ollama: { model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434' },
  apple: { model: 'system' },
  command: { model: 'command' },
};

/**
 * `apiKeyEnv` holds the *name* of an environment variable. Pasting the key
 * itself is the mistake everyone makes once, and it is worth catching loudly:
 * the value then lands in error output, in shell history, and in whatever
 * happens to sync the config file.
 */
export function looksLikeSecret(value: string): boolean {
  // Keys carry punctuation an env var name cannot: sk-…, sk_…, ghp_…/…
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return true;
  // What survives that is long and mixed-case (Google's AIza… family).
  // Env var names are short and shouty, so this does not catch real ones.
  return value.length > 32 && /[a-z]/.test(value) && /\d/.test(value);
}

/** Enough of a secret to recognise it, never enough to use it. */
export const redactSecret = (value: string): string =>
  value.length <= 10 ? '…' : `${value.slice(0, 6)}…${value.slice(-4)}`;

/**
 * A name to keep this backend's key under, derived from the endpoint so a
 * custom host reads as itself: `https://openrouter.ai/api/v1` suggests
 * `OPENROUTER_API_KEY` rather than the provider-wide `OPENAI_API_KEY`.
 */
export function suggestKeyEnv(ai: AIConfig): string {
  const fallback = PROVIDER_DEFAULTS[ai.provider]?.apiKeyEnv ?? 'PPR_API_KEY';
  const url = ai.baseUrl || PROVIDER_DEFAULTS[ai.provider]?.baseUrl;
  if (!url) return fallback;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return fallback;
  }
  const label = host.replace(/^api\./, '').split('.')[0] ?? '';
  if (!label || label === 'localhost' || /^\d+$/.test(label)) return fallback;
  return `${label.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/**
 * The env var this backend reads its key from, or `undefined` when it needs no
 * key at all. One answer, so the runtime, `ppr ai status`, and `ppr doctor`
 * cannot disagree about which variable to look in.
 */
export function keyEnvFor(ai: AIConfig): string | undefined {
  // Local and shell-backed backends read no key, whatever a leftover
  // `apiKeyEnv` from a previous provider still says.
  if (!PROVIDER_DEFAULTS[ai.provider]?.apiKeyEnv) return undefined;
  // A key pasted here is not a name. Fall through to a real one, so nothing
  // downstream stores or looks up a secret under a variable named after itself.
  if (ai.apiKeyEnv && !looksLikeSecret(ai.apiKeyEnv)) return ai.apiKeyEnv;
  return suggestKeyEnv(ai);
}

/**
 * Optional keys have no default, so they are absent from `DEFAULT_CONFIG` — but
 * they are still settable. Listing them here keeps `ppr config set` strict about
 * typos without refusing the keys that matter most (endpoints, model paths).
 */
export const OPTIONAL_KEYS = [
  'ai.baseUrl',
  'ai.apiKeyEnv',
  'ai.command',
  'transcribe.model',
  'transcribe.binary',
  'transcribe.command',
  'transcribe.baseUrl',
  'transcribe.apiKeyEnv',
  'transcribe.language',
  'transcribe.device',
  'editor',
] as const;

const OPTIONAL = new Set<string>(OPTIONAL_KEYS);

type Json = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function mergeConfig(base: Config, ...overrides: Array<Partial<Config> | Json>): Config {
  return overrides.reduce<Config>((acc, o) => deepMerge(acc as unknown as Json, o) as unknown as Config, base);
}

function deepMerge(base: Json, override: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    // `JSON.parse` produces a real own `__proto__` key, and assigning one walks
    // into `Object.prototype`'s setter — so a config file could arrive through
    // the prototype instead, past every guard that works by deleting a key
    // (`hooks` here, `VAULT_FORBIDDEN_PATHS` in `loadConfig`). No config key is
    // ever spelled this way, so refusing all three costs nothing.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const prev = out[k];
    out[k] = isPlainObject(v) && isPlainObject(prev) ? deepMerge(prev, v) : v;
  }
  return out;
}

/** Reads `ai.provider` style paths. */
export function getPath(config: Config, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!isPlainObject(acc)) return undefined;
    return acc[key];
  }, config as unknown);
}

/**
 * Writes `ai.provider=ollama` style paths, coercing to the type already there
 * so `ppr config set display.color false` does not store the string "false".
 */
export function setPath(config: Config, path: string, raw: string): Config {
  guardUserOnly(path);
  guardSecret(path, raw);
  const keys = path.split('.');
  const leaf = keys.pop();
  if (!leaf) throw invalid('Empty config path');

  const clone = structuredClone(config) as unknown as Json;
  // The one namespace ppr does not police. Everywhere else, an unknown key is
  // a typo and refusing it is the feature (L5) — under `plugins.` an unknown
  // key is the *point*, because ppr does not know what is installed.
  const plugin = keys[0] === PLUGIN_NS;
  if (plugin && keys.length < 2) {
    throw invalid(
      `A plugin's settings live under ${PLUGIN_NS}.<plugin>.<key>`,
      `Example: ppr config set ${PLUGIN_NS}.reminders-push.list Errands`,
    );
  }

  let node: Json = clone;
  for (const key of keys) {
    const next = node[key];
    if (!isPlainObject(next)) {
      if (!plugin) {
        throw invalid(`Unknown config section: ${keys.join('.')}`, 'Run `ppr config list` to see valid keys.');
      }
      node[key] = {};
    }
    node = node[key] as Json;
  }
  const current = getPath(config, path);
  if (!plugin && current === undefined && !(leaf in node) && !OPTIONAL.has(path)) {
    throw invalid(`Unknown config key: ${path}`, 'Run `ppr config list` to see valid keys.');
  }
  node[leaf] = coerce(raw, current);
  return validateConfig(clone as unknown as Config);
}

const PLUGIN_NS = 'plugins';

/** The keys people reach for when they mean "put my key here", and the answer. */
const KEY_VALUE_PATHS = new Set([
  'ai.apiKey',
  'ai.api_key',
  'ai.key',
  'transcribe.apiKey',
  'transcribe.api_key',
  'transcribe.key',
]);

/**
 * The tables that name a program ppr will run. Not config keys, and not fields
 * on `Config` — see `validateConfig` and `cli/src/hooks.ts`.
 *
 * `hooks` maps an event to commands; `porcelain` maps an intent (`notify`,
 * `reminders-push`) to the command line `--notify` / `--push` should run. Both
 * are lists of programs to execute, and config merges the vault layer over the
 * user's — so either one anywhere near this type would mean cloning somebody's
 * vault and typing `ppr ls` runs their shell. Both are read from
 * `~/.config/ppr/config.json` alone, by the CLI.
 *
 * One list and one guard on purpose: a second guard is a second thing to
 * forget, and the next table of commands belongs here in the commit that adds
 * it.
 */
export const USER_ONLY_KEYS = ['hooks', 'porcelain'] as const;

/**
 * Keyed by the list itself, so "one list" is true rather than nearly true: a
 * table added to `USER_ONLY_KEYS` with no label here is a compile error, where
 * a `Record<string, string>` compiled clean and told whoever hit the guard that
 * "undefined are not settable with `ppr config set`".
 */
const USER_ONLY_LABEL: Record<(typeof USER_ONLY_KEYS)[number], string> = {
  hooks: 'Hooks',
  porcelain: 'Porcelain bindings',
};

/**
 * Where "not a config key" is said out loud.
 *
 * `--local` has to be impossible rather than discouraged, so this refuses at
 * every scope. Editing the global file by hand is the whole interface; refusing
 * here is how someone finds that out.
 */
function guardUserOnly(path: string): void {
  const key = USER_ONLY_KEYS.find((k) => path === k || path.startsWith(`${k}.`));
  if (!key) return;
  throw invalid(
    `${USER_ONLY_LABEL[key]} are not settable with \`ppr config set\``,
    'They name a program ppr will run, so ppr reads them only from ~/.config/ppr/config.json — edit that file.',
  );
}

/**
 * Keys that name a program to run, or an endpoint to send your key to.
 *
 * They describe the machine, not the notes — and the vault layer wins every
 * merge, so honouring one from `<vault>/.ppr/config.json` means `git clone`
 * followed by any command that reaches a model runs a stranger's shell or
 * posts your API key to their host. That is `hooks`' danger exactly (see
 * `guardUserOnly`), so it gets `hooks`' answer: the global layer keeps them, the
 * vault layer never sets them. Anything new that spawns or dials out belongs
 * on this list in the same commit that adds it.
 *
 * Enforced on the way in by `loadConfig`, which strips these from the vault
 * layer before the merge, and on the way out by `guardVaultScope`.
 */
export const VAULT_FORBIDDEN_PATHS = [
  'ai.command',
  'ai.baseUrl',
  'ai.apiKeyEnv',
  'transcribe.command',
  'transcribe.binary',
  'transcribe.baseUrl',
  'transcribe.apiKeyEnv',
] as const;

const VAULT_FORBIDDEN = new Set<string>(VAULT_FORBIDDEN_PATHS);

/**
 * Provider values that resolve to a program on this machine rather than a URL.
 *
 * Fencing the key that *names* the program is only half of it: a vault that
 * could still switch the provider would run whatever the machine's own
 * `ai.command`, `transcribe.command`, or `transcribe.binary` already says —
 * the same `git clone && ppr voice` that `VAULT_FORBIDDEN_PATHS` exists to
 * stop. One list drives both halves of the fence, so a new provider that
 * shells out is added here and nowhere else.
 */
export const VAULT_FORBIDDEN_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  'ai.provider': ['command'],
  // `whisper-cpp` shells out too — to `transcribe.binary`, or to whatever
  // `whisper-cli` is on PATH when that key is unset.
  'transcribe.provider': ['whisper-cpp', 'command'],
};

/**
 * Whether a provider value would hand the vault layer a program to run.
 *
 * Compares *trimmed*, because `validateConfig` trims after the merge: without
 * it a single trailing space walked past the load-time fence and arrived as
 * `command`, while the write-time guard refused the same string. Both halves
 * ask this function so they cannot disagree again.
 */
export function isShellProvider(path: string, value: unknown): boolean {
  const shells = VAULT_FORBIDDEN_PROVIDERS[path];
  if (!shells || typeof value !== 'string') return false;
  return shells.includes(value.trim());
}

/**
 * `ppr config set --local` refusing what `loadConfig` would throw away anyway.
 *
 * Writing the key and silently ignoring it afterwards reads as a bug and
 * teaches nothing; saying so names the file that does honour it. A `provider`
 * key is on the list only for the values that turn a vault into a shell —
 * pinning `ollama` or `openai` for one vault stays allowed.
 */
export function guardVaultScope(path: string, raw?: string): void {
  const forbidden = VAULT_FORBIDDEN.has(path) || isShellProvider(path, raw);
  if (!forbidden) return;
  throw invalid(
    `${path} cannot be set for one vault`,
    'It names a program to run or an endpoint to send your key to, so ppr reads it only from ~/.config/ppr/config.json — drop --local.',
  );
}

/**
 * Key names that mean "a secret goes here", whoever owns the namespace.
 *
 * ppr can police its own keys by listing them; a plugin's keys it has never
 * seen, so the only signal left is the name the author chose — and every
 * author calls it `token`, `apiKey`, or `password`. `tokenEnv` is deliberately
 * outside this: naming the variable is exactly the thing we want people doing.
 */
const SECRET_KEY = /\.(api[-_]?key|key|token|secret|password|passwd|credentials?)$/i;

/**
 * No config write may end with a live key on disk. Every shape of the mistake
 * is caught here, in the one function `ppr config set` and every guided repair
 * go through, so none of them can quietly grow its own way in.
 */
function guardSecret(path: string, raw: string): void {
  // A plugin's config merges through the vault layer, and a vault is assumed
  // to be in git (I7). "It is only my Todoist token" is how a token gets
  // pushed to a public repo.
  if (path.startsWith(`${PLUGIN_NS}.`) && SECRET_KEY.test(path)) {
    throw invalid(
      `${path} is a place people put secrets, and a config file is not one`,
      `Keep the key in an environment variable and store its *name*: ${path}Env=MY_TOKEN.`,
    );
  }
  if (path.startsWith(`${PLUGIN_NS}.`) && /Env$/.test(path) && raw && looksLikeSecret(raw)) {
    throw invalid(
      `${path} takes the name of an environment variable, not the value`,
      'Export the value in your shell and put the variable name here.',
    );
  }
  if (KEY_VALUE_PATHS.has(path)) {
    throw invalid(
      `There is no ${path} setting — an API key never goes in a config file`,
      'Run `ppr ai key` instead: it prompts, and stores the key at mode 0600 outside the vault. Passing the value on the command line records it in your shell history.',
    );
  }
  if (path.endsWith('.apiKeyEnv') && raw && looksLikeSecret(raw)) {
    throw invalid(
      `${path} takes the name of an environment variable, not the key itself`,
      'Run `ppr ai key` — it prompts for the key, stores it, and points this at the right name. Passing the value on the command line records it in your shell history.',
    );
  }
}

/**
 * A config value on its way to a terminal or a `--json` payload.
 *
 * `guardSecret` only ever sees a `ppr config set`. A key that arrived any
 * other way — a hand-edited file, a vault layer, a write from before that
 * guard existed — is sitting in the merged config, and `config list`,
 * `config get`, and `ai status --json` would read it straight back out. I7 is
 * "every path that touches it refuses to", and this is the way out.
 *
 * Judged exactly as `guardSecret` judges a write and no wider: the key *names*
 * a secret, or it takes a variable *name* (`…Env`) and is holding something
 * that plainly is not one. `looksLikeSecret` cannot be applied to every value
 * here — it answers "is this an environment variable name?", so it calls
 * `gpt-4o-mini`, every endpoint and every model path a secret too, and a
 * `config list` that hid your model id would be useless for the one thing
 * anybody runs it for.
 */
export function redactValue(path: string, value: unknown): unknown {
  if (isPlainObject(value)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(path ? `${path}.${k}` : k, v);
    return out;
  }
  if (typeof value !== 'string' || !value) return value;
  const names = SECRET_KEY.test(`.${path}`);
  const pasted = path.endsWith('Env') && looksLikeSecret(value);
  return names || pasted ? redactSecret(value) : value;
}

/** The whole effective config, safe to print. */
export const redactConfig = (config: Config): Config => redactValue('', config) as Config;

function coerce(raw: string, current: unknown): unknown {
  if (raw === 'null' || raw === '') return undefined;
  if (typeof current === 'boolean' || raw === 'true' || raw === 'false') {
    if (raw !== 'true' && raw !== 'false') throw invalid(`Expected true or false, got "${raw}"`);
    return raw === 'true';
  }
  if (typeof current === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw invalid(`Expected a number, got "${raw}"`);
    return n;
  }
  return raw;
}

const PROVIDERS = new Set(Object.keys(PROVIDER_DEFAULTS));

/**
 * A hand-edited file picks up stray whitespace, and a padded model id comes
 * back as a 400 from someone else's server rather than as a mistake you can
 * see. Trim once, here, where every config load and write passes through.
 */
function trimStrings(node: Json): void {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') node[key] = value.trim();
    else if (isPlainObject(value)) trimStrings(value);
  }
}

export function validateConfig(config: Config): Config {
  trimStrings(config as unknown as Json);
  // A `hooks` or `porcelain` block that arrived through a merge is dropped
  // here, so no code downstream can find one to honour: both are tables of
  // programs to run, and one of them arriving from a vault is `git clone`
  // followed by `ppr ls` executing a stranger's shell. The vault layer wins
  // every other key by design, and a vault is a repo people clone — see
  // `cli/src/hooks.ts` for the rule and `cli/src/porcelain.ts` for the
  // second table that carries it.
  for (const key of USER_ONLY_KEYS) delete (config as unknown as Json)[key];
  if (config.capture.compose !== 'editor' && config.capture.compose !== 'inline') {
    throw invalid(
      `Unknown compose mode: ${config.capture.compose}`,
      'Pick one of: editor, inline',
    );
  }
  if (!PROVIDERS.has(config.ai.provider)) {
    throw invalid(
      `Unknown AI provider: ${config.ai.provider}`,
      `Pick one of: ${[...PROVIDERS].join(', ')}`,
    );
  }
  if (config.ai.provider !== 'none' && !config.ai.model) {
    config.ai.model = PROVIDER_DEFAULTS[config.ai.provider].model ?? '';
  }
  return config;
}

/** Applies provider defaults for keys the user has not set explicitly. */
export function withProviderDefaults(ai: AIConfig): AIConfig {
  const defaults = PROVIDER_DEFAULTS[ai.provider] ?? {};
  return {
    ...ai,
    model: ai.model || defaults.model || '',
    baseUrl: ai.baseUrl || defaults.baseUrl,
    // Whatever the user actually wrote survives, so the provider can tell a
    // missing key apart from a key pasted where its name belongs.
    apiKeyEnv: ai.apiKeyEnv || keyEnvFor(ai),
  };
}

/** Flattens config to `a.b = value` lines for display and shell completion. */
export function flattenConfig(config: Config, prefix = ''): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(config as unknown as Json)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) out.push(...flattenConfig(v as unknown as Config, path));
    else out.push([path, v]);
  }
  if (!prefix) {
    // Show the settable-but-unset keys too, so they are discoverable.
    const seen = new Set(out.map(([k]) => k));
    for (const key of OPTIONAL_KEYS) if (!seen.has(key)) out.push([key, undefined]);
    out.sort((a, b) => a[0].localeCompare(b[0]));
  }
  return out;
}
