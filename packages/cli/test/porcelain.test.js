import test from 'node:test';
import assert from 'node:assert/strict';
import { briefNotification, pushDecision } from '../dist/porcelain.js';

/**
 * The decisions only. Nothing here posts a banner or creates a reminder: the
 * pure/executor split exists so the half that can be wrong runs on any
 * machine, including one with no plugin installed on it.
 */

/** An `Upcoming`, cut down to what the notification actually reads. */
const item = (text, days, date) => ({
  item: { id: 'x', text },
  date: new Date(date),
  days,
  mentions: [],
});

test('a banner carries the soonest thing and says how much is behind it', () => {
  const banner = briefNotification([
    item('call the dentist', -3, '2026-08-05T00:00:00'),
    item("Emily's birthday", 12, '2026-08-20T00:00:00'),
    item('the lease ends', 25, '2026-09-02T00:00:00'),
  ]);
  assert.equal(banner.title, 'ppr · call the dentist');
  assert.match(banner.body, /3 days overdue/);
  // Not a lie about how much is waiting, and not five things nobody reads.
  assert.match(banner.body, /· 2 more$/);
});

test('one thing coming up does not claim there are others', () => {
  const banner = briefNotification([item('pay the rent', 1, '2026-08-09T00:00:00')]);
  assert.equal(banner.title, 'ppr · pay the rent');
  assert.doesNotMatch(banner.body, /more/);
});

test('a title too long for a banner is cut before macOS cuts it', () => {
  const banner = briefNotification([
    item(
      'renew the domain registration and also update the billing address on the account',
      2,
      '2026-08-10T00:00:00',
    ),
  ]);
  // Roughly one line. Beyond this the OS truncates without ceremony and the
  // useful half of the sentence is the half that disappears.
  assert.ok(banner.title.length <= 54, `too long: ${banner.title.length}`);
  assert.match(banner.title, /^ppr · renew the domain/);
  assert.match(banner.title, /…$/);
});

test('nothing upcoming is nothing to post', () => {
  // A daily "nothing coming up" ping trains people to ignore the channel, and
  // the one that mattered gets ignored with it.
  assert.equal(briefNotification([]), null);
});

test('a reminder only leaves the vault when something says it may', () => {
  const base = { dated: true, available: true };
  assert.deepEqual(pushDecision({ ...base, configured: true }), { push: true });
  assert.deepEqual(pushDecision({ ...base, configured: false, asked: true }), { push: true });

  // Off by default: pushing into another app is not something ppr does to you.
  assert.deepEqual(pushDecision({ ...base, configured: false }), { push: false, reason: 'off' });
  // An instruction wins over the config it disagrees with.
  assert.deepEqual(pushDecision({ ...base, configured: true, asked: false }), {
    push: false,
    reason: 'refused',
  });
});

test('a line with no day is never pushed, however loudly it was asked for', () => {
  // It is a todo, and a todo has no moment for anything over there to ring
  // at — so `--push` cannot conjure a reminder out of it.
  assert.deepEqual(pushDecision({ configured: true, asked: true, dated: false, available: true }), {
    push: false,
    reason: 'undated',
  });
});

test('asking for a push with nothing to push with is answered, not dropped', () => {
  // This used to ask "is this a Mac". It now asks "is there a program on PATH
  // that does this" — the same question, without ppr having to know the answer
  // for every operating system there is.
  assert.deepEqual(pushDecision({ configured: true, dated: true, available: false }), {
    push: false,
    reason: 'unavailable',
  });
  // With nothing switched on there is nothing to explain, so whether the tool
  // exists never comes up.
  assert.deepEqual(pushDecision({ configured: false, dated: true, available: false }), {
    push: false,
    reason: 'off',
  });
});
