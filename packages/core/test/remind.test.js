import test from 'node:test';
import assert from 'node:assert/strict';
import { futureWhen, parseReminder, reminderExtra } from '../dist/index.js';

/** A Monday, so every weekday phrase below has one right answer. */
const NOW = new Date(2026, 6, 27, 15, 0, 0);

const read = (input) => parseReminder(input, NOW);

test('a reminder is read the way people actually type one', () => {
  for (const [input, date, text] of [
    // The command form: the day first, then the thing.
    ['tomorrow call the dentist', '2026-07-28', 'call the dentist'],
    ['friday call the dentist', '2026-07-31', 'call the dentist'],
    ['next friday call the dentist', '2026-07-31', 'call the dentist'],
    ['in 3 days water the plants', '2026-07-30', 'water the plants'],
    ['2026-10-20 send the invoice', '2026-10-20', 'send the invoice'],
    ['20 october send the invoice', '2026-10-20', 'send the invoice'],
    ['oct 20 send the invoice', '2026-10-20', 'send the invoice'],
    // The quoted form, both ways round, with and without punctuation.
    ['remind me tomorrow: call the dentist', '2026-07-28', 'call the dentist'],
    ['remind me tomorrow to call the dentist', '2026-07-28', 'call the dentist'],
    ['remind me to call the dentist tomorrow', '2026-07-28', 'call the dentist'],
    ['remind me to call the dentist on friday', '2026-07-31', 'call the dentist'],
    ['Remind me next monday to review the roadmap', '2026-08-03', 'review the roadmap'],
    ['remind tomorrow to pay rent', '2026-07-28', 'pay rent'],
    // A bare duration means forwards here. `--since 7d` still means backwards.
    ['7d chase the invoice', '2026-08-03', 'chase the invoice'],
  ]) {
    const parsed = read(input);
    assert.equal(parsed.date, date, `date of ${JSON.stringify(input)}`);
    assert.equal(parsed.text, text, `text of ${JSON.stringify(input)}`);
    assert.equal(parsed.recurs, undefined);
  }
});

test('a reminder that repeats says so, and only yearly', () => {
  const yearly = read('remind me every year on 20 october to call mum');
  assert.equal(yearly.date, '2026-10-20');
  assert.equal(yearly.recurs, 'yearly');
  assert.equal(yearly.text, 'call mum');

  // Recurrence with nothing to recur from is not a date, so it is dropped.
  const undated = read('remind me every year to call mum');
  assert.equal(undated.date, undefined);
  assert.equal(undated.recurs, undefined);
  assert.equal(undated.text, 'call mum');
});

test('a line with no date keeps every word and claims no day', () => {
  for (const input of [
    'remind me to call the dentist',
    'remind me about the thing we discussed',
    'remind me 2 things about the deploy',
    'call mum sometime',
  ]) {
    const parsed = read(input);
    assert.equal(parsed.date, undefined, `should find no date in ${JSON.stringify(input)}`);
    assert.ok(parsed.text.length, 'the words survive regardless');
  }
  // `new Date('2')` is 1 February 2001; digits alone are a count, not a day.
  assert.equal(read('remind me 2 things about the deploy').text, '2 things about the deploy');
});

test('a day inferred from a sentence is never one that has already gone', () => {
  // "…the end of the month" ended on `month`, which means the *first* of it to
  // `--since` — so the reminder arrived already a week overdue.
  const expenses = read('remind me to file expenses before the end of the month');
  assert.equal(expenses.date, undefined);
  assert.match(expenses.text, /file expenses/);

  for (const input of ['remind me last friday to call mum', 'remind me yesterday to call mum']) {
    assert.equal(read(input).date, undefined, input);
  }
  // Today is still a day someone can mean.
  assert.equal(read('remind me today to call mum').date, '2026-07-27');
});

test('a date in the middle of a sentence is a sentence', () => {
  // Only the ends are read. Guessing at a date buried in prose is how a note
  // about the friday deploy would acquire a due date it never asked for.
  const parsed = read('remind me the friday deploy broke the importer again');
  assert.equal(parsed.date, undefined);
  assert.match(parsed.text, /friday deploy broke/);
});

test('a month and day resolve forwards, never to the year 2001', () => {
  // `new Date('20 October')` answers 2001, which is why this is not parseWhen.
  assert.equal(futureWhen('20 october', NOW).getFullYear(), 2026);
  // Already gone this year, so it means next year's.
  assert.equal(futureWhen('1 march', NOW).getFullYear(), 2027);
  assert.equal(futureWhen('feb 30', NOW), null, 'there is no such day');
  // A duration is forwards here, where `parseWhen` reads it backwards.
  assert.equal(futureWhen('7d', NOW).getDate(), 3);
});

test('reminder frontmatter leaves out what it does not have', () => {
  assert.deepEqual(reminderExtra({ date: '2026-08-10' }), { date: '2026-08-10' });
  assert.deepEqual(reminderExtra({ date: '2026-08-10', recurs: 'yearly', status: 'done' }), {
    date: '2026-08-10',
    recurs: 'yearly',
    status: 'done',
  });
  // Recurrence with no date would be a rule about nothing.
  assert.deepEqual(reminderExtra({ recurs: 'yearly' }), {});
});
