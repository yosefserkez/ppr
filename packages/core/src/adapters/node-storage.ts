import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { FileStat, Storage } from '../ports.js';
import { PprError } from '../errors.js';

const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'));

/**
 * Filesystem-backed vault storage.
 *
 * Writes are atomic (temp file + rename) so an interrupted `ppr` — a killed
 * terminal, a full disk — can never leave a half-written note behind.
 */
export class NodeStorage implements Storage {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private abs(path: string): string {
    const full = resolve(this.root, path);
    const rel = relative(this.root, full);
    if (rel.startsWith('..') || resolve(full) === resolve(this.root, '..')) {
      throw new PprError('EINVALID', `Path escapes the vault: ${path}`);
    }
    return full;
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.abs(path), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(path: string, data: string): Promise<void> {
    const full = this.abs(path);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.tmp`;
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, full);
  }

  async remove(path: string): Promise<void> {
    await rm(this.abs(path), { force: true });
  }

  async move(from: string, to: string): Promise<void> {
    const target = this.abs(to);
    await mkdir(dirname(target), { recursive: true });
    await rename(this.abs(from), target);
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await stat(this.abs(path));
      return { path, size: s.size, mtime: Math.floor(s.mtimeMs) };
    } catch {
      return null;
    }
  }

  async list(prefix: string): Promise<FileStat[]> {
    const base = this.abs(prefix);
    const out: FileStat[] = [];
    await this.walk(base, out);
    return out;
  }

  private async walk(dir: string, out: FileStat[]): Promise<void> {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing directory is an empty listing, not an error
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        await this.walk(full, out);
      } else if (item.isFile()) {
        const s = await stat(full).catch(() => null);
        if (s) out.push({ path: toPosix(relative(this.root, full)), size: s.size, mtime: Math.floor(s.mtimeMs) });
      }
    }
  }
}
