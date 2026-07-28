import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PprError } from '../errors.js';
import { run, which } from './exec.js';

/**
 * Compiles a small Swift helper on first use and caches the binary.
 *
 * Some macOS capabilities have no CLI: on-device Foundation Models, and the
 * microphone permission API. Rather than ship a prebuilt binary nobody can
 * audit, ppr writes the source, compiles it once, and reuses it — the source is
 * right there in the repo next to the code that calls it.
 */
export const cacheDir = (): string =>
  join(process.env.XDG_CACHE_HOME || join(process.env.HOME || homedir(), '.cache'), 'ppr');

export interface SwiftHelper {
  /** Binary name, also the source filename stem. */
  name: string;
  source: string;
  /** Extra swiftc arguments, e.g. framework links. */
  args?: string[];
  /** Shown when compilation fails, to say what will not work. */
  purpose: string;
}

export async function ensureSwiftHelper(helper: SwiftHelper): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new PprError('EEXTERNAL', `${helper.purpose} only works on macOS`);
  }

  const dir = cacheDir();
  const sourcePath = join(dir, `${helper.name}.swift`);
  const binaryPath = join(dir, helper.name);

  await mkdir(dir, { recursive: true });
  await writeFile(sourcePath, helper.source);

  // Rebuild only when the source is newer than the binary.
  const [binary, source] = await Promise.all([
    stat(binaryPath).catch(() => null),
    stat(sourcePath).catch(() => null),
  ]);
  if (binary && source && binary.mtimeMs >= source.mtimeMs) return binaryPath;

  if (!(await which('swiftc'))) {
    throw new PprError(
      'EEXTERNAL',
      `swiftc not found, so ${helper.purpose} is unavailable`,
      'Install the Xcode command line tools: xcode-select --install',
    );
  }

  const { code, stderr } = await run(
    'swiftc',
    ['-O', '-o', binaryPath, sourcePath, ...(helper.args ?? [])],
    { timeoutMs: 180_000 },
  );
  if (code !== 0) {
    throw new PprError(
      'EEXTERNAL',
      `Could not build the helper for ${helper.purpose}:\n${stderr.trim().slice(0, 600)}`,
    );
  }
  return binaryPath;
}
