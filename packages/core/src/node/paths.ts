import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_CONFIG,
  VAULT_FORBIDDEN_PATHS,
  VAULT_FORBIDDEN_PROVIDERS,
  isShellProvider,
  mergeConfig,
  validateConfig,
  type Config,
} from '../config.js';

export const VAULT_MARKER = '.ppr';
export const VAULT_CONFIG = `${VAULT_MARKER}/config.json`;

type Env = Record<string, string | undefined>;

const xdgConfigHome = (env: Env): string =>
  env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');

export const globalConfigPath = (env: Env = process.env): string =>
  join(xdgConfigHome(env), 'ppr', 'config.json');

export const credentialsPath = (env: Env = process.env): string =>
  join(xdgConfigHome(env), 'ppr', 'credentials.json');

export const defaultVaultDir = (env: Env = process.env): string =>
  env.PPR_DIR ? resolve(env.PPR_DIR) : join(env.HOME || homedir(), 'ppr');

/**
 * Finds the vault the user means: an explicit `--vault`/`$PPR_DIR`, else the
 * nearest `.ppr` walking up from the cwd (so a project can carry its own
 * journal), else the default at `~/ppr`.
 */
export function findVault(
  opts: { cwd?: string; explicit?: string; env?: Env } = {},
): { root: string; exists: boolean } {
  const env = opts.env ?? process.env;
  if (opts.explicit) {
    const root = resolve(opts.explicit);
    return { root, exists: existsSync(join(root, VAULT_MARKER)) };
  }
  if (env.PPR_DIR) {
    const root = resolve(env.PPR_DIR);
    return { root, exists: existsSync(join(root, VAULT_MARKER)) };
  }

  let dir = resolve(opts.cwd ?? process.cwd());
  while (true) {
    if (existsSync(join(dir, VAULT_MARKER))) return { root: dir, exists: true };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fallback = defaultVaultDir(env);
  return { root: fallback, exists: existsSync(join(fallback, VAULT_MARKER)) };
}

const GITIGNORE = `# ppr keeps a disposable parse cache here
.ppr/cache/
`;

const README = (root: string) => `# ppr vault

Plain markdown, one file per entry, under \`entries/YYYY/MM/\`.
Standing facts — what is true, rather than what happened — get a file each in
\`memory/\`. That store is a projection of the journal, so deleting it costs
nothing: \`ppr memory learn --all\` builds it again.
Nothing here needs ppr to be readable — that is the point.

- \`ppr\` — write an entry
- \`ppr ls\` — recent entries
- \`ppr search <query>\` — find something
- \`ppr memory ls\` — what ppr knows
- \`ppr --help\` — everything else

Vault: \`${root}\`
Config: \`.ppr/config.json\` (this vault) and \`~/.config/ppr/config.json\` (all vaults).

This directory is a good thing to put in git.
`;

export async function initVault(root: string): Promise<{ root: string; created: boolean }> {
  const marker = join(root, VAULT_MARKER);
  if (existsSync(marker)) return { root, created: false };

  await mkdir(join(root, 'entries'), { recursive: true });
  await mkdir(marker, { recursive: true });
  await writeFile(join(marker, 'config.json'), '{}\n');
  if (!existsSync(join(root, '.gitignore'))) await writeFile(join(root, '.gitignore'), GITIGNORE);
  if (!existsSync(join(root, 'README.md'))) await writeFile(join(root, 'README.md'), README(root));
  return { root, created: true };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Walks to the object holding a dotted key's leaf, or `undefined` when nothing
 * on the way is a plain object — a layer that spells `ai` as a string or an
 * array has no such key to read or remove, and `validateConfig` rejects what it
 * does have.
 */
function parentOf(
  layer: Record<string, unknown>,
  path: string,
): { node: Record<string, unknown>; leaf: string } | undefined {
  const keys = path.split('.');
  const leaf = keys.pop();
  if (!leaf) return undefined;
  let node = layer;
  for (const key of keys) {
    const next = asObject(node[key]);
    if (!next) return undefined;
    node = next;
  }
  return { node, leaf };
}

/** Removes one dotted key from a raw layer, leaving its parents in place. */
function deletePath(layer: Record<string, unknown>, path: string): void {
  const found = parentOf(layer, path);
  if (found) delete found.node[found.leaf];
}

/**
 * Everything the vault layer is not allowed to say, dropped before the merge.
 *
 * See `VAULT_FORBIDDEN_PATHS`. The layer is a fresh object per load, so this
 * edits it in place; the global layer goes through untouched, because on your
 * own machine these keys are exactly how you configure ppr.
 */
function fenceVaultLayer(local: Record<string, unknown>): Record<string, unknown> {
  for (const path of VAULT_FORBIDDEN_PATHS) deletePath(local, path);
  // Stripping `ai.command` is not enough on its own: a vault that could still
  // *switch* to a provider that shells out would run whatever the machine's own
  // command or binary happens to be. Whatever provider was already chosen stays.
  for (const path of Object.keys(VAULT_FORBIDDEN_PROVIDERS)) {
    const found = parentOf(local, path);
    if (found && isShellProvider(path, found.node[found.leaf])) delete found.node[found.leaf];
  }
  return local;
}

/**
 * Defaults < global config < vault config. Later wins, key by key — except for
 * the keys that name a program or an endpoint, which the vault layer does not
 * get to set at all (`fenceVaultLayer`).
 */
export async function loadConfig(root: string, env: Env = process.env): Promise<Config> {
  const [global, local] = await Promise.all([
    readJson(globalConfigPath(env)),
    readJson(join(root, VAULT_CONFIG)),
  ]);
  return validateConfig(mergeConfig(structuredClone(DEFAULT_CONFIG), global, fenceVaultLayer(local)));
}

/** Reads back only what that file declares, so saving does not inline defaults. */
export async function readConfigLayer(path: string): Promise<Record<string, unknown>> {
  return readJson(path);
}

export async function writeConfigLayer(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Secrets resolve from the environment first, then from a 0600 credentials
 * file. Keys never touch the vault, which is likely to be in git.
 */
export async function loadSecrets(env: Env = process.env): Promise<(name: string) => string | undefined> {
  const stored = await readJson(credentialsPath(env));
  return (name: string) => env[name] || (typeof stored[name] === 'string' ? (stored[name] as string) : undefined);
}

export async function saveSecret(name: string, value: string, env: Env = process.env): Promise<string> {
  const path = credentialsPath(env);
  const current = await readJson(path);
  current[name] = value;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return path;
}
