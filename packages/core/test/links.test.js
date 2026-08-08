import test from 'node:test';
import assert from 'node:assert/strict';
import { autoLink } from '../dist/index.js';

const VOCAB = ['emily', 'redis migration', 'redis', 'sam'];

test('the first mention of a known name is linked, and only the first', () => {
  const out = autoLink('Emily called. Emily wants a present.', VOCAB);
  assert.equal(out, '[[Emily]] called. Emily wants a present.');
});

test('the name keeps the capitalisation it was written with', () => {
  assert.equal(autoLink('spoke to SAM today', VOCAB), 'spoke to [[SAM]] today');
});

test('the longest matching name wins', () => {
  assert.match(autoLink('the redis migration went badly', VOCAB), /\[\[redis migration\]\]/);
});

test('a name inside a word is not a name', () => {
  // "sam" inside "same", "redis" inside "redistribute".
  assert.equal(autoLink('the same redistribution', VOCAB), 'the same redistribution');
});

test('code, links, headings, and URLs are left exactly as written', () => {
  const body = [
    '# Emily',
    'Ask `emily --help` about it.',
    '```',
    'const emily = 1;',
    '```',
    'See [Emily](https://example.com/emily) and https://x.com/emily too.',
    'Then tell Emily.',
  ].join('\n');
  const out = autoLink(body, VOCAB);

  assert.match(out, /^# Emily$/m, 'a heading is a title, not prose');
  assert.match(out, /`emily --help`/);
  assert.match(out, /const emily = 1;/);
  assert.match(out, /\[Emily\]\(https:\/\/example\.com\/emily\)/);
  assert.match(out, /https:\/\/x\.com\/emily/);
  // The one real mention still gets linked.
  assert.match(out, /Then tell \[\[Emily\]\]\./);
});

test('a link that is already there is not linked again', () => {
  assert.equal(autoLink('[[Emily]] and Emily', VOCAB), '[[Emily]] and Emily');
});

test('an empty vocabulary changes nothing', () => {
  assert.equal(autoLink('Emily called.', []), 'Emily called.');
  // Two characters is not a name worth hunting for across a whole vault.
  assert.equal(autoLink('a bc d', ['bc']), 'a bc d');
});
