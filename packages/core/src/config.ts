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
  guardSecret(path, raw);
  const keys = path.split('.');
  const leaf = keys.pop();
  if (!leaf) throw invalid('Empty config path');

  const clone = structuredClone(config) as unknown as Json;
  let node: Json = clone;
  for (const key of keys) {
    const next = node[key];
    if (!isPlainObject(next)) {
      throw invalid(`Unknown config section: ${keys.join('.')}`, 'Run `ppr config list` to see valid keys.');
    }
    node = next;
  }
  const current = getPath(config, path);
  if (current === undefined && !(leaf in node) && !OPTIONAL.has(path)) {
    throw invalid(`Unknown config key: ${path}`, 'Run `ppr config list` to see valid keys.');
  }
  node[leaf] = coerce(raw, current);
  return validateConfig(clone as unknown as Config);
}

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
 * No config write may end with a live key on disk. Both shapes of the mistake
 * are caught here, in the one function `ppr config set` and every guided repair
 * go through, so neither can quietly grow its own way in.
 */
function guardSecret(path: string, raw: string): void {
  if (KEY_VALUE_PATHS.has(path)) {
    throw invalid(
      `There is no ${path} setting — an API key never goes in a config file`,
      'Run `ppr ai key <value>` instead. It stores the key at mode 0600, outside the vault.',
    );
  }
  if (path.endsWith('.apiKeyEnv') && raw && looksLikeSecret(raw)) {
    throw invalid(
      `${path} takes the name of an environment variable, not the key itself`,
      'Run `ppr ai key <value>` — it stores the key and points this at the right name.',
    );
  }
}

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
