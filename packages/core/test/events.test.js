import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, MemoryStorage, DEFAULT_CONFIG, EVENT_NAMES, eventJson } from '../dist/index.js';

/**
 * The push half of ppr's surface. What is asserted here is the contract other
 * people's programs are written against: which acts speak, what they carry,
 * and that a listener with a bug in it cannot cost the user an entry.
 */

/** A vault that records everything it announces, in order. */
async function recordingVault({ provider } = {}) {
  const events = [];
  const vault = await Vault.open({
    root: '/memory',
    storage: new MemoryStorage(),
    config: structuredClone(DEFAULT_CONFIG),
    provider,
    onEvent: (event) => events.push(event),
  });
  return { vault, events, names: () => events.map((e) => e.event) };
}

function fakeProvider(reply) {
  return {
    id: 'fake',
    model: 'fake-1',
    local: true,
    generate: async (req) => (typeof reply === 'function' ? reply(req) : reply),
  };
}

/** The scripted model from ai.test.js: extraction and reconciliation, on demand. */
function learnProvider({ facts = [], verdicts = [] } = {}) {
  return fakeProvider((req) =>
    /Decide how each candidate/.test(req.system)
      ? JSON.stringify({ verdicts })
      : JSON.stringify({ memories: facts }),
  );
}

test('every write says so, and says enough that nobody has to ask', async () => {
  const { vault, events, names } = await recordingVault();

  const entry = await vault.add({ body: 'shipped the migration', kind: 'log' });
  const updated = await vault.update(entry.id, { body: 'shipped the migration, twice' });
  await vault.remove(updated.id);

  assert.deepEqual(names(), ['entry.created', 'entry.updated', 'entry.removed']);

  for (const event of events) {
    assert.equal(event.v, 1, 'every payload is versioned');
    assert.equal(event.vault, '/memory');
    assert.ok(!Number.isNaN(Date.parse(event.at)));
    // Data-complete: a consumer never needs to call back into ppr.
    assert.equal(typeof event.entry.body, 'string');
    assert.ok(event.entry.path);
    assert.ok(event.entry.id);
  }
  // Both sides of a change, so a consumer can diff without having kept state.
  assert.equal(events[1].previous.body, 'shipped the migration');
  assert.equal(events[1].entry.body, 'shipped the migration, twice');
});

test('reads are silent, because a read already composes with a pipe', async () => {
  const { vault, names } = await recordingVault();
  await vault.add({ body: 'something', kind: 'log' });

  vault.list();
  vault.search('something');
  vault.context('something');
  vault.upcoming();
  vault.stats();
  vault.tags();

  // `ppr brief --plain | ppr-notify` needs no event to exist.
  assert.deepEqual(names(), ['entry.created']);
});

test('finishing a thing is its own event, on top of the write', async () => {
  const { vault, events, names } = await recordingVault();
  const reminder = await vault.addReminder('call the dentist', { date: '2027-03-01' });
  await vault.complete(reminder.id);

  // The file changed *and* an intention was finished. Different subscriptions:
  // only one of them is worth congratulating somebody about.
  assert.deepEqual(names(), ['entry.created', 'entry.updated', 'entry.completed']);
  const completed = events.at(-1);
  assert.equal(completed.entry.id, reminder.id);
  assert.equal(completed.previous.id, reminder.id);
});

test('a reminder is entry.created plus a filter, not a name of its own', async () => {
  const { vault, events } = await recordingVault();
  await vault.addReminder('call the dentist', { date: '2027-03-01' });

  // The whole reason the vocabulary stays small: everything a consumer needs
  // to tell kinds apart is already in the payload.
  const created = events.filter((e) => e.event === 'entry.created');
  assert.equal(created.length, 1);
  assert.equal(created[0].entry.kind, 'reminder');
  assert.equal(eventJson(created[0]).entry.body, 'call the dentist');
});

test('learning announces each verdict and then the run', async () => {
  const { vault, events, names } = await recordingVault({
    provider: learnProvider({ facts: ['Emily likes chocolate'] }),
  });
  await vault.add({ body: 'emily likes chocolate', kind: 'log' });
  const result = await vault.learn();

  assert.deepEqual(names(), [
    'entry.created', // the log
    'entry.created', // the fact's file
    'fact.learned', // what the file meant
    'learn.finished',
  ]);

  const finished = events.at(-1);
  assert.equal(finished.scanned, 1);
  assert.equal(finished.duplicates, 0);
  assert.equal(finished.unreadable, 0);
  assert.deepEqual(finished.learned.map((e) => e.body), ['Emily likes chocolate']);
  assert.deepEqual(finished.learned.map((e) => e.id), result.learned.map((e) => e.id));
});

