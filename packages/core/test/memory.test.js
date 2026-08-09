import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntry,
  factExtra,
  factTerms,
  mentionScore,
  nextOccurrence,
  parseFactDate,
  reminderExtra,
  toDated,
  toFact,
} from '../dist/index.js';

/** A fact as it exists on disk, so the accessors are exercised, not bypassed. */
const fact = (text, extra = {}) =>
  toFact(createEntry({ body: text, kind: 'memory', title: text, extra: factExtra(extra) }));

test('a date is only accepted when it is unambiguously a calendar day', () => {
  assert.equal(parseFactDate('2002-10-20'), '2002-10-20');
  assert.equal(parseFactDate('2002-10-20T00:00:00Z'), '2002-10-20');
  assert.equal(parseFactDate(new Date(Date.UTC(2002, 9, 20))), '2002-10-20');
  // A half-understood date is worse than none: everything downstream trusts it.
  for (const bad of ['October 20', '20/10/2002', '2002-13-01', '2002-10-99', '', null, 42]) {
    assert.equal(parseFactDate(bad), undefined, `should reject: ${String(bad)}`);
  }
});

test('a yearly date rolls forward and counts the years', () => {
  const birthday = fact("Emily's birthday is 20 October", { date: '2002-10-20', recurs: 'yearly' });

  const summer = nextOccurrence(birthday, new Date(2026, 7, 8));
  assert.equal(summer.days, 73);
  assert.equal(summer.date.getFullYear(), 2026);
  assert.equal(summer.ordinal, 24);

  // Past this year's, so it points at next year's.
  const december = nextOccurrence(birthday, new Date(2026, 11, 1));
  assert.equal(december.date.getFullYear(), 2027);
  assert.equal(december.ordinal, 25);

  // The day itself is zero days away, not already gone.
  assert.equal(nextOccurrence(birthday, new Date(2026, 9, 20)).days, 0);
});

test('a one-off date disappears once it has passed', () => {
  const deadline = fact('The lease ends 1 March 2027', { date: '2027-03-01' });

  assert.equal(nextOccurrence(deadline, new Date(2027, 1, 1)).days, 28);
  assert.equal(nextOccurrence(deadline, new Date(2027, 2, 2)), null);
});

test('29 February stays in February', () => {
  const leap = fact('Anniversary', { date: '2024-02-29', recurs: 'yearly' });
  const next = nextOccurrence(leap, new Date(2026, 0, 1));

  assert.equal(next.date.getMonth(), 1, 'must not roll into March');
  assert.equal(next.date.getDate(), 28);
});

test('a fact with no date is never upcoming', () => {
  assert.equal(nextOccurrence(fact('Emily likes chocolate'), new Date()), null);
  // `recurs` without a date means nothing and must not be invented into one.
  assert.equal(nextOccurrence(fact('x', { recurs: 'yearly' }), new Date()), null);
});

test('a mention needs whole words, not accidental substrings', () => {
  const birthday = fact("Emily's birthday is 20 October", { date: '2002-10-20', recurs: 'yearly' });

  // "redis" contains "is"; substring matching once made that a birthday mention.
  assert.equal(mentionScore('Decided to drop redis, memcached is faster', birthday), 0);
  assert.ok(mentionScore('Got Emily a birthday present', birthday) >= 2);
  assert.equal(mentionScore('Emily called', birthday), 1);
});

test('terms too ordinary to identify a fact are not terms', () => {
  assert.deepEqual(factTerms('The user likes chocolate'), ['chocolate']);
  // The possessive is stripped, so "got Emily a present" still counts.
  assert.deepEqual(factTerms("Emily's birthday is 20 October"), ['emily', 'birthday', 'october']);
});

test('anything in the timeline with a date is a dated thing', () => {
  const reminder = createEntry({
    body: 'call the dentist',
    kind: 'reminder',
    title: 'call the dentist',
    extra: reminderExtra({ date: '2026-08-10' }),
  });
  const item = toDated(reminder);
  assert.equal(item.date, '2026-08-10');
  assert.equal(item.text, 'call the dentist');
  assert.deepEqual(item.from, [], 'a reminder has no sources to exclude');

  // A note somebody typed `date:` into by hand is the same thing, on purpose.
  const handWritten = createEntry({ body: 'Lease renewal', kind: 'note', extra: { date: '2027-03-01' } });
  assert.equal(toDated(handWritten).date, '2027-03-01');

  // Undated, done, and retired are all "nothing to count down to".
  assert.equal(toDated(createEntry({ body: 'lunch was fine', kind: 'log' })), null);
  assert.equal(toDated(createEntry({ body: 'x', extra: { date: '2026-08-10', status: 'done' } })), null);
  assert.equal(toDated(createEntry({ body: 'x', extra: { date: '2026-08-10', status: 'retired' } })), null);
  assert.equal(toDated(createEntry({ body: 'x', extra: { date: 'someday' } })), null);
});

test('a missed intention stays visible for a grace window, and a fact does not', () => {
  const item = toDated(
    createEntry({ body: 'call the dentist', kind: 'reminder', extra: reminderExtra({ date: '2026-08-01' }) }),
  );

  // Without a window a past date is simply gone — what `ppr brief` has always
  // done with a fact whose day went by.
  assert.equal(nextOccurrence(item, new Date(2026, 7, 8)), null);

  const overdue = nextOccurrence(item, new Date(2026, 7, 8), { graceDays: 7 });
  assert.equal(overdue.days, -7, 'negative days is how overdue is said');
  assert.equal(overdue.date.getDate(), 1);

  // One day past the window and it stops asking.
  assert.equal(nextOccurrence(item, new Date(2026, 7, 9), { graceDays: 7 }), null);
  // The day itself is not overdue.
  assert.equal(nextOccurrence(item, new Date(2026, 7, 1), { graceDays: 7 }).days, 0);
});

test('a birthday with no known year recurs but claims no ordinal', () => {
  const unknown = fact("Priya's birthday is 12 September", { date: '0000-09-12', recurs: 'yearly' });
  const next = nextOccurrence(unknown, new Date(2026, 7, 8));

  assert.equal(next.date.getMonth(), 8);
  assert.equal(next.date.getDate(), 12);
  assert.equal(next.date.getFullYear(), 2026);
  assert.equal(next.ordinal, undefined, 'it cannot know which birthday this is');
});
