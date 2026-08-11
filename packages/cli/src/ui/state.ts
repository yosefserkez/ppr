import type { Entry } from '@ppr/core';
import { searchEntries } from '@ppr/core';
import type { Key } from './key.js';

/**
 * The browser as a pure state machine.
 *
 * Nothing here touches the terminal, the vault, or the clock. Keys go in, a new
 * state comes out, and anything that needs the outside world comes back as an
 * `Effect` for the shell to run. That keeps the interesting logic — cursor
 * maths, the view stack, filtering — testable without a TTY.
 */

/** One level of the navigation stack: a named list with its own cursor. */
export interface View {
  /** Shown in the breadcrumb, e.g. `search: redis` or `Linked from`. */
  label: string;
  entries: Entry[];
  cursor: number;
  /** Scroll offset of the list pane. */
  offset: number;
  /** Live filter typed with `/`. */
  filter: string;
}

export type Mode =
  | { kind: 'list' }
  | { kind: 'filter' }
  | { kind: 'reader'; scroll: number }
  | { kind: 'dive'; options: Array<{ id: string; label: string; entries: Entry[] }>; cursor: number }
  | { kind: 'confirm'; prompt: string; action: Effect }
  | { kind: 'prompt'; prompt: string; value: string; action: 'append' | 'new' }
  | { kind: 'help' };

export interface BrowserState {
  stack: View[];
  mode: Mode;
  /** Transient message shown in the footer. */
  status: string;
  /** Rows available for the list pane; the shell sets this from the terminal size. */
  pageSize: number;
  done: boolean;
}

export type { Key };

/** Something the shell must do: touch the filesystem, spawn an editor, exit. */
export type Effect =
  | { type: 'none' }
  | { type: 'edit'; entry: Entry }
  | { type: 'delete'; entry: Entry }
  | { type: 'append'; entry: Entry; text: string }
  | { type: 'create'; text: string }
  | { type: 'yank'; entry: Entry }
  | { type: 'reload' }
  | { type: 'quit' };

const NONE: Effect = { type: 'none' };

export function createState(label: string, entries: Entry[], pageSize = 20): BrowserState {
  return {
    stack: [{ label, entries, cursor: 0, offset: 0, filter: '' }],
    mode: { kind: 'list' },
    status: '',
    pageSize,
    done: false,
  };
}

export const currentView = (state: BrowserState): View => state.stack[state.stack.length - 1]!;

/**
 * Memoised answers, keyed by the view object that asked.
 *
 * Ranking a list is not free and one frame asks four times — cursor maths, the
 * list pane, the header count — so the answer is cached rather than recomputed
 * per call. The cache re-checks `filter` *and* the entries array it was built
 * from, because a delete or a reload replaces the list while leaving the filter
 * alone: keying on the filter only would show the entry you just removed.
 */
const visibleCache = new WeakMap<View, { filter: string; entries: Entry[]; result: Entry[] }>();

/**
 * The entries actually on screen: the view's list, narrowed by its filter.
 *
 * The filter is the vault's own matcher, so what `/` shows and what
 * `ppr search` prints are one behaviour instead of two that drift — including
 * the order, which is by relevance rather than by position in the list. It asks
 * for the matcher's `filter` mode because a box being typed into has to narrow
 * with every character: search's recall-first rules made `/r` show nothing and
 * a second word show *more*.
 */
export function visibleEntries(view: View): Entry[] {
  const needle = view.filter.trim();
  if (!needle) return view.entries;

  const cached = visibleCache.get(view);
  if (cached && cached.filter === needle && cached.entries === view.entries) return cached.result;

  // `now` is left to default: the reducer is pure and has no clock, and the
  // recency tilt only ever nudges the order of an already-matching list.
  const result = searchEntries(view.entries, needle, { mode: 'filter' }).map((hit) => hit.entry);
  visibleCache.set(view, { filter: needle, entries: view.entries, result });
  return result;
}