test('a refined fact carries the sentence it replaced', async () => {
  const { vault, events } = await recordingVault({
    provider: learnProvider({ facts: ['Emily likes dark chocolate'] }),
  });
  await vault.add({ body: 'emily likes chocolate', kind: 'log' });
  await vault.learn();

  const known = vault.facts()[0];
  vault.provider = learnProvider({
    facts: ['Emily likes dark chocolate, 85%'],
    verdicts: [{ i: 1, verdict: 'refines', of: known.id, text: 'Emily likes dark chocolate, 85%' }],
  });
  await vault.add({ body: 'emily likes 85% dark chocolate', kind: 'log' });
  await vault.learn();

  const refined = events.filter((e) => e.event === 'fact.refined');
  assert.equal(refined.length, 1);
  assert.equal(refined[0].previous.body, 'Emily likes dark chocolate');
  assert.equal(refined[0].entry.body, 'Emily likes dark chocolate, 85%');
});

test('a contradiction announces both sides and settles neither', async () => {
  const { vault, events } = await recordingVault({
    provider: learnProvider({ facts: ["Emily's birthday is 22 October"] }),
  });
  await vault.add({ body: 'emily was born on 22 october', kind: 'log' });
  await vault.learn();

  const known = vault.facts()[0];
  vault.provider = learnProvider({
    facts: ["Emily's birthday is 20 October"],
    verdicts: [{ i: 1, verdict: 'contradicts', of: known.id }],
  });
  await vault.add({ body: 'emily was born on 20 october', kind: 'log' });
  const result = await vault.learn();

  const found = events.filter((e) => e.event === 'conflict.found');
  assert.equal(found.length, 1);
  assert.match(found[0].entry.body, /20 October/);
  assert.match(found[0].with.body, /22 October/);
  assert.equal(result.conflicts.length, 1);
  // Both are still current: recording a disagreement is not settling it.
  assert.equal(vault.facts().length, 2);
});

test('a listener that throws never costs the user their words', async () => {
  const storage = new MemoryStorage();
  const vault = await Vault.open({
    root: '/memory',
    storage,
    config: structuredClone(DEFAULT_CONFIG),
    onEvent: () => {
      throw new Error('the consumer is broken');
    },
  });

  const entry = await vault.add({ body: 'this must reach disk', kind: 'log' });
  assert.match(await storage.read(entry.path), /this must reach disk/);
  // And every later write still works: one bad listener is not a dead vault.
  const second = await vault.add({ body: 'and so must this', kind: 'log' });
  assert.match(await storage.read(second.path), /and so must this/);
  await vault.complete(await vault.addReminder('x', { date: '2027-03-01' }).then((e) => e.id));
  await vault.remove(entry.id);
  assert.equal(await storage.read(entry.path), null);
});

test('the event vocabulary is small and fixed on purpose', () => {
  // These names are API forever. A new one is a considered addition, and a
  // `reminder.created` is never one of them — that is a filter on `kind`.
  assert.deepEqual(EVENT_NAMES, [
    'entry.created',
    'entry.updated',
    'entry.removed',
    'entry.completed',
    'fact.learned',
    'fact.refined',
    'conflict.found',
    'learn.finished',
  ]);
});

test('what goes on the wire is plain JSON a stranger can parse', async () => {
  const { vault, events } = await recordingVault();
  await vault.add({ body: 'shipped it #work', kind: 'log' });

  const wire = JSON.parse(JSON.stringify(eventJson(events[0])));
  assert.equal(wire.event, 'entry.created');
  assert.equal(wire.v, 1);
  // The same projection `ppr ls --json` prints, field for field.
  assert.deepEqual(Object.keys(wire.entry).sort(), [
    'body',
    'created',
    'id',
    'kind',
    'links',
    'path',
    'tags',
    'title',
    'updated',
  ]);
  assert.deepEqual(wire.entry.tags, ['work']);
});
