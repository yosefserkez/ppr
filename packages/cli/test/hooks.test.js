import test from 'node:test';
import assert from 'node:assert/strict';
import { CHILD_DEPTH_ENV } from '../dist/child.js';
import { hookRunner, parseHooks } from '../dist/hooks.js';

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

/**
 * The fan-out stops at one generation. What a hook does with the vault is its
 * business; what it may not do is set the whole machinery going again, because
 * hooks come from the user layer and therefore apply to every vault — so a
 * hook that logs into a *second* vault is the fork bomb too. The end-to-end
 * proof is in cli.test.js; this is the rule itself.
 */
test('a ppr running inside a hook wires no hooks of its own', () => {
  const hooks = { 'entry.created': ['ppr-notify'] };
  assert.equal(typeof hookRunner(hooks), 'function');

  const before = process.env[CHILD_DEPTH_ENV];
  try {
    process.env[CHILD_DEPTH_ENV] = '1';
    assert.equal(hookRunner(hooks), undefined);
    // Junk in the marker is not a licence to fan out; it is also not a crash.
    process.env[CHILD_DEPTH_ENV] = 'nonsense';
    assert.equal(typeof hookRunner(hooks), 'function');
  } finally {
    if (before === undefined) delete process.env[CHILD_DEPTH_ENV];
    else process.env[CHILD_DEPTH_ENV] = before;
  }
});
