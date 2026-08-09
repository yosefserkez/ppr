import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHooks } from '../dist/hooks.js';

/**
 * What a `hooks` block means, with no config file and no subprocess involved.
 * Whether a hook is allowed to come from a vault is the integration test in
 * cli.test.js — it is a claim about a whole ppr run, not about this function.
 */

test('a hook table is read as event name to commands', () => {
  assert.deepEqual(parseHooks({ 'entry.created': ['ppr-reminders-push'] }), {
    'entry.created': ['ppr-reminders-push'],
  });
  // One command is a list of one: nobody should have to remember which.
  assert.deepEqual(parseHooks({ 'entry.created': 'ppr-reminders-push' }), {
    'entry.created': ['ppr-reminders-push'],
  });
  assert.deepEqual(parseHooks({ 'learn.finished': ['a', 'b'] })['learn.finished'], ['a', 'b']);
});

test('a name ppr does not emit runs nothing at all', () => {
  // A typo in an event name is silent, which is the safe direction: the other
  // one is guessing which event somebody meant and running their shell for it.
  assert.deepEqual(parseHooks({ 'entry.create': ['rm -rf /'] }), {});
  assert.deepEqual(parseHooks({ 'reminder.created': ['x'] }), {}, 'kinds are a filter, not a name');
});

test('nonsense in the file is ignored rather than obeyed or fatal', () => {
  for (const raw of [null, undefined, 'hooks', 42, ['entry.created']]) {
    assert.deepEqual(parseHooks(raw), {});
  }
  assert.deepEqual(parseHooks({ 'entry.created': [42, '', '  ', null] }), {});
  assert.deepEqual(parseHooks({ 'entry.created': ['  ppr-notify  ', 7] }), {
    'entry.created': ['ppr-notify'],
  });
});
