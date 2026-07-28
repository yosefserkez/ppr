import { emitKeypressEvents } from 'node:readline';
import { detachLineInput } from '../input.js';
import { normalizeKey, type Key, type NodeReadlineKey } from './key.js';

/**
 * Raw keyboard input, and the promise that it is always given back.
 *
 * Shared by every interactive surface — the full-screen browser and the inline
 * prompts — so raw mode, listener cleanup, and signal handling exist once. This
 * is the piece that, if duplicated, eventually leaves someone's terminal in raw
 * mode after a crash.
 */
export class Keyboard {
  private active = false;
  private handler: ((key: Key) => void) | undefined;
  private readonly stdin = process.stdin;

  private readonly onKeypress = (str: string | undefined, key: NodeReadlineKey | undefined) => {
    this.handler?.(normalizeKey(str, key));
  };

  private readonly onExit = () => this.stop();
  private readonly onSignal = () => {
    this.stop();
    process.exit(130);
  };

  /** Interactive input is only possible when both ends are a terminal. */
  static usable(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  get listening(): boolean {
    return this.active;
  }

  start(handler: (key: Key) => void): void {
    this.handler = handler;
    if (this.active) return;
    this.active = true;

    // Exactly one consumer may read stdin. Any line-based prompt hands it over.
    detachLineInput();
    emitKeypressEvents(this.stdin);
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on('keypress', this.onKeypress);

    process.once('exit', this.onExit);
    process.once('SIGINT', this.onSignal);
    process.once('SIGTERM', this.onSignal);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;

    this.stdin.off('keypress', this.onKeypress);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();

    process.off('exit', this.onExit);
    process.off('SIGINT', this.onSignal);
    process.off('SIGTERM', this.onSignal);
  }
}

export type { Key };
