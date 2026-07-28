import type { FileStat, Storage } from '../ports.js';

/**
 * An in-memory vault. Used by the test suite, and by any host that wants to
 * run ppr against something that is not a filesystem (a sync service, OPFS,
 * an encrypted blob). Its existence is what proves the port is honest.
 */
export class MemoryStorage implements Storage {
  private files = new Map<string, { data: string; mtime: number }>();
  private tick = 0;

  constructor(seed: Record<string, string> = {}) {
    for (const [path, data] of Object.entries(seed)) this.files.set(path, { data, mtime: ++this.tick });
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path)?.data ?? null;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, { data, mtime: ++this.tick });
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(prefix: string): Promise<FileStat[]> {
    const scope = prefix.replace(/\/$/, '');
    const out: FileStat[] = [];
    for (const [path, file] of this.files) {
      if (path === scope || path.startsWith(`${scope}/`)) {
        out.push({ path, size: file.data.length, mtime: file.mtime });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async stat(path: string): Promise<FileStat | null> {
    const file = this.files.get(path);
    return file ? { path, size: file.data.length, mtime: file.mtime } : null;
  }

  async move(from: string, to: string): Promise<void> {
    const file = this.files.get(from);
    if (!file) return;
    this.files.set(to, file);
    this.files.delete(from);
  }

  /** Test helper: everything currently stored. */
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.files].map(([p, f]) => [p, f.data]));
  }
}
