import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  getPath,
  mergeConfig,
  setPath,
  validateConfig,
  type Config,
} from '@ppr/core';
import {
  VAULT_CONFIG,
  globalConfigPath,
  loadConfig,
  readConfigLayer,
  writeConfigLayer,
} from '@ppr/core/node';

/**
 * Writing one setting, in one place.
 *
 * `ppr config set`, `ppr ai setup`, and every guided repair all go through
 * here, so validation, type coercion, and "persist only the delta" behave
 * identically no matter which surface the user came from.
 */
export async function writeSetting(
  root: string,
  key: string,
  value: string,
  opts: { local?: boolean } = {},
): Promise<{ file: string; value: unknown }> {
  // Validate against the effective config so a bad value is caught before any write.
  const effective = await loadConfig(root);
  setPath(effective, key, value);

  const file = opts.local ? join(root, VAULT_CONFIG) : globalConfigPath();
  const layer = await readConfigLayer(file);
  const merged = setPath(
    validateConfig(mergeConfig(structuredClone(DEFAULT_CONFIG), layer)),
    key,
    value,
  );

  await writeConfigLayer(file, applyDelta(layer, key, getPath(merged, key)));
  return { file, value: getPath(merged, key) };
}

/** Keeps written config files to the keys the user actually changed. */
function applyDelta(
  layer: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const out = structuredClone(layer);
  const keys = key.split('.');
  const leaf = keys.pop()!;
  let node = out;
  for (const part of keys) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[leaf] = value;
  return out;
}

export type { Config };
