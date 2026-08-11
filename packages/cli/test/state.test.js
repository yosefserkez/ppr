import test from 'node:test';
import assert from 'node:assert/strict';
import { searchEntries } from '@ppr/core';
import {
  createState,
  currentView,
  focused,
  push,
  reduce,
  restack,
  visibleEntries,
} from '../dist/ui/state.js';

const entry = (id, title, over = {}) => ({
  id: id.padEnd(16, 'x'),
  kind: 'log',
  title,
  created: '2026-07-27T12:00:00-07:00',
  updated: '2026-07-27T12:00:00-07:00',
  tags: [],
  links: [],
  extra: {},
  body: title,
  path: `entries/${id}.md`,
  ...over,
});

const many = (n) => Array.from({ length: n }, (_, i) => entry(`e${i}`, `Entry ${i}`));
const key = (name, over = {}) => ({ name, ...over });
const noLenses = () => [];

/** Feeds a sequence of keys, returning the final state. */
function drive(state, keys, lenses = noLenses) {
  let current = state;
  const effects = [];
  for (const k of keys) {
    const result = reduce(current, typeof k === 'string' ? key(k) : k, lenses);
    current = result.state;
    if (result.effect.type !== 'none') effects.push(result.effect);
  }
  return { state: current, effects };
}

test('the cursor moves and stops at both ends', () => {
  const start = createState('all', many(5), 10);
  assert.equal(drive(start, ['down', 'down']).state.stack[0].cursor, 2);
  assert.equal(drive(start, ['up']).state.stack[0].cursor, 0, 'cannot go above the first');
  assert.equal(drive(start, Array(20).fill('down')).state.stack[0].cursor, 4, 'cannot go past the last');
  assert.equal(drive(start, ['end']).state.stack[0].cursor, 4);
  assert.equal(drive(start, ['end', 'home']).state.stack[0].cursor, 0);
});

test('j/k work like the arrows', () => {
  const start = createState('all', many(5), 10);
  assert.equal(drive(start, ['j', 'j', 'k']).state.stack[0].cursor, 1);
});

test('the window scrolls to keep the cursor visible', () => {
  const state = createState('all', many(50), 10);
  const scrolled = drive(state, Array(12).fill('down')).state;
  const view = currentView(scrolled);
  assert.equal(view.cursor, 12);
  assert.ok(view.offset > 0, 'the list scrolled');
  assert.ok(view.cursor >= view.offset && view.cursor < view.offset + 10, 'cursor stays on screen');
});

test('paging never scrolls past the end', () => {
  const state = createState('all', many(25), 10);
  const paged = drive(state, Array(10).fill('pagedown')).state;
  const view = currentView(paged);
  assert.equal(view.cursor, 24);
  assert.ok(view.offset <= 15);
});

test('filtering narrows the list and resets the cursor', () => {
  const entries = [entry('a', 'redis migration'), entry('b', 'lunch plans'), entry('c', 'redis latency')];
  let state = createState('all', entries, 10);
  state = drive(state, ['down']).state;

  state = drive(state, ['/']).state;
  assert.equal(state.mode.kind, 'filter');

  state = drive(state, [key('r', { char: 'r' }), key('e', { char: 'e' }), key('d', { char: 'd' })]).state;
  assert.equal(visibleEntries(currentView(state)).length, 2);
  assert.equal(currentView(state).cursor, 0, 'cursor returns to the top of the new list');
  // The filter ranks rather than preserving list order; these two score the
  // same, so the tiebreak on id decides, exactly as `ppr search` would.
  assert.equal(focused(state).title, 'redis latency');

  state = drive(state, ['backspace', 'backspace', 'backspace']).state;
  assert.equal(visibleEntries(currentView(state)).length, 3);
});

test('filter mode captures letters instead of triggering commands', () => {
  const state = createState('all', many(5), 10);
  const filtering = drive(state, ['/', key('q', { char: 'q' }), key('x', { char: 'x' })]).state;
  assert.equal(filtering.done, false, 'q typed into a filter must not quit');
  assert.equal(currentView(filtering).filter, 'qx');
});

