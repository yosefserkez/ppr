import type { AIConfig } from '../config.js';
import { looksLikeSecret, redactSecret, withProviderDefaults } from '../config.js';
import { PprError } from '../errors.js';
import type { AIProvider, GenerateRequest } from '../ports.js';

/** Anything that can hand back a secret: process.env, a keychain, a mobile store. */
export type SecretSource = (name: string) => string | undefined;

const DEFAULT_TIMEOUT_MS = 120_000;

async function post(
  url: string,
  init: { headers: Record<string, string>; body: unknown; signal?: AbortSignal },
): Promise<unknown> {
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify(init.body),
      signal,
    });
  } catch (err) {
    throw new PprError(
      'ENETWORK',
      `Could not reach ${new URL(url).host}: ${(err as Error).message}`,
      'Check the endpoint is running and reachable, or run with --no-ai.',
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    throw new PprError('EAI', `${new URL(url).host} returned ${res.status}: ${detail}`);
  }
  return res.json();
}

const requireKey = (ai: AIConfig, secrets: SecretSource): string => {
  const name = ai.apiKeyEnv ?? '';
  // The name is echoed in the message below, so a key pasted into `apiKeyEnv`
  // would leak into stderr, CI logs, and pasted bug reports. Catch it first.
  if (name && looksLikeSecret(name)) {
    throw new PprError(
      'ECONFIG',
      `ai.apiKeyEnv holds a key (${redactSecret(name)}), not the name of an environment variable`,
      'Run `ppr ai key` — it stores the key outside your config and points ai.apiKeyEnv at it.',
    );
  }
  const key = name ? secrets(name) : undefined;
  if (!key) {
    throw new PprError(
      'ECONFIG',
      `No API key for ${ai.provider}`,
      name
        ? `Run \`ppr ai key\` to store one, or export ${name} in your shell.`
        : 'Run `ppr ai setup` to configure a backend.',
    );
  }
  return key;
};

function anthropic(ai: AIConfig, secrets: SecretSource): AIProvider {
  return {
    id: 'anthropic',
    model: ai.model,
    local: false,
    async generate(req) {
      const body = {
        model: ai.model,
        max_tokens: req.maxTokens ?? ai.maxTokens,
        temperature: req.temperature ?? ai.temperature,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }],
      };
      const json = (await post(`${ai.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
        headers: {
          'x-api-key': requireKey(ai, secrets),
          'anthropic-version': '2023-06-01',
        },
        body,
        signal: req.signal,
      })) as { content?: Array<{ type: string; text?: string }> };
      return (json.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('')
        .trim();
    },
  };
}

/** Covers OpenAI plus every OpenAI-compatible endpoint (LM Studio, vLLM, Groq, OpenRouter). */
function openaiCompatible(ai: AIConfig, secrets: SecretSource): AIProvider {
  const baseUrl = ai.baseUrl ?? 'https://api.openai.com/v1';
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0|\.local\b/.test(baseUrl);
  // OpenAI proper requires max_completion_tokens; most compatible servers only know max_tokens.
  const tokenKey = /\bapi\.openai\.com\b/.test(baseUrl) ? 'max_completion_tokens' : 'max_tokens';

  return {
    id: 'openai',
    model: ai.model,
    local: isLocal,
    async generate(req) {
      const headers: Record<string, string> = {};
      // Local servers usually need no key; only demand one when configured to.
      const key = ai.apiKeyEnv ? secrets(ai.apiKeyEnv) : undefined;
      if (key) headers.authorization = `Bearer ${key}`;
      else if (!isLocal) requireKey(ai, secrets);

      const json = (await post(`${baseUrl}/chat/completions`, {
        headers,
        body: {
          model: ai.model,
          messages: [
            ...(req.system ? [{ role: 'system', content: req.system }] : []),
            { role: 'user', content: req.prompt },
          ],
          temperature: req.temperature ?? ai.temperature,
          [tokenKey]: req.maxTokens ?? ai.maxTokens,
          ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        },
        signal: req.signal,
      })) as { choices?: Array<{ message?: { content?: string } }> };
      return (json.choices?.[0]?.message?.content ?? '').trim();
    },
  };
}

/** Ollama's native API: no key, no account, nothing leaves the machine. */
function ollama(ai: AIConfig): AIProvider {
  return {
    id: 'ollama',
    model: ai.model,
    local: true,
    async generate(req) {
      const json = (await post(`${ai.baseUrl ?? 'http://127.0.0.1:11434'}/api/chat`, {
        headers: {},
        body: {
          model: ai.model,
          stream: false,
          ...(req.json ? { format: 'json' } : {}),
          messages: [
            ...(req.system ? [{ role: 'system', content: req.system }] : []),
            { role: 'user', content: req.prompt },
          ],
          options: {
            temperature: req.temperature ?? ai.temperature,
            num_predict: req.maxTokens ?? ai.maxTokens,
          },
        },
        signal: req.signal,
      })) as { message?: { content?: string } };
      return (json.message?.content ?? '').trim();
    },
  };
}

/**
 * Builds the provider for a config. Returns undefined for `none` — callers
 * then take the offline path rather than failing.
 *
 * Providers that need a shell (`apple`, `command`) are registered by the host
 * via `registerProvider`, keeping core free of platform imports.
 */
export function createProvider(rawAi: AIConfig, secrets: SecretSource): AIProvider | undefined {
  const ai = withProviderDefaults(rawAi);
  switch (ai.provider) {
    case 'none':
      return undefined;
    case 'anthropic':
      return anthropic(ai, secrets);
    case 'openai':
      return openaiCompatible(ai, secrets);
    case 'ollama':
      return ollama(ai);
    default: {
      const factory = registry.get(ai.provider);
      if (!factory) {
        throw new PprError(
          'ECONFIG',
          `Provider "${ai.provider}" is not available on this platform`,
          'Run `ppr ai list` to see what this build supports.',
        );
      }
      return factory(ai, secrets);
    }
  }
}

export type ProviderFactory = (ai: AIConfig, secrets: SecretSource) => AIProvider;

const registry = new Map<string, ProviderFactory>();

/** Hosts call this at startup to add platform-specific providers. */
export function registerProvider(id: string, factory: ProviderFactory): void {
  registry.set(id, factory);
}

export const registeredProviders = (): string[] => [...registry.keys()];

export type { GenerateRequest };