export function focused(state: BrowserState): Entry | undefined {
  const view = currentView(state);
  return visibleEntries(view)[view.cursor];
}

/** Keeps the cursor in range and the window scrolled around it. */
function reposition(view: View, pageSize: number, next: number): View {
  const total = visibleEntries(view).length;
  const cursor = total === 0 ? 0 : Math.max(0, Math.min(next, total - 1));
  let offset = view.offset;
  if (cursor < offset) offset = cursor;
  if (cursor >= offset + pageSize) offset = cursor - pageSize + 1;
  offset = Math.max(0, Math.min(offset, Math.max(0, total - pageSize)));
  return { ...view, cursor, offset };
}

function replaceView(state: BrowserState, view: View): BrowserState {
  return { ...state, stack: [...state.stack.slice(0, -1), view] };
}

function move(state: BrowserState, delta: number): BrowserState {
  const view = currentView(state);
  return replaceView(state, reposition(view, state.pageSize, view.cursor + delta));
}

function jump(state: BrowserState, to: number): BrowserState {
  const view = currentView(state);
  return replaceView(state, reposition(view, state.pageSize, to));
}

/** Pushes a new list onto the stack — the "dive in" move. */
export function push(state: BrowserState, label: string, entries: Entry[]): BrowserState {
  return {
    ...state,
    stack: [...state.stack, { label, entries, cursor: 0, offset: 0, filter: '' }],
    mode: { kind: 'list' },
    status: '',
  };
}

function pop(state: BrowserState): BrowserState {
  if (state.stack.length === 1) return { ...state, status: '' };
  return { ...state, stack: state.stack.slice(0, -1), mode: { kind: 'list' }, status: '' };
}

export interface Step {
  state: BrowserState;
  effect: Effect;
}

const step = (state: BrowserState, effect: Effect = NONE): Step => ({ state, effect });

/**
 * The reducer. One key at a time, in whatever mode the browser is in.
 * `lensesFor` is injected so the state machine never imports the vault.
 */
export function reduce(
  state: BrowserState,
  key: Key,
  lensesFor: (entry: Entry) => Array<{ id: string; label: string; entries: Entry[] }>,
): Step {
  const cleared: BrowserState = state.status ? { ...state, status: '' } : state;

  switch (cleared.mode.kind) {
    case 'filter':
      return reduceFilter(cleared, key);
    case 'reader':
      return reduceReader(cleared, key, cleared.mode.scroll);
    case 'dive':
      return reduceDive(cleared, key, cleared.mode);
    case 'confirm':
      return reduceConfirm(cleared, key, cleared.mode);
    case 'prompt':
      return reducePrompt(cleared, key, cleared.mode);
    case 'help':
      return step(
        key.name === 'escape' || key.name === 'q' || key.name === 'return' || key.name === '?'
          ? { ...cleared, mode: { kind: 'list' } }
          : cleared,
      );
    default:
      return reduceList(cleared, key, lensesFor);
  }
}