test('escape peels back one layer at a time', () => {
  let state = createState('all', many(3), 10);
  state = push(state, 'related', many(2));
  state = drive(state, ['/', key('e', { char: 'e' }), 'return']).state;
  assert.equal(currentView(state).filter, 'e');

  state = drive(state, ['escape']).state;
  assert.equal(currentView(state).filter, '', 'first escape clears the filter');

  state = drive(state, ['escape']).state;
  assert.equal(state.stack.length, 1, 'second escape pops the view');

  const { state: final, effects } = drive(state, ['escape']);
  assert.equal(final.done, true, 'third escape quits');
  assert.deepEqual(effects.at(-1), { type: 'quit' });
});

test('diving pushes a view and back pops it', () => {
  const entries = many(3);
  const lenses = () => [
    { id: 'backlinks', label: 'Linked from', entries: [entry('z', 'Linking entry')] },
    { id: 'related', label: 'Related', entries: many(2) },
  ];
  let state = createState('all', entries, 10);

  state = drive(state, ['d'], lenses).state;
  assert.equal(state.mode.kind, 'dive');

  state = drive(state, ['down', 'return'], lenses).state;
  assert.equal(state.stack.length, 2);
  assert.equal(currentView(state).label, 'Related');

  state = drive(state, ['b'], lenses).state;
  assert.equal(state.stack.length, 1);
  assert.equal(currentView(state).label, 'all');
});

test('a dead end says so instead of opening an empty panel', () => {
  const state = drive(createState('all', many(2), 10), ['d'], () => []).state;
  assert.equal(state.mode.kind, 'list');
  assert.match(state.status, /nowhere to dive/);
});

test('enter asks the shell to edit the focused entry', () => {
  const entries = many(3);
  const { effects } = drive(createState('all', entries, 10), ['down', 'return']);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].type, 'edit');
  assert.equal(effects[0].entry.id, entries[1].id);
});

test('delete asks for confirmation first', () => {
  const entries = many(2);
  let { state, effects } = drive(createState('all', entries, 10), ['x']);
  assert.equal(effects.length, 0, 'nothing is deleted yet');
  assert.equal(state.mode.kind, 'confirm');

  const confirmed = drive(state, ['y']);
  assert.equal(confirmed.effects[0].type, 'delete');
  assert.equal(confirmed.effects[0].entry.id, entries[0].id);

  const cancelled = drive(state, ['n']);
  assert.equal(cancelled.effects.length, 0);
  assert.equal(cancelled.state.mode.kind, 'list');
});

test('the append prompt collects text and emits it once', () => {
  const entries = many(2);
  const typed = 'ok'.split('').map((c) => key(c, { char: c }));
  const { state, effects } = drive(createState('all', entries, 10), ['a', ...typed, 'return']);

  assert.equal(effects.length, 1);
  assert.equal(effects[0].type, 'append');
  assert.equal(effects[0].text, 'ok');
  assert.equal(state.mode.kind, 'list');
});

test('an empty prompt does nothing', () => {
  const { effects, state } = drive(createState('all', many(2), 10), ['a', 'return']);
  assert.equal(effects.length, 0);
  assert.match(state.status, /nothing entered/);
});

test('the reader scrolls and never goes negative', () => {
  let state = createState('all', many(2), 10);
  state = drive(state, ['o']).state;
  assert.equal(state.mode.kind, 'reader');

  state = drive(state, ['down', 'down']).state;
  assert.equal(state.mode.scroll, 2);

  state = drive(state, Array(10).fill('up')).state;
  assert.equal(state.mode.scroll, 0);

  state = drive(state, ['q']).state;
  assert.equal(state.mode.kind, 'list', 'q leaves the reader, it does not quit ppr');
});

