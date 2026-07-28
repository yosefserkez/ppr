import { Keyboard } from './keyboard.js';
import type { Key } from './key.js';

/**
 * A full-screen view's ownership of the terminal.
 *
 * Raw input lives in `Keyboard`; this adds the alternate screen and whole-frame
 * drawing on top. The hard rule is unchanged: whatever happens — a crash, a
 * signal, an editor that exits badly — the terminal is handed back exactly as it
 * was found. Every sequence written here has a matching undo in `close()`.
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
  private readonly keyboard = new Keyboard();
  private readonly stdout = process.stdout;

  private readonly handleResize = () => this.onResize?.();
  private readonly handleExit = () => this.close();

  get size(): Size {
    return {
      columns: Math.max(40, this.stdout.columns || 80),
      rows: Math.max(8, this.stdout.rows || 24),
    };
  }

  static usable(): boolean {
    return Keyboard.usable();
  }

  start(handlers: { onKey: (key: Key) => void; onResize: () => void }): void {
    this.onKey = handlers.onKey;
    this.onResize = handlers.onResize;
    this.enter();
  }

  private enter(): void {
    if (this.open) return;
    this.open = true;

    this.keyboard.start((key) => this.onKey?.(key));
    this.stdout.on('resize', this.handleResize);
    process.once('exit', this.handleExit);

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
   * Hands the terminal back for the duration of `fn` — for $EDITOR, or any
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
    this.keyboard.stop();
    this.stdout.off('resize', this.handleResize);
  }

  close(): void {
    this.leave();
    process.off('exit', this.handleExit);
  }
}

export type { Key };