function reduceList(
  state: BrowserState,
  key: Key,
  lensesFor: (entry: Entry) => Array<{ id: string; label: string; entries: Entry[] }>,
): Step {
  const entry = focused(state);
  const page = Math.max(1, state.pageSize - 1);

  switch (true) {
    case key.name === 'down' || key.name === 'j' || (key.ctrl && key.name === 'n'):
      return step(move(state, 1));
    case key.name === 'up' || key.name === 'k' || (key.ctrl && key.name === 'p'):
      return step(move(state, -1));
    case key.name === 'pagedown' || (key.ctrl && key.name === 'd') || key.name === 'space':
      return step(move(state, page));
    case key.name === 'pageup' || (key.ctrl && key.name === 'u'):
      return step(move(state, -page));
    // Shift-G arrives as a shifted `g`, so plain `g` has to say it is unshifted
    // or it answers for both and the jump-to-last key is unreachable.
    case key.name === 'home' || (!key.shift && key.name === 'g'):
      return step(jump(state, 0));
    case key.name === 'end' || (key.shift && key.name === 'g'):
      return step(jump(state, Number.MAX_SAFE_INTEGER));

    case key.name === 'return' || key.name === 'e':
      return entry ? step(state, { type: 'edit', entry }) : step(state);
    case key.name === 'o' || key.name === 'right' || key.name === 'l':
      return entry ? step({ ...state, mode: { kind: 'reader', scroll: 0 } }) : step(state);

    case key.name === '/':
      return step({ ...state, mode: { kind: 'filter' } });
    case key.name === 'd' || key.name === 'tab': {
      if (!entry) return step(state);
      const options = lensesFor(entry);
      return options.length
        ? step({ ...state, mode: { kind: 'dive', options, cursor: 0 } })
        : step({ ...state, status: 'nowhere to dive from this entry' });
    }
    case key.name === 'b' || key.name === 'left' || key.name === 'h':
      return step(pop(state));

    case key.name === 'a':
      return entry
        ? step({ ...state, mode: { kind: 'prompt', prompt: 'append', value: '', action: 'append' } })
        : step(state);
    case key.name === 'n':
      return step({ ...state, mode: { kind: 'prompt', prompt: 'new entry', value: '', action: 'new' } });
    case key.name === 'x':
      return entry
        ? step({
            ...state,
            mode: { kind: 'confirm', prompt: `delete "${entry.title}"?`, action: { type: 'delete', entry } },
          })
        : step(state);
    case key.name === 'y':
      return entry ? step(state, { type: 'yank', entry }) : step(state);
    case key.name === 'r':
      return step(state, { type: 'reload' });
    case key.name === '?':
      return step({ ...state, mode: { kind: 'help' } });

    case key.name === 'escape':
      // Escape backs out one level before it gives up entirely.
      return currentView(state).filter
        ? step(replaceView(state, { ...currentView(state), filter: '', cursor: 0, offset: 0 }))
        : state.stack.length > 1
          ? step(pop(state))
          : step({ ...state, done: true }, { type: 'quit' });
    case key.name === 'q' || (key.ctrl && key.name === 'c'):
      return step({ ...state, done: true }, { type: 'quit' });
    default:
      return step(state);
  }
}

function reduceFilter(state: BrowserState, key: Key): Step {
  const view = currentView(state);

  if (key.name === 'return' || key.name === 'escape' || key.name === 'down' || key.name === 'up') {
    const next = { ...state, mode: { kind: 'list' as const } };
    // Escape with an empty box means "never mind"; with text it keeps the filter.
    return step(key.name === 'down' || key.name === 'up' ? reduceList(next, key, () => []).state : next);
  }
  if (key.name === 'backspace') {
    return step(replaceView(state, reposition({ ...view, filter: view.filter.slice(0, -1) }, state.pageSize, 0)));
  }
  if (key.ctrl && key.name === 'u') {
    return step(replaceView(state, reposition({ ...view, filter: '' }, state.pageSize, 0)));
  }
  if (key.ctrl && key.name === 'c') {
    return step({ ...state, done: true }, { type: 'quit' });
  }
  if (key.char && key.char.length === 1 && !key.ctrl && !key.meta) {
    return step(replaceView(state, reposition({ ...view, filter: view.filter + key.char }, state.pageSize, 0)));
  }
  return step(state);
}

const READER_PAGE = 10;

function reduceReader(state: BrowserState, key: Key, scroll: number): Step {
  const at = (next: number): Step =>
    step({ ...state, mode: { kind: 'reader', scroll: Math.max(0, next) } });

  switch (true) {
    case key.name === 'down' || key.name === 'j':
      return at(scroll + 1);
    case key.name === 'up' || key.name === 'k':
      return at(scroll - 1);
    case key.name === 'pagedown' || key.name === 'space' || (key.ctrl && key.name === 'd'):
      return at(scroll + READER_PAGE);
    case key.name === 'pageup' || (key.ctrl && key.name === 'u'):
      return at(scroll - READER_PAGE);
    case key.name === 'g' || key.name === 'home':
      return at(0);
    case key.name === 'return' || key.name === 'e': {
      const entry = focused(state);
      return entry ? step(state, { type: 'edit', entry }) : step(state);
    }
    case key.name === 'q' || key.name === 'escape' || key.name === 'o' || key.name === 'left' || key.name === 'h':
      return step({ ...state, mode: { kind: 'list' } });
    case key.ctrl && key.name === 'c':
      return step({ ...state, done: true }, { type: 'quit' });
    default:
      return step(state);
  }
}

