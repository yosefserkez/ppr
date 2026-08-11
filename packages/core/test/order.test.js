import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, MemoryStorage, DEFAULT_CONFIG, createId, shortId, heuristicThread } from '../dist/index.js';
// Internal on purpose: ordering is a rule the engine keeps to, not a knob a
// host reaches for, so it is not on `@ppr/core`'s public surface.
import { byCreatedAsc, byCreatedDesc } from '../dist/util/order.js';

/** A vault backed by memory: the same code paths the CLI uses, no filesystem. */
async function makeVault() {
  const storage = new MemoryStorage();
  const vault = await Vault.open({
    root: '/memory',
    storage,
    config: structuredClone(DEFAULT_CONFIG),
  });
  return vault;
}

/** Three ids from one millisecond: monotonic, so strictly increasing (L2). */
function idsInOneMillisecond(when) {
  const at = new Date(when);
  return [createId(at), createId(at), createId(at)];
}

const permutations = (items) =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

test('two entries written in the same second come out in the same order every time', () => {
  const created = '2026-03-04T09:15:00+00:00';
  const ids = idsInOneMillisecond('2026-03-04T09:15:00Z');
  const rows = ids.map((id) => ({ id, created }));

  for (const shuffled of permutations(rows)) {
    assert.deepEqual(
      [...shuffled].sort(byCreatedAsc).map((r) => r.id),
      ids,
      'oldest first is the id order, whatever order they arrived in',
    );
    assert.deepEqual(
      [...shuffled].sort(byCreatedDesc).map((r) => r.id),
      [...ids].reverse(),
      'newest first is the exact opposite',
    );
  }
});

test('a later second still wins, however the ids happened to fall', () => {
  // A hand-written file gets whatever id it gets, so the id can disagree with
  // `created`. The second is the claim about when it happened; the id is only
  // there to settle a tie.
  const early = { id: 'zzzzzzzzzzzzzzzz', created: '2026-03-04T09:15:00+00:00' };
  const late = { id: '0000000000000000', created: '2026-03-04T09:15:01+00:00' };

  assert.deepEqual([early, late].sort(byCreatedAsc), [early, late]);
  assert.deepEqual([early, late].sort(byCreatedDesc), [late, early]);
});

test('listing entries written in the same second is stable across repeated calls', async () => {
  const vault = await makeVault();
  const created = '2026-03-04T09:15:00';
  await vault.add({ body: 'first thing', created });
  await vault.add({ body: 'second thing', created });
  await vault.add({ body: 'third thing', created });

  const once = vault.list().map((e) => e.id);
  const twice = vault.list().map((e) => e.id);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, [...once].sort().reverse(), 'newest first falls back to the id');
});

test('the offline thread story reads forwards even when every entry shares a second', () => {
  const created = '2026-03-04T09:15:00+00:00';
  const ids = idsInOneMillisecond('2026-03-04T10:00:00Z');
  const entries = ids.map((id, i) => ({
    id,
    created,
    title: `step ${i}`,
    body: `step ${i}`,
    tags: [],
    links: [],
    extra: {},
    kind: 'note',
    path: '',
  }));

  const story = heuristicThread([entries[2], entries[0], entries[1]]);
  assert.deepEqual(
    story.split('\n').map((line) => line.slice(line.indexOf('[') + 1, line.indexOf(']'))),
    ids.map(shortId),
    'oldest first, and the same order whichever way they were handed over',
  );
});
