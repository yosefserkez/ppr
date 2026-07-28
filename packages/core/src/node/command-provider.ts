import type { AIConfig } from '../config.js';
import { PprError } from '../errors.js';
import type { AIProvider } from '../ports.js';
import { run } from './exec.js';

/**
 * Any program that reads a prompt on stdin and writes a reply on stdout is a
 * valid ppr model. `llm`, `mods`, `ollama run`, a local llama.cpp binary, or a
 * three-line script of your own.
 *
 * Placeholders: {system} {prompt} {model}. With none present, the prompt is
 * piped on stdin — which is what most tools want.
 */
export function commandProvider(ai: AIConfig): AIProvider {
  const template = ai.command?.trim();
  if (!template) {
    throw new PprError(
      'ECONFIG',
      'No command configured for the `command` provider',
      'Set one: ppr config set ai.command "llm -m mistral"',
    );
  }

  return {
    id: 'command',
    model: ai.model || template.split(/\s+/)[0]!,
    local: true,
    async generate(req) {
      const usesPrompt = template.includes('{prompt}');
      const filled = template
        .replaceAll('{system}', shellQuote(req.system ?? ''))
        .replaceAll('{prompt}', shellQuote(req.prompt))
        .replaceAll('{model}', shellQuote(ai.model));

      const input = usesPrompt ? undefined : [req.system, req.prompt].filter(Boolean).join('\n\n');
      const { code, stdout, stderr } = await run(filled, [], {
        shell: true,
        ...(input !== undefined ? { input } : {}),
        timeoutMs: 180_000,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      if (code !== 0) throw new PprError('EAI', stderr.trim() || `Command exited with ${code}`);
      return stdout.trim();
    },
  };
}

/** Single-quote for POSIX shells; the template itself is user-authored config. */
export const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