function reduceDive(state: BrowserState, key: Key, mode: Extract<Mode, { kind: 'dive' }>): Step {
  const last = mode.options.length - 1;
  switch (true) {
    case key.name === 'down' || key.name === 'j':
      return step({ ...state, mode: { ...mode, cursor: Math.min(mode.cursor + 1, last) } });
    case key.name === 'up' || key.name === 'k':
      return step({ ...state, mode: { ...mode, cursor: Math.max(mode.cursor - 1, 0) } });
    case key.name === 'return' || key.name === 'right': {
      const option = mode.options[mode.cursor];
      return option ? step(push(state, option.label, option.entries)) : step(state);
    }
    case key.name === 'escape' || key.name === 'q' || key.name === 'd' || key.name === 'left':
      return step({ ...state, mode: { kind: 'list' } });
    case key.ctrl && key.name === 'c':
      return step({ ...state, done: true }, { type: 'quit' });
    default: {
      // Number keys pick a lens directly.
      const n = Number(key.char);
      const option = Number.isInteger(n) && n >= 1 ? mode.options[n - 1] : undefined;
      return option ? step(push(state, option.label, option.entries)) : step(state);
    }
  }
}

function reduceConfirm(state: BrowserState, key: Key, mode: Extract<Mode, { kind: 'confirm' }>): Step {
  if (key.name === 'y' || key.name === 'return') {
    return step({ ...state, mode: { kind: 'list' } }, mode.action);
  }
  return step({ ...state, mode: { kind: 'list' }, status: 'cancelled' });
}

function reducePrompt(state: BrowserState, key: Key, mode: Extract<Mode, { kind: 'prompt' }>): Step {
  if (key.name === 'return') {
    const text = mode.value.trim();
    const back: BrowserState = { ...state, mode: { kind: 'list' } };
    if (!text) return step({ ...back, status: 'nothing entered' });
    if (mode.action === 'new') return step(back, { type: 'create', text });
    const entry = focused(state);
    return entry ? step(back, { type: 'append', entry, text }) : step(back);
  }
  if (key.name === 'escape') return step({ ...state, mode: { kind: 'list' }, status: 'cancelled' });
  if (key.name === 'backspace') {
    return step({ ...state, mode: { ...mode, value: mode.value.slice(0, -1) } });
  }
  if (key.ctrl && key.name === 'u') return step({ ...state, mode: { ...mode, value: '' } });
  if (key.ctrl && key.name === 'c') return step({ ...state, done: true }, { type: 'quit' });
  if (key.char && key.char.length === 1 && !key.ctrl && !key.meta) {
    return step({ ...state, mode: { ...mode, value: mode.value + key.char } });
  }
  return step(state);
}

/** Re-applies fresh entries to every view after the vault changes underneath. */
export function restack(state: BrowserState, byId: Map<string, Entry>, rootEntries: Entry[]): BrowserState {
  const stack = state.stack.map((view, i) => {
    const entries = i === 0 ? rootEntries : view.entries.map((e) => byId.get(e.id)).filter(Boolean as unknown as (e: Entry | undefined) => e is Entry);
    // The window has to move with the cursor: a shorter list left the offset
    // where it was, so the pane sliced past the end and drew blank rows under a
    // cursor that was still live.
    return reposition({ ...view, entries }, state.pageSize, view.cursor);
  });
  return { ...state, stack };
}
