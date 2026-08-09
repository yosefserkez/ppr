/**
 * @ppr/core/node — the Node-flavoured half: filesystem, subprocesses, and the
 * providers that need them. A mobile or web host imports `@ppr/core` only and
 * brings its own equivalents.
 */

import { Vault } from './vault.js';
import { NodeStorage } from './adapters/node-storage.js';
import { createProvider, registerProvider } from './ai/providers.js';
import { appleProvider } from './node/apple.js';
import { commandProvider } from './node/command-provider.js';
import { createTranscriber } from './node/transcribe.js';
import { findVault, loadConfig, loadSecrets } from './node/paths.js';
import { noVault } from './errors.js';
import type { AIProvider } from './ports.js';
import type { Config } from './config.js';
import type { SecretSource } from './ai/providers.js';

registerProvider('apple', (ai) => appleProvider(ai));
registerProvider('command', (ai) => commandProvider(ai));

export { NodeStorage } from './adapters/node-storage.js';
export * from './node/paths.js';
export { run, which } from './node/exec.js';
export { appleProvider, ensureAppleShim } from './node/apple.js';
export { commandProvider } from './node/command-provider.js';
export { createTranscriber, record, type Recording } from './node/transcribe.js';
export { downloadFile, formatBytes, modelsDir, type DownloadProgress } from './node/download.js';
export { analyzeWav, type AudioLevel } from './node/audio.js';
export {
  applescriptString,
  notify,
  notifyScript,
  osascriptHint,
  pushReminder,
  reminderScript,
  type BridgeResult,
  type ReminderPush,
} from './node/macos.js';
export { ensureSwiftHelper, type SwiftHelper } from './node/swift.js';
export {
  DEFAULT_DEVICE,
  listInputDevices,
  parseDeviceList,
  micPermission,
  micPermissionError,
  openMicSettings,
  requestMicPermission,
  responsibleApp,
  type AudioDevice,
  type MicPermission,
} from './node/microphone.js';

/**
 * Defers construction until the first generate call, so a missing API key is
 * an error when you ask for AI — not when you run `ppr ls`.
 */
function lazyProvider(config: Config, secrets: SecretSource): AIProvider | undefined {
  if (config.ai.provider === 'none') return undefined;
  let real: AIProvider | undefined;
  return {
    id: config.ai.provider,
    model: config.ai.model,
    local: config.ai.provider === 'ollama' || config.ai.provider === 'apple' || config.ai.provider === 'command',
    async generate(req) {
      real ??= createProvider(config.ai, secrets);
      if (!real) throw new Error('Provider unavailable');
      return real.generate(req);
    },
  };
}

export interface OpenVaultOptions {
  cwd?: string;
  /** Explicit vault directory; otherwise discovered from cwd, $PPR_DIR, or ~/ppr. */
  vault?: string;
  env?: Record<string, string | undefined>;
  /** Force the offline path even when a provider is configured. */
  noAI?: boolean;
  /** Throw if the vault has not been initialised yet. Default true. */
  requireVault?: boolean;
}

/** One call to go from a shell invocation to a working `Vault`. */
export async function openVault(opts: OpenVaultOptions = {}): Promise<Vault> {
  const env = opts.env ?? process.env;
  const found = findVault({
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.vault ? { explicit: opts.vault } : {}),
    env,
  });
  if (!found.exists && opts.requireVault !== false) throw noVault(found.root);

  const config = await loadConfig(found.root, env);
  const secrets = await loadSecrets(env);
  // `--no-ai` turns off *generation* — distilling, recaps, answers. Not
  // transcription: that is how the words get in at all, and switching it off
  // would make `ppr --no-ai voice` mean nothing. `ppr voice --raw` is how you
  // say "transcribe it but leave my words alone".
  const offline = opts.noAI || env.PPR_NO_AI === '1';
  const provider = offline ? undefined : lazyProvider(config, secrets);
  const transcriber = createTranscriber(config.transcribe, secrets);

  return Vault.open({
    root: found.root,
    storage: new NodeStorage(found.root),
    config,
    provider,
    transcriber,
  });
}

export { Vault };
