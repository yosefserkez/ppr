/**
 * @ppr/core — the portable half of ppr.
 *
 * Nothing here imports a platform API. A CLI, a mobile app, a web client, or a
 * sync daemon all drive the same `Vault` by supplying ports.
 */

export * from './types.js';
export * from './ports.js';
export * from './errors.js';
export * from './config.js';
export * from './entry.js';
export * from './events.js';
export * from './markdown.js';
export * from './search.js';
export * from './links.js';
export * from './memory.js';
export * from './remind.js';
export * from './navigate.js';
export * from './models.js';
export * from './capture.js';
export { Catalog } from './catalog.js';
export { Vault, type VaultOptions, type LearnOptions, type LearnResult, type Upcoming, type VaultContext } from './vault.js';

export { MemoryStorage } from './adapters/memory-storage.js';

export * as tasks from './ai/tasks.js';
export {
  createProvider,
  registerProvider,
  registeredProviders,
  type ProviderFactory,
  type SecretSource,
} from './ai/providers.js';
export { heuristicBrief, heuristicDistill, heuristicRecap } from './ai/fallback.js';
export { parseJsonLoose } from './ai/json.js';

export * from './util/text.js';
export * from './util/time.js';
export { createId, isId, shortId, timeFromId } from './util/id.js';

export const VERSION = '0.1.0';
