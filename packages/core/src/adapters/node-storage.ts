import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { FileStat, Storage } from '../ports.js';
import { PprError } from '../errors.js';

const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'));

/**
 * How many filesystem calls a single walk may have in flight.
 *
 * Awaiting one `stat` at a time spends a listing of a real vault waiting on
 * the disk; letting them all go at once runs the process out of file
 * descriptors on a vault big enough for the speed to have mattered. The cap is
 * shared across the whole walk rather than applied per directory, because a
 * per-directory cap multiplies by depth and `entries/YYYY/MM/` is exactly the
 * shape that turns 64 into thousands.
 */
const WALK_CONCURRENCY = 64;

/**
 * Lets `limit` operations run at once; the rest queue.
 *
 * Only leaf calls (`readdir`, `stat`) are passed through it. A gated operation
 * that waited on another gated operation could deadlock with every slot held
 * by a waiter, and the recursion is the thing that would do it.
 */
class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(op: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active += 1;
    else {
      await new Promise<void>((release) => {
        this.waiting.push(release);
      });
    }
    try {
      return await op();
    } finally {
      // The slot is handed straight to the next waiter rather than freed and
      // re-taken, so a caller arriving in between cannot overshoot the limit.
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

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
    await this.walk(base, out, new Gate(WALK_CONCURRENCY));
    return out;
  }

  private async walk(dir: string, out: FileStat[], gate: Gate): Promise<void> {
    let items;
    try {
      items = await gate.run(() => readdir(dir, { withFileTypes: true }));
    } catch {
      return; // missing directory is an empty listing, not an error
    }
    // The work runs concurrently; the *listing* does not. Each child fills its
    // own slot and the slots are appended in directory order afterwards, so
    // two runs over an unchanged vault return the same array. That matters
    // because `Catalog.load` indexes by id and the last file wins when two
    // carry the same one — a copied note would otherwise pick a different
    // winner from run to run.
    const slots: FileStat[][] = [];
    const pending: Array<Promise<void>> = [];
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full = join(dir, item.name);
      if (!item.isDirectory() && !item.isFile()) continue;
      const slot: FileStat[] = [];
      slots.push(slot);
      pending.push(
        item.isDirectory()
          ? this.walk(full, slot, gate)
          : gate.run(() => stat(full)).then(
              (s) => {
                slot.push({ path: toPosix(relative(this.root, full)), size: s.size, mtime: Math.floor(s.mtimeMs) });
              },
              () => {}, // a file that vanished mid-walk is simply not in the listing
            ),
      );
    }
    await Promise.all(pending);
    // Appended one at a time, never `out.push(...slot)`: spreading an array
    // into arguments is bounded by the JS call stack, so a subtree of a few
    // hundred thousand files threw `RangeError: Maximum call stack size
    // exceeded` out of `list` and killed every command on a big vault. The
    // ceiling drops as the recursion deepens, which `entries/YYYY/MM/` does.
    for (const slot of slots) for (const f of slot) out.push(f);
  }
}
