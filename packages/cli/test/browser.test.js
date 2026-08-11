import test from 'node:test';
import assert from 'node:assert/strict';
import { PprError } from '@ppr/core';
import { Browser } from '../dist/ui/browser.js';

/**
 * The shell around the reducer: what happens when an effect's vault write
 * fails. No terminal is involved — the browser's Screen is never entered, and
 * `draw()` is a no-op while it is closed — so the key loop is driven directly
 * against a stub vault.
 */

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

const stubVault = (entries, over = {}) => ({
  root: '/nowhere',
  config: { capture: { defaultKind: 'log' } },
  now: () => new Date('2026-07-27T12:00:00-07:00'),
  all: () => entries,
  lenses: () => [],
  refresh: async () => {},
  ...over,
});

const key = (name) => ({ name });

test('a delete that fails is shown in the footer instead of killing the session', async () => {
  const doomed = entry('a1', 'Doomed');
  const vault = stubVault([doomed], {
    remove: async () => {
      throw new PprError('EINVALID', 'the file is read-only');
    },
  });
  const browser = new Browser(vault, 'all', [doomed]);

  await browser.handle(key('x'));
  await browser.handle(key('y'));

  assert.equal(browser.state.done, false, 'the browser stays open');
  assert.equal(browser.state.status, 'the file is read-only');
});

test('an unexpected failure still leaves the browser taking keys', async () => {
  const entries = [entry('a1', 'One'), entry('a2', 'Two')];
  const vault = stubVault(entries, {
    remove: async () => {
      throw new TypeError('cannot read properties of undefined');
    },
  });
  const browser = new Browser(vault, 'all', entries);

  await browser.handle(key('x'));
  await browser.handle(key('y'));
  assert.equal(browser.state.status, 'could not do that');
  assert.equal(browser.state.done, false);

  await browser.handle(key('j'));
  assert.equal(browser.state.stack[0].cursor, 1, 'the cursor still moves afterwards');
});
