import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, MemoryStorage, DEFAULT_CONFIG, continuesThread, gapWords, threadGaps } from '../dist/index.js';

async function makeVault(overrides = {}) {
  const vault = await Vault.open({
    root: '/memory',
    storage: new MemoryStorage(),
    config: structuredClone({ ...DEFAULT_CONFIG, ...overrides }),
  });
  return vault;
}

/** Entries written on chosen days, so a thread has a shape in time. */
const on = (day, body, fields = {}) => ({ body, created: `${day}T12:00:00`, kind: 'log', ...fields });

const titles = (thread) => thread.entries.map((m) => m.entry.title);

test('a linked chain is followed, and an unrelated entry with one word in common is not', async () => {
  const vault = await makeVault();
  const first = await vault.add(on('2026-01-05', 'The coffee subscription idea', { title: 'Coffee subscription' }));
  await vault.add(on('2026-01-20', 'Costed out [[Coffee subscription]] properly', { title: 'Unit economics' }));
  await vault.add(on('2026-02-02', 'Following [[Unit economics]] — the margin is the problem', { title: 'The margin problem' }));
  // One word in common with a title and nothing else. A thread built out of
  // that is a thread built out of coincidences.
  await vault.add(on('2026-02-03', 'The office coffee machine is broken again', { title: 'Coffee machine' }));

  const thread = vault.thread(first.id);
  assert.deepEqual(titles(thread), ['Coffee subscription', 'Unit economics', 'The margin problem']);
  assert.equal(thread.seededBy, 'ref');
  assert.deepEqual(
    thread.entries.map((m) => m.reason),
    ['seed', 'linked', 'linked'],
  );
  assert.equal(thread.entries[2].hops, 2, 'reached through the middle entry, not directly');
});

test('a thread can be seeded by words, and says why each entry is on it', async () => {
  const vault = await makeVault();
  await vault.add(on('2026-01-05', 'Coffee subscription idea #coffee', { title: 'Coffee subscription idea' }));
  await vault.add(on('2026-01-20', 'What the beans cost #coffee', { title: 'Coffee subscription economics' }));
  await vault.add(on('2026-01-21', 'lunch was fine', { title: 'Lunch' }));

  const thread = vault.thread('coffee subscription');
  assert.equal(thread.seededBy, 'query');
  assert.deepEqual(titles(thread), ['Coffee subscription idea', 'Coffee subscription economics']);
  assert.ok(thread.entries.every((m) => m.why), 'every entry says what put it there');
});

test('a fact learned from the thread is part of it, and stays out of the timeline', async () => {
  const vault = await makeVault();
  const seed = await vault.add(on('2026-01-05', 'Coffee subscription idea', { title: 'Coffee subscription' }));
  await vault.add(on('2026-01-20', 'Costed [[Coffee subscription]] out', { title: 'Unit economics' }));
  await vault.addFact('The coffee idea only works above 200 subscribers');
  const fact = vault.facts()[0];
  await vault.update(fact.id, { extra: { from: [seed.id] } });

  const thread = vault.thread(seed.id);
  assert.equal(thread.entries.length, 2, 'a fact is not a moment on the timeline (I12)');
  assert.equal(thread.facts.length, 1);
  assert.match(thread.facts[0].fact.text, /200 subscribers/);
  assert.deepEqual(thread.facts[0].from, [seed.id]);
});

test('a completed reminder stays on the thread — it is part of the story', async () => {
  const vault = await makeVault();
  const seed = await vault.add(on('2026-01-05', 'Coffee subscription idea', { title: 'Coffee subscription' }));
  const chase = await vault.addReminder('email the roaster about [[Coffee subscription]]', { date: '2026-01-10' });
  await vault.complete(chase.id);

  const thread = vault.thread(seed.id);
  assert.equal(thread.entries.length, 2);
  assert.equal(thread.entries[1].entry.extra.status, 'done');
});

