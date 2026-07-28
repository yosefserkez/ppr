import test from 'node:test';
import assert from 'node:assert/strict';
import { suggest } from '../dist/suggest.js';

const COMMANDS = [
  'write', 'w', '+', 'dump', 'd', 'clip', 'c', 'voice', 'v', 'append', 'a',
  'ls', 'list', 'today', 'week', 'search', 'find', 'show', 'cat', 'edit',
  'rm', 'delete', 'tags', 'links', 'path', 'text', 'stats', 'export',
  'recap', 'ask', 'memory', 'mem', 'init', 'setup', 'config', 'ai',
  'doctor', 'reindex', 'browse', 'b',
];

test('a mistyped command finds its neighbour', () => {
  assert.equal(suggest('serach', COMMANDS), 'search');
  assert.equal(suggest('lsit', COMMANDS), 'list');
  assert.equal(suggest('docter', COMMANDS), 'doctor');
  assert.equal(suggest('setpu', COMMANDS), 'setup');
  assert.equal(suggest('recpa', COMMANDS), 'recap');
});

test('case does not matter', () => {
  assert.equal(suggest('SEARCH', COMMANDS), 'search');
  assert.equal(suggest('Doctor', COMMANDS), 'doctor');
});

test('ordinary words are not mistaken for commands', () => {
  // A wrong suggestion turns a real note into an error, so these must all pass
  // through. "redis" is two plain edits from "edit" — counting transpositions
  // separately is what keeps it from matching.
  const words = ['had', 'lunch', 'shipped', 'tired', 'meeting', 'redis', 'deployed',
                 'done', 'okay', 'note', 'call', 'bug', 'ship', 'read'];
  for (const word of words) {
    assert.equal(suggest(word, COMMANDS), undefined, `${word} should not look like a command`);
  }
});

test('input too short to judge is left alone', () => {
  for (const word of ['', 'a', 'ok', 'hi']) {
    assert.equal(suggest(word, COMMANDS), undefined);
  }
});

test('the closest candidate wins', () => {
  assert.equal(suggest('lst', ['ls', 'list', 'last']), 'ls');
});

test('nothing similar means no suggestion', () => {
  assert.equal(suggest('qwertyuiop', COMMANDS), undefined);
  assert.equal(suggest('', COMMANDS), undefined);
});