test('ctrl-c quits from every mode', () => {
  const base = createState('all', many(3), 10);
  for (const path of [[], ['/'], ['o'], ['a']]) {
    const state = drive(base, path).state;
    const { state: after, effects } = drive(state, [key('c', { ctrl: true })]);
    assert.equal(after.done, true, `ctrl-c should quit from ${state.mode.kind}`);
    assert.deepEqual(effects.at(-1), { type: 'quit' });
  }
});

test('an empty list is navigable without crashing', () => {
  const state = createState('all', [], 10);
  const { state: after, effects } = drive(state, ['down', 'up', 'return', 'x', 'o', 'd']);
  assert.equal(focused(after), undefined);
  assert.equal(effects.length, 0);
});

test('reloading keeps the cursor and drops entries that vanished', () => {
  const entries = many(4);
  let state = createState('all', entries, 10);
  state = drive(state, ['down', 'down']).state;

  const survivors = entries.filter((e) => e.id !== entries[3].id);
  const byId = new Map(survivors.map((e) => [e.id, e]));
  const reloaded = restack(state, byId, survivors);

  assert.equal(currentView(reloaded).entries.length, 3);
  assert.equal(currentView(reloaded).cursor, 2, 'the cursor stays where it was');
});

test('reloading clamps a cursor that is now past the end', () => {
  const entries = many(4);
  let state = createState('all', entries, 10);
  state = drive(state, ['end']).state;

  const survivors = entries.slice(0, 2);
  const reloaded = restack(state, new Map(survivors.map((e) => [e.id, e])), survivors);
  assert.equal(currentView(reloaded).cursor, 1);
  assert.ok(focused(reloaded), 'something is still focused');
});

test('g goes to the first entry and shift-G to the last', () => {
  const start = createState('all', many(6), 10);

  const end = drive(start, [key('g', { char: 'G', shift: true })]).state;
  assert.equal(currentView(end).cursor, 5, 'shift-G reaches the last entry');

  const top = drive(end, [key('g', { char: 'g' })]).state;
  assert.equal(currentView(top).cursor, 0, 'plain g still goes to the first');
});

test('reloading a shrunken list never leaves the window past the end', () => {
  const entries = many(10);
  let state = createState('all', entries, 3);
  state = drive(state, ['end']).state;
  assert.ok(currentView(state).offset > 0, 'the list is scrolled before the reload');

  const survivors = entries.slice(0, 4);
  const reloaded = restack(state, new Map(survivors.map((e) => [e.id, e])), survivors);
  const view = currentView(reloaded);

  assert.equal(view.cursor, 3, 'the cursor lands on the last surviving entry');
  assert.ok(
    view.offset <= view.cursor && view.cursor < view.offset + 3,
    'the cursor is inside the window the shell will draw',
  );
  assert.equal(view.entries.slice(view.offset, view.offset + 3).length, 3, 'the window has rows in it');
});