test('expansion is bounded: a long chain does not drag in the whole vault', async () => {
  const vault = await makeVault();
  let previous = null;
  const first = [];
  for (let i = 0; i < 12; i++) {
    const title = `Step ${i}`;
    previous = await vault.add(
      on(`2026-01-${String(i + 1).padStart(2, '0')}`, previous ? `after [[${previous.title}]]` : 'the start', { title }),
    );
    first.push(previous);
  }

  const thread = vault.thread(first[0].id);
  assert.ok(thread.entries.length < 12, 'the walk stops before it has eaten everything');
  assert.deepEqual(titles(thread), ['Step 0', 'Step 1', 'Step 2', 'Step 3', 'Step 4']);
});

test('relatedness widens a thread by one step and never chains', async () => {
  const vault = await makeVault();
  const seed = await vault.add(on('2026-01-05', 'The redis migration #infra #redis', { title: 'Redis migration' }));
  await vault.add(on('2026-01-06', 'More on the redis migration #infra #redis #pooling', { title: 'Redis migration notes' }));
  // Shares a tag and a title word with the *second* entry, nothing with the
  // seed. Two hops of tags is a subject area, not a train of thought.
  await vault.add(on('2026-01-07', 'connection counts #pooling', { title: 'Postgres pooling' }));

  const thread = vault.thread(seed.id);
  assert.deepEqual(titles(thread), ['Redis migration', 'Redis migration notes']);
});

test('a thread that is not there is empty rather than invented', async () => {
  const vault = await makeVault();
  await vault.add(on('2026-01-05', 'lunch was fine'));
  assert.equal(vault.thread('quantum computing').entries.length, 0);
  assert.throws(() => vault.thread('   '), /Nothing to follow/);
});

test('gaps are the thread’s own rhythm, floored at a fortnight and capped at two months', () => {
  const daily = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-20'].map((d, i) => ({
    id: `id${i}`,
    created: `${d}T12:00:00`,
  }));
  // Median beat is one day, so 6× is six days — but nothing under a fortnight
  // is a gap, and 17 days is.
  assert.deepEqual(
    threadGaps(daily).map((g) => g.days),
    [17],
  );

  const monthly = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-06-01'].map((d, i) => ({
    id: `m${i}`,
    created: `${d}T12:00:00`,
  }));
  // Median beat is a month, so 6× would be half a year — capped at two months,
  // which the 92-day silence clears.
  assert.deepEqual(
    threadGaps(monthly).map((g) => g.days),
    [92],
  );

  const steady = ['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22'].map((d, i) => ({
    id: `s${i}`,
    created: `${d}T12:00:00`,
  }));
  assert.deepEqual(threadGaps(steady), [], 'a rhythm kept is not a gap');
  assert.deepEqual(threadGaps(steady.slice(0, 2)), [], 'two entries have no rhythm to break');
});

test('a gap is said in the units a person would use', () => {
  assert.equal(gapWords(1), '1 day later');
  assert.equal(gapWords(17), '17 days later');
  assert.equal(gapWords(35), '5 weeks later');
  assert.equal(gapWords(240), '8 months later');
  assert.equal(gapWords(730), '2 years later');
});

test('the capture nudge waits for a third entry, and for a real connection', async () => {
  const vault = await makeVault();
  const first = await vault.add(on('2026-01-05', 'Coffee subscription idea', { title: 'Coffee subscription' }));
  const second = await vault.add(on('2026-01-06', 'costing [[Coffee subscription]] out', { title: 'Unit economics' }));
  assert.equal(continuesThread(vault.thread(second.id), second.id), null, 'a pair is a coincidence');

  const third = await vault.add(on('2026-01-07', 'back to [[Coffee subscription]] and [[Unit economics]]', { title: 'The margin' }));
  assert.equal(continuesThread(vault.thread(third.id), third.id), 3, 'the third time is a line of thought');

  const stray = await vault.add(on('2026-01-08', 'lunch was fine', { title: 'Lunch' }));
  assert.equal(continuesThread(vault.thread(stray.id), stray.id), null);
  assert.ok(first);
});
