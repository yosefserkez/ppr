import { PprError } from '@ppr/core';
import { color } from '../render.js';
import { promptLine } from '../input.js';
import { Keyboard } from './keyboard.js';
import { row, type Segment } from './text.js';
import {
  createSelectState,
  highlighted,
  reduceSelect,
  resolveAnswer,
  visibleChoices,
  type Choice,
  type SelectState,
} from './select-state.js';

const ESC = '\x1b[';
const CURSOR_HIDE = `${ESC}?25l`;
const CURSOR_SHOW = `${ESC}?25h`;
const CLEAR_LINE = `${ESC}K`;

/**
 * An inline picker: it draws below the cursor and collapses to a single line
 * when you are done, so your scrollback keeps a readable record of what you
 * chose. Full-screen ownership is for the browser; a prompt should not erase
 * the terminal you were reading a second ago.
 */

/** Pure: the frame for a given state. Exported so it can be tested directly. */
export function renderSelect<T>(state: SelectState<T>, title: string, width: number): string[] {
  const visible = visibleChoices(state);
  const current = highlighted(state);
  const labelWidth = Math.min(14, Math.max(...state.choices.map((c) => c.label.length)) + 1);

  const lines = [row([[title, color.bold]], width)];

  if (!visible.length) {
    lines.push(row([['  no match', color.yellow]], width));
  }
  for (const choice of visible) {
    const selected = choice === current;
    const number = state.choices.indexOf(choice) + 1;
    const segments: Segment[] = [
      [selected ? '❯ ' : '  ', color.cyan],
      [`${String(number).padStart(2)}  `, color.dim],
      [choice.label.padEnd(labelWidth), selected ? color.cyan : undefined],
      [choice.hint ?? '', color.dim],
    ];
    lines.push(row(segments, width));
  }

  lines.push(
    row(
      [
        ['› ', color.cyan],
        [state.query],
        ['▏', color.cyan],
        [
          state.query ? '' : '   type to filter, ↑↓ to move, ⏎ to choose',
          color.dim,
        ],
      ],
      width,
    ),
  );
  return lines;
}

/** Writes frames in place: move up over the previous one, redraw, erase leftovers. */
class InlineFrame {
  private height = 0;
  private readonly stdout = process.stdout;

  draw(lines: string[]): void {
    if (this.height) this.stdout.write(`${ESC}${this.height}A`);
    const body = lines.map((line) => `\r${line}${CLEAR_LINE}`).join('\n');
    this.stdout.write(`${body}\n`);

    // The list shrinks as a filter narrows it; blank out what it left behind.
    const leftover = Math.max(0, this.height - lines.length);
    if (leftover) {
      this.stdout.write(`\r${CLEAR_LINE}\n`.repeat(leftover));
      this.stdout.write(`${ESC}${leftover}A`);
    }
    this.height = lines.length;
  }

  /** Replaces the whole block with one summary line. */
  collapse(summary: string): void {
    if (this.height) this.stdout.write(`${ESC}${this.height}A`);
    this.stdout.write(`\r${summary}${CLEAR_LINE}\n`);
    const leftover = Math.max(0, this.height - 1);
    if (leftover) {
      this.stdout.write(`\r${CLEAR_LINE}\n`.repeat(leftover));
      this.stdout.write(`${ESC}${leftover}A`);
    }
    this.height = 0;
  }
}

export interface SelectOptions<T> {
  title: string;
  choices: Array<Choice<T>>;
  /** Index highlighted when the prompt opens. */
  initial?: number;
}

/**
 * Asks the user to pick one. Keyboard-driven on a terminal, a typed answer
 * anywhere else — so `printf 'ollama\n' | ppr ai setup` keeps working and a
 * script never hangs on a prompt it cannot see.
 */
export async function select<T>(opts: SelectOptions<T>): Promise<Choice<T>> {
  if (!opts.choices.length) throw new PprError('EINVALID', 'Nothing to choose from');
  return Keyboard.usable() ? interactive(opts) : typed(opts);
}

function interactive<T>(opts: SelectOptions<T>): Promise<Choice<T>> {
  return new Promise((resolve, reject) => {
    let state = createSelectState(opts.choices, opts.initial ?? 0);
    const frame = new InlineFrame();
    const keyboard = new Keyboard();
    const width = Math.max(40, Math.min(process.stdout.columns || 80, 100));

    const paint = () => frame.draw(renderSelect(state, opts.title, width));

    const finish = (fn: () => void) => {
      keyboard.stop();
      process.stdout.write(CURSOR_SHOW);
      fn();
    };

    process.stdout.write(CURSOR_HIDE);
    keyboard.start((key) => {
      state = reduceSelect(state, key);
      if (!state.done) return paint();

      if (state.cancelled) {
        frame.collapse(color.dim(`${opts.title}  cancelled`));
        finish(() => reject(new PprError('EINVALID', 'Cancelled')));
        return;
      }
      const picked = state.picked!;
      frame.collapse(
        row(
          [
            [`${opts.title}  `, color.dim],
            [picked.label, color.green],
          ],
          width,
        ).trimEnd(),
      );
      finish(() => resolve(picked));
    });
    paint();
  });
}

/** The no-terminal path: print the list once, read one line, resolve it. */
async function typed<T>(opts: SelectOptions<T>): Promise<Choice<T>> {
  const width = 80;
  process.stderr.write(`${opts.title}\n`);
  for (const [i, choice] of opts.choices.entries()) {
    process.stderr.write(
      `${row([[`  ${i + 1}. ${choice.label}`], ['  ', undefined], [choice.hint ?? '', color.dim]], width).trimEnd()}\n`,
    );
  }
  const answer = await promptLine('Number or name: ');
  const picked = resolveAnswer(opts.choices, answer);
  if (!picked) {
    throw new PprError('EINVALID', `Not one of the options: ${answer || '(nothing)'}`);
  }
  return picked;
}

export type { Choice };
