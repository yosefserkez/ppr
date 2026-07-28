import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsFollowUps } from '../dist/commands/capture.js';

test('a one-liner is never interrogated', () => {
  // `ppr "shipped it"` and `ppr + shipped it` are the same act, and the whole
  // point of both is that they cost nothing.
  assert.equal(wantsFollowUps({}), false);
  assert.equal(wantsFollowUps({ composed: false }), false);
});

test('an interactive compose session asks', () => {
  assert.equal(wantsFollowUps({ composed: true }), true);
});

test('--ask opts a one-liner in', () => {
  assert.equal(wantsFollowUps({ demanded: true }), true);
});

test('--no-follow wins over everything', () => {
  assert.equal(wantsFollowUps({ refused: true, demanded: true }), false);
  assert.equal(wantsFollowUps({ refused: true, composed: true }), false);
});
