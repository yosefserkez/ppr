import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSelectState,
  highlighted,
  reduceSelect,
  resolveAnswer,
  visibleChoices,
} from '../dist/ui/select-state.js';
import { renderSelect } from '../dist/ui/select.js';

const CHOICES = [
  { value: 'none', label: 'none', hint: 'offline only' },
  { value: 'apple', label: 'apple', hint: 'on-device Apple Foundation Models' },
  { value: 'ollama', label: 'ollama', hint: 'local models via Ollama' },
  { value: 'anthropic', label: 'anthropic', hint: 'Claude API' },
  { value: 'openai', label: 'openai', hint: 'OpenAI-compatible endpoint' },
];

const key = (name, over = {}) => ({ name, ...over });
const typed = (text) => [...text].map((c) => key(c, { char: c }));

function drive(state, keys) {
  return keys.reduce((acc, k) => reduceSelect(acc, typeof k === 'string' ? key(k) : k), state);
}

test('arrows move the highlight and wrap at both ends', () => {
  const start = createSelectState(CHOICES);
  assert.equal(highlighted(drive(start, ['down'])).label, 'apple');
  assert.equal(highlighted(drive(start, ['down', 'down'])).label, 'ollama');
  assert.equal(highlighted(drive(start, ['up'])).label, 'openai', 'wraps to the end');
  assert.equal(highlighted(drive(start, Array(5).fill('down'))).label, 'none', 'wraps to the start');
});

test('ctrl-n, ctrl-p, and tab move too', () => {
  const start = createSelectState(CHOICES);
  assert.equal(highlighted(drive(start, [key('n', { ctrl: true })])).label, 'apple');
  assert.equal(highlighted(drive(start, [key('tab')])).label, 'apple');
  assert.equal(highlighted(drive(start, [key('p', { ctrl: true })])).label, 'openai');
});

test('typing filters, and enter takes the highlighted match', () => {
  let state = drive(createSelectState(CHOICES), typed('oll'));
  assert.equal(visibleChoices(state).length, 1);
  assert.equal(highlighted(state).label, 'ollama');

  state = reduceSelect(state, key('return'));
  assert.equal(state.done, true);
  assert.equal(state.picked.value, 'ollama');
});

test('the filter searches the hint as well as the label', () => {
  const state = drive(createSelectState(CHOICES), typed('claude'));
  assert.equal(visibleChoices(state).length, 1);
  assert.equal(highlighted(state).label, 'anthropic');
});

test('a bare number jumps to that option and keeps the list visible', () => {
  const state = drive(createSelectState(CHOICES), typed('3'));
  assert.equal(
    visibleChoices(state).length,
    CHOICES.length,
    'the other options stay on screen so you can see what you are picking',
  );
  assert.equal(highlighted(state).label, 'ollama');
  assert.equal(reduceSelect(state, key('return')).picked.value, 'ollama');
});

test('an out-of-range number is treated as text, not an index', () => {
  const state = drive(createSelectState(CHOICES), typed('99'));
  assert.equal(visibleChoices(state).length, 0);
  assert.equal(highlighted(state), undefined);
  assert.equal(reduceSelect(state, key('return')).done, false, 'enter cannot pick nothing');
});

test('backspace and ctrl-u edit the query', () => {
  let state = drive(createSelectState(CHOICES), typed('anth'));
  assert.equal(visibleChoices(state).length, 1);

  state = drive(state, ['backspace', 'backspace', 'backspace', 'backspace']);
  assert.equal(state.query, '');
  assert.equal(visibleChoices(state).length, CHOICES.length);

  state = drive(state, [...typed('open'), key('u', { ctrl: true })]);
  assert.equal(state.query, '');
});

test('letters filter instead of triggering shortcuts', () => {
  // `q` must be able to filter to "qwen", not quit the prompt.
  const state = drive(createSelectState([...CHOICES, { value: 'qwen', label: 'qwen' }]), typed('q'));
  assert.equal(state.done, false);
  assert.equal(highlighted(state).label, 'qwen');
});

test('escape and ctrl-c cancel without picking', () => {
  for (const k of [key('escape'), key('c', { ctrl: true })]) {
    const state = reduceSelect(createSelectState(CHOICES), k);
    assert.equal(state.done, true);
    assert.equal(state.cancelled, true);
    assert.equal(state.picked, undefined);
  }
});

test('moving after filtering stays inside the narrowed list', () => {
  // "op" matches anthropic and openai, and nothing else.
  const filtered = drive(createSelectState(CHOICES), typed('op'));
  assert.deepEqual(visibleChoices(filtered).map((c) => c.label), ['anthropic', 'openai']);
  assert.equal(highlighted(filtered).label, 'anthropic', 'the cursor resets to the top');

  const moved = drive(filtered, ['down']);
  assert.equal(highlighted(moved).label, 'openai');
  assert.equal(highlighted(drive(moved, ['down'])).label, 'anthropic', 'wraps within the matches');
});

test('narrowing past the cursor pulls it back into range', () => {
  // Sit on the last option, then type a filter that excludes it.
  const state = drive(createSelectState(CHOICES), [...Array(4).fill('down'), ...typed('app')]);
  assert.equal(visibleChoices(state).length, 1);
  assert.equal(highlighted(state).label, 'apple', 'no dangling cursor past the end');
});

test('a filter that matches nothing is survivable', () => {
  const state = drive(createSelectState(CHOICES), typed('zzz'));
  assert.deepEqual(visibleChoices(state), []);
  assert.equal(highlighted(state), undefined);
  assert.equal(drive(state, ['down', 'up', 'return']).done, false);
  assert.equal(drive(state, ['backspace', 'backspace', 'backspace']).query, '');
});

test('typed answers resolve by number, exact name, or unambiguous prefix', () => {
  assert.equal(resolveAnswer(CHOICES, '2').value, 'apple');
  assert.equal(resolveAnswer(CHOICES, 'ollama').value, 'ollama');
  assert.equal(resolveAnswer(CHOICES, 'OLLAMA').value, 'ollama');
  assert.equal(resolveAnswer(CHOICES, 'anth').value, 'anthropic');
  assert.equal(resolveAnswer(CHOICES, 'o'), undefined, 'ambiguous prefixes are refused');
  assert.equal(resolveAnswer(CHOICES, '0'), undefined);
  assert.equal(resolveAnswer(CHOICES, '9'), undefined);
  assert.equal(resolveAnswer(CHOICES, ''), undefined);
});

test('the frame shows every option, numbered, with one marked', () => {
  const state = drive(createSelectState(CHOICES), ['down']);
  const lines = renderSelect(state, 'Model backend', 70);

  assert.match(lines[0], /Model backend/);
  assert.equal(lines.length, CHOICES.length + 2, 'title, one row per choice, input line');
  assert.equal(lines.filter((l) => l.includes('❯')).length, 1, 'exactly one row is marked');
  assert.match(lines[2], /❯.*apple/);
  assert.match(lines[3], /3.*ollama/);
  for (const line of lines) assert.ok(line.length >= 70, 'rows are padded to the width');
});

test('the frame reflects the filter', () => {
  const state = drive(createSelectState(CHOICES), typed('oll'));
  const lines = renderSelect(state, 'Model backend', 70);
  assert.equal(lines.length, 3, 'title, the single match, input line');
  assert.match(lines.at(-1), /oll/, 'the query is echoed');
});
