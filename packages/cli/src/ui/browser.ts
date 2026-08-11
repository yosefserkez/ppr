import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { spawnEditorOn } from '../input.js';
import type { Entry, Vault } from '@ppr/core';
import { PprError, shortId } from '@ppr/core';
import { which } from '@ppr/core/node';
import { Screen } from './screen.js';
import { render } from './layout.js';
import {
  createState,
  currentView,
  focused,
  reduce,
  restack,
  type BrowserState,
  type Effect,
  type Key,
} from './state.js';

/**
 * The interactive shell: owns the loop, runs the effects the reducer asks for,
 * and keeps the state in sync with the vault after anything changes on disk.
 *
 * All the decisions live in `state.ts`; all the terminal handling lives in
 * `screen.ts`. This file is the wiring between them and the vault.
 */
export class Browser {
  private state: BrowserState;
  private readonly screen = new Screen();
  private busy = false;
  private pending: Key[] = [];

  constructor(
    private readonly vault: Vault,
    label: string,
    entries: Entry[],
  ) {
    this.state = createState(label, entries, 20);
  }

  async run(): Promise<Entry | undefined> {
    this.state = { ...this.state, pageSize: this.listHeight() };
    this.screen.start({
      onKey: (key) => void this.handle(key),
      onResize: () => {
        this.state = { ...this.state, pageSize: this.listHeight() };
        this.paint();
      },
    });
    this.paint();

    try {
      await new Promise<void>((resolve) => {
        this.finish = resolve;
      });
    } finally {
      this.screen.close();
    }
    // Handing the last focused entry back lets callers chain, e.g. print it.
    return focused(this.state);
  }

  private finish: (() => void) | undefined;

  private listHeight(): number {
    const { rows, columns } = this.screen.size;
    const chrome = 4; // header (2) + footer (2)
    return Math.max(3, columns >= 96 ? rows - chrome : Math.ceil((rows - chrome) * 0.55));
  }

  /** Keys arriving while an effect is running are queued, never dropped. */
  private async handle(key: Key): Promise<void> {
    if (this.busy) {
      this.pending.push(key);
      return;
    }
    this.busy = true;
    try {
      const { state, effect } = reduce(this.state, key, (entry) => this.vault.lenses(entry));
      this.state = state;
      await this.apply(effect);
      if (this.state.done) {
        this.finish?.();
        return;
      }
      this.paint();
    } catch (error) {
      // Nobody awaits this promise, so an escaping rejection ends the process
      // with the alternate screen still up — the terminal is not handed back
      // (I5) and the failure is never seen. The footer is the only place that
      // can say so from in here: writing to stderr would land on the alt
      // screen (I10).
      this.status(error instanceof PprError ? error.message : 'could not do that');
      this.paint();
    } finally {
      this.busy = false;
      const next = this.pending.shift();
      if (next) void this.handle(next);
    }
  }

  private paint(): void {
    this.screen.draw(render(this.state, this.screen.size, this.vault.now()));
  }

  private status(message: string): void {
    this.state = { ...this.state, status: message };
  }

  private async apply(effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'edit':
        await this.edit(effect.entry);
        return;
      case 'delete': {
        await this.vault.remove(effect.entry.id);
        await this.reload();
        this.status(`deleted ${effect.entry.title}`);
        return;
      }
      case 'append': {
        const updated = await this.vault.append(effect.entry.id, effect.text);
        await this.reload();
        this.status(`appended to ${shortId(updated.id)}`);
        return;
      }
      case 'create': {
        const created = await this.vault.add({
          body: effect.text,
          kind: this.vault.config.capture.defaultKind,
        });
        await this.reload();
        this.focusOn(created.id);
        this.status(`created ${shortId(created.id)}`);
        return;
      }
      case 'yank':
        await this.yank(join(this.vault.root, effect.entry.path));
        return;
      case 'reload':
        await this.reload();
        this.status('reloaded');
        return;
      case 'quit':
        this.finish?.();
        return;
      default:
    }
  }

  /**
   * Opens the entry's actual file — not a copy.
   *
   * The product promise is that these are just markdown files; editing a temp
   * buffer and patching it back would quietly discard frontmatter changes and
   * make the tags you can see un-editable.
   */
  private async edit(entry: Entry): Promise<void> {
    const file = join(this.vault.root, entry.path);
    const failed = await this.screen.suspend(() => spawnEditorOn(file).then(() => false, () => true));

    if (failed) {
      this.status('could not launch the editor — check $EDITOR');
      return;
    }
    await this.reload();
    this.status(`saved ${shortId(entry.id)}`);
  }

  /** Re-reads the vault and keeps every view on the stack pointing at live data. */
  private async reload(): Promise<void> {
    await this.vault.refresh();
    const byId = new Map(this.vault.all().map((e) => [e.id, e] as const));
    this.state = restack(this.state, byId, this.rootEntries());
  }

  /** The root view always reflects the whole vault ordering after a change. */
  private rootEntries(): Entry[] {
    const root = this.state.stack[0]!;
    const ids = new Set(root.entries.map((e) => e.id));
    const live = this.vault.all();
    // A root that was a full listing grows with new entries; a filtered root
    // (a search, say) keeps its shape and only drops what no longer exists.
    return root.entries.length === 0 || ids.size === live.length - 1 || ids.size === live.length
      ? live
      : live.filter((e) => ids.has(e.id));
  }

  private focusOn(id: string): void {
    const view = currentView(this.state);
    const index = view.entries.findIndex((e) => e.id === id);
    if (index < 0) return;
    this.state = {
      ...this.state,
      stack: [...this.state.stack.slice(0, -1), { ...view, cursor: index, offset: Math.max(0, index - 2) }],
    };
  }

  private async yank(path: string): Promise<void> {
    const tool =
      process.platform === 'darwin'
        ? 'pbcopy'
        : (await which('wl-copy'))
          ? 'wl-copy'
          : (await which('xclip'))
            ? 'xclip'
            : null;
    if (!tool) {
      this.status(path);
      return;
    }
    await new Promise<void>((resolve) => {
      const child = spawn(tool, tool === 'xclip' ? ['-selection', 'clipboard'] : [], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
      child.stdin.end(path);
    });
    this.status('path copied');
  }
}

/** True when an interactive view makes sense for this invocation. */
export function canBrowse(opts: { json?: boolean; quiet?: boolean; plain?: boolean }, enabled: boolean): boolean {
  return enabled && !opts.json && !opts.quiet && !opts.plain && Screen.usable();
}

export async function browse(vault: Vault, label: string, entries: Entry[]): Promise<void> {
  await new Browser(vault, label, entries).run();
}