test('the header fits the terminal however deep the breadcrumb is', async () => {
  // Colour is what this bug was made of, so it has to be on: force it before
  // layout.js — and through it picocolors — is first loaded in this process.
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
  const { render } = await import('../dist/ui/layout.js');
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

  let state = createState('stack-01', many(3), 10);
  for (const label of ['stack-02', 'stack-03', 'stack-04', 'stack-05']) {
    state = push(state, label, many(3));
  }

  const columns = 60;
  const [header] = render(state, { columns, rows: 20 }, new Date('2026-07-27T12:00:00-07:00'));

  const count = (re) => (header.match(re) ?? []).length;

  assert.ok(header.includes('\x1b['), 'colour is on, or this test proves nothing');
  assert.equal(strip(header).length, columns, 'the header fills the width exactly');
  assert.equal(header.match(/\x1b(?!\[[0-9;]*m)/), null, 'no escape sequence was cut in half');
  assert.equal(count(/\x1b\[2m/g), count(/\x1b\[22m/g), 'every dim it opens, it closes — a clipped one sticks');
});

test('the browse filter finds exactly what search would have found', () => {
  const entries = [
    entry('a', 'redis migration', { body: 'moving the cache off redis' }),
    entry('b', 'lunch plans'),
    entry('c', 'redis latency', { tags: ['redis'] }),
    entry('d', 'cache warmup', { body: 'the redis warmup script' }),
  ];
  const view = { label: 'all', entries, cursor: 0, offset: 0, filter: 'redis' };

  const expected = searchEntries(entries, 'redis', { mode: 'filter' }).map((hit) => hit.entry.id);
  assert.equal(expected.length, 3, 'the one entry that never says redis is out');
  assert.deepEqual(visibleEntries(view).map((e) => e.id), expected, 'same set, same order');
  // One token is where the two modes provably coincide — "every token matched"
  // and "some token matched" are the same sentence about a single word — so the
  // browser is pinned to what `ppr search redis` prints, order included. That
  // is the coupling worth having: one matcher, and no way for it to drift.
  assert.deepEqual(
    searchEntries(entries, 'redis').map((hit) => hit.entry.id),
    expected,
    'and it is the same answer `ppr search redis` gives',
  );
});

test('a filter only ever narrows as you type', () => {
  const entries = [
    entry('a', 'redis notes'),
    entry('b', 'lunch plans', { body: 'plans for the migration' }),
    entry('c', 'redis migration', { body: 'moving the cache off redis' }),
  ];
  const visible = (filter) =>
    visibleEntries({ label: 'all', entries, cursor: 0, offset: 0, filter }).map((e) => e.id);

  // Every prefix of a typed query, in order: each one shows a subset of what
  // the keystroke before it showed. A box that widens as you add a word is not
  // a filter, and ranked search on its own widens — one token of two is enough
  // to be listed there.
  const typed = 'redis migration';
  let previous = entries.map((e) => e.id);
  for (let i = 1; i <= typed.length; i++) {
    const prefix = typed.slice(0, i);
    const shown = visible(prefix);
    assert.ok(
      shown.every((id) => previous.includes(id)),
      `"${prefix}" showed something "${typed.slice(0, i - 1)}" did not`,
    );
    previous = shown;
  }

  assert.equal(visible('redis').length, 2, 'the migration note that never says redis is out');
  assert.deepEqual(visible('redis migration'), [entries[2].id], 'both words, or it does not show');
  // The other mode really does widen here — which is why there are two of them
  // rather than one that quietly does the wrong job in the browser.
  assert.equal(searchEntries(entries, 'redis migration').length, 3);
});

test('the first character of a filter narrows instead of blanking the pane', () => {
  const entries = [
    entry('a', 'redis notes'),
    entry('b', 'lunch plans'),
    entry('c', 'c++ template madness'),
  ];
  const visible = (filter) =>
    visibleEntries({ label: 'all', entries, cursor: 0, offset: 0, filter }).map((e) => e.title);

  // Search drops one-letter tokens as noise; a filter box cannot, or the pane
  // goes empty on the first keystroke of every search and `e`/`x`/`return`
  // have nothing focused to act on until a second letter arrives.
  assert.deepEqual(visible('r'), ['redis notes']);
  assert.deepEqual(visible('re'), ['redis notes'], 'and the second letter does not change its mind');

  // Punctuation the tokenizer does not keep must not blank the list either.
  assert.ok(visible('c++').includes('c++ template madness'));
});

test('a filtered list drops what was deleted, not what it cached', () => {
  const entries = [entry('a', 'redis migration'), entry('b', 'lunch plans'), entry('c', 'redis latency')];
  let state = createState('all', entries, 10);
  state = drive(state, ['/', ...'redis'.split('').map((c) => key(c, { char: c })), 'return']).state;
  assert.equal(visibleEntries(currentView(state)).length, 2);

  const survivors = entries.filter((e) => e.title !== 'redis latency');
  const reloaded = restack(state, new Map(survivors.map((e) => [e.id, e])), survivors);
  const visible = visibleEntries(currentView(reloaded));

  assert.equal(visible.length, 1, 'the entry that went away is gone, though the filter never changed');
  assert.equal(visible[0].title, 'redis migration');
});
