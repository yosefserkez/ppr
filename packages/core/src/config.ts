import { invalid } from './errors.js';

export interface AIConfig {
  /** `none` keeps ppr fully offline and falls back to heuristics everywhere. */
  provider: 'none' | 'anthropic' | 'openai' | 'ollama' | 'apple' | 'command';
  model: string;
  /** OpenAI-compatible endpoints (LM Studio, vLLM, OpenRouter, Groq) go here. */
  baseUrl?: string;
  /** Name of the env var holding the key. ppr never writes keys into config. */
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

export function validateConfig(config: Config): Config {
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
    apiKeyEnv: ai.apiKeyEnv || defaults.apiKeyEnv,
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
