import { emitKeypressEvents } from 'node:readline';
import type { Key } from './state.js';

/**
 * Terminal ownership, in one place.
 *
 * The single hard rule: whatever happens — a crash, a signal, an editor that
 * exits badly — the terminal is handed back exactly as it was found. Every
 * escape sequence written here has a matching undo in `close()`, and `close()`
 * is wired to every way this process can end.
 */

const ESC = '\x1b[';
const ALT_SCREEN_ON = `${ESC}?1049h`;
const ALT_SCREEN_OFF = `${ESC}?1049l`;
const CURSOR_HIDE = `${ESC}?25l`;
const CURSOR_SHOW = `${ESC}?25h`;
const CURSOR_HOME = `${ESC}H`;
const CLEAR_BELOW = `${ESC}J`;
const CLEAR_LINE_END = `${ESC}K`;

export interface Size {
  columns: number;
  rows: number;
}

export class Screen {
  private open = false;
  private onKey: ((key: Key) => void) | undefined;
  private onResize: (() => void) | undefined;
  private readonly stdin = process.stdin;
  private readonly stdout = process.stdout;

  private readonly handleKeypress = (str: string | undefined, key: NodeReadlineKey | undefined) => {
    if (!this.onKey) return;
    this.onKey(normalizeKey(str, key));
  };

  private readonly handleResize = () => this.onResize?.();
  private readonly handleExit = () => this.close();
  private readonly handleSignal = () => {
    this.close();
    process.exit(130);
  };

  get size(): Size {
    return {
      columns: Math.max(40, this.stdout.columns || 80),
      rows: Math.max(8, this.stdout.rows || 24),
    };
  }

  static usable(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  start(handlers: { onKey: (key: Key) => void; onResize: () => void }): void {
    this.onKey = handlers.onKey;
    this.onResize = handlers.onResize;
    this.enter();
  }

  private enter(): void {
    if (this.open) return;
    this.open = true;

    emitKeypressEvents(this.stdin);
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on('keypress', this.handleKeypress);
    this.stdout.on('resize', this.handleResize);

    // Every path out of the process restores the terminal.
    process.once('exit', this.handleExit);
    process.once('SIGINT', this.handleSignal);
    process.once('SIGTERM', this.handleSignal);

    this.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);
  }

  /** Renders a whole frame in one write, so there is no visible tearing. */
  draw(lines: string[]): void {
    if (!this.open) return;
    const { rows } = this.size;
    const frame = lines
      .slice(0, rows)
      .map((line) => line + CLEAR_LINE_END)
      .join('\r\n');
    this.stdout.write(CURSOR_HOME + frame + CLEAR_BELOW);
  }

  /**
   * Hands the terminal back for the duration of `fn` — for $EDITOR, or a
   * subprocess that wants the screen — then takes it back.
   */
  async suspend<T>(fn: () => Promise<T>): Promise<T> {
    const wasOpen = this.open;
    if (wasOpen) this.leave();
    try {
      return await fn();
    } finally {
      if (wasOpen) this.enter();
    }
  }

  private leave(): void {
    if (!this.open) return;
    this.open = false;
    this.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF);
    this.stdin.off('keypress', this.handleKeypress);
    this.stdout.off('resize', this.handleResize);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
  }

  close(): void {
    this.leave();
    process.off('exit', this.handleExit);
    process.off('SIGINT', this.handleSignal);
    process.off('SIGTERM', this.handleSignal);
  }
}

interface NodeReadlineKey {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  sequence?: string;
}

/**
 * Node's keypress events, narrowed to what the state machine understands.
 * Keeping this translation here means the reducer never sees a Node type.
 */
export function normalizeKey(str: string | undefined, key: NodeReadlineKey | undefined): Key {
  const name = key?.name ?? '';
  const sequence = key?.sequence ?? str ?? '';
  const printable = str && str.length === 1 && str >= ' ' && str !== '' ? str : undefined;

  const out: Key = { name: name || printable || sequence };
  if (key?.ctrl) out.ctrl = true;
  if (key?.shift) out.shift = true;
  if (key?.meta) out.meta = true;
  if (printable) out.char = printable;

  // readline reports uppercase letters as shift+lowercase; the reducer wants the
  // literal key for `G`, and a plain lowercase name everywhere else.
  if (printable && /[A-Z]/.test(printable)) {
    out.name = printable.toLowerCase();
    out.shift = true;
  }
  return out;
}
