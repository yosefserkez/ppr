import type { Key } from './key.js';

/**
 * Picking one thing from a list, as a pure state machine.
 *
 * The design question this answers: typing a name and arrowing to an option are
 * not two modes, they are two ways of moving the same highlight. So typing
 * narrows the list, arrows move within it, and Enter always takes whatever is
 * highlighted. A bare number jumps straight to that option, because the numbers
 * are on screen and typing `3` should mean what it looks like it means.
 */

export interface Choice<T = string> {
  value: T;
  label: string;
  /** Shown dimmed beside the label. Also searched when filtering. */
  hint?: string;
}

export interface SelectState<T = string> {
  choices: Array<Choice<T>>;
  /** What the user has typed. Filters, unless it is a bare index. */
  query: string;
  /** Index into `visible`. */
  cursor: number;
  done: boolean;
  /** Set when the user commits; undefined when they cancel. */
  picked?: Choice<T>;
  cancelled: boolean;
}

export function createSelectState<T>(choices: Array<Choice<T>>, initial = 0): SelectState<T> {
  return {
    choices,
    query: '',
    cursor: Math.max(0, Math.min(initial, choices.length - 1)),
    done: false,
    cancelled: false,
  };
}

/** True when the query is a 1-based index into the full list. */
function indexQuery<T>(state: SelectState<T>): number | null {
  if (!/^\d+$/.test(state.query)) return null;
  const n = Number(state.query);
  return n >= 1 && n <= state.choices.length ? n - 1 : null;
}

/**
 * What is on screen right now.
 *
 * A numeric query keeps the whole list visible and just moves the highlight —
 * hiding the other options would break the "see what you are about to pick"
 * affordance that made the numbered list good in the first place.
 */
export function visibleChoices<T>(state: SelectState<T>): Array<Choice<T>> {
  if (!state.query || indexQuery(state) !== null) return state.choices;
  const needle = state.query.toLowerCase();
  return state.choices.filter((choice) =>
    `${choice.label} ${choice.hint ?? ''}`.toLowerCase().includes(needle),
  );
}

export function highlighted<T>(state: SelectState<T>): Choice<T> | undefined {
  return visibleChoices(state)[state.cursor];
}

const clamp = (n: number, max: number): number => Math.max(0, Math.min(n, Math.max(0, max)));

function move<T>(state: SelectState<T>, delta: number): SelectState<T> {
  const visible = visibleChoices(state);
  if (!visible.length) return state;
  // Wraps, because a short list with no wrap feels broken at the ends.
  const next = (state.cursor + delta + visible.length) % visible.length;
  return { ...state, cursor: next };
}

function retype<T>(state: SelectState<T>, query: string): SelectState<T> {
  const next: SelectState<T> = { ...state, query };
  const jump = indexQuery(next);
  if (jump !== null) return { ...next, cursor: jump };
  return { ...next, cursor: clamp(0, visibleChoices(next).length - 1) };
}

export function reduceSelect<T>(state: SelectState<T>, key: Key): SelectState<T> {
  if (state.done) return state;

  switch (true) {
    case key.name === 'down' || (key.ctrl && key.name === 'n') || key.name === 'tab':
      return move(state, 1);
    case key.name === 'up' || (key.ctrl && key.name === 'p') || (key.shift && key.name === 'tab'):
      return move(state, -1);

    case key.name === 'return': {
      const choice = highlighted(state);
      return choice ? { ...state, done: true, picked: choice } : state;
    }
    case key.name === 'escape' || (key.ctrl && key.name === 'c'):
      return { ...state, done: true, cancelled: true };

    case key.name === 'backspace':
      return retype(state, state.query.slice(0, -1));
    case key.ctrl && key.name === 'u':
      return retype(state, '');

    // Everything printable is text. No single-letter shortcuts here: `q` has to
    // be able to filter to "qwen" rather than quitting.
    case Boolean(key.char) && key.char!.length === 1 && !key.ctrl && !key.meta:
      return retype(state, state.query + key.char);

    default:
      return state;
  }
}

/**
 * Resolves a typed answer without a terminal — the non-interactive path.
 * Accepts a 1-based number, an exact label, or an unambiguous prefix.
 */
export function resolveAnswer<T>(choices: Array<Choice<T>>, answer: string): Choice<T> | undefined {
  const text = answer.trim().toLowerCase();
  if (!text) return undefined;

  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n >= 1 && n <= choices.length ? choices[n - 1] : undefined;
  }
  const exact = choices.find((c) => c.label.toLowerCase() === text);
  if (exact) return exact;

  const prefixed = choices.filter((c) => c.label.toLowerCase().startsWith(text));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}
