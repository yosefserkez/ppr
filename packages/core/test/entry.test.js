import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntry,
  parseEntry,
  serializeEntry,
  applyPatch,
  extractTags,
  extractLinks,
  titleFromBody,
  slugify,
  parseWhen,
  parseDuration,
  createId,
  timeFromId,
  parseDocument,
} from '../dist/index.js';

test('an entry survives a serialize/parse round trip', () => {
  const entry = createEntry({
    body: 'Dropped the legacy auth path. See [[redis migration]] #infra #decision',
    kind: 'log',
    source: 'https://example.com',
  });
  const parsed = parseEntry(entry.path, serializeEntry(entry));

  assert.equal(parsed.id, entry.id);
  assert.equal(parsed.title, entry.title);
  assert.equal(parsed.body, entry.body);
  assert.equal(parsed.kind, 'log');
  assert.equal(parsed.source, 'https://example.com');
  assert.deepEqual(parsed.tags, ['decision', 'infra']);
  assert.deepEqual(parsed.links, ['redis migration']);
});

test('unknown frontmatter keys are preserved, not dropped', () => {
  const raw = ['---', 'id: abc', 'title: Test', 'mood: focused', 'obsidian_flag: true', '---', '', 'Body text.'].join('\n');
  const parsed = parseEntry('entries/x.md', raw);
  assert.equal(parsed.extra.mood, 'focused');
  assert.equal(parsed.extra.obsidian_flag, true);
  assert.match(serializeEntry(parsed), /mood: focused/);
});

test('a file with broken frontmatter keeps its body', () => {
  const raw = '---\nthis: is: not: valid: yaml:\n---\n\nThe words still matter.';
  const doc = parseDocument(raw);
  assert.equal(doc.body, 'The words still matter.');
  const entry = parseEntry('entries/2026/07/2026-07-27-1200-note-ab12.md', raw);
  assert.equal(entry.body, 'The words still matter.');
});

test('a hand-written file with no frontmatter is adopted', () => {
  const entry = parseEntry('entries/2026/03/2026-03-04-0915-hand-written-zz99.md', '# Hand written\n\nJust markdown.');
  assert.equal(entry.title, 'Hand written');
  assert.equal(new Date(entry.created).getFullYear(), 2026);
  assert.equal(new Date(entry.created).getMonth(), 2);
  assert.ok(entry.id);
});

test('tags and links ignore code spans and markdown headings', () => {
  const body = ['# A heading', 'Real #tag here and #nested/tag.', '`#notatag`', '```', '#alsonot [[nope]]', '```', '[[real link]]'].join('\n');
  assert.deepEqual(extractTags(body).sort(), ['nested/tag', 'tag']);
  assert.deepEqual(extractLinks(body), ['real link']);
});

test('titles come from headings, then sentences, minus the tags', () => {
  assert.equal(titleFromBody('## Ship it\n\nmore text'), 'Ship it');
  assert.equal(titleFromBody('Rolled back the deploy. Twice, in fact.'), 'Rolled back the deploy');
  assert.equal(titleFromBody('shipped the migration #infra'), 'shipped the migration');
});

test('patching retitles the file path and bumps updated', () => {
  const entry = createEntry({ body: 'first', title: 'First title' });
  const patched = applyPatch(entry, { title: 'Second title' }, new Date(Date.now() + 1000));
  assert.match(patched.path, /second-title/);
  assert.notEqual(patched.updated, entry.updated);
  assert.equal(patched.id, entry.id);
});

test('slugs are filename-safe and stripped of accents', () => {
  assert.equal(slugify('Café — déjà vu!'), 'cafe-deja-vu');
  assert.equal(slugify(''), '');
  assert.ok(slugify('a'.repeat(200)).length <= 48);
});

test('ids sort by time and stay unique', () => {
  const early = createId(new Date('2020-01-01'));
  const late = createId(new Date('2030-01-01'));
  assert.ok(early < late);
  assert.equal(timeFromId(early).getUTCFullYear(), 2020);

  const batch = new Set(Array.from({ length: 500 }, () => createId()));
  assert.equal(batch.size, 500);
});

test('parseWhen understands the ways people name a moment', () => {
  const now = new Date('2026-07-27T15:00:00');
  assert.equal(parseWhen('today', now).getDate(), 27);
  assert.equal(parseWhen('yesterday', now).getDate(), 26);
  assert.equal(parseWhen('7d', now).getDate(), 20);
  assert.equal(parseWhen('2h', now).getHours(), 13);
  assert.equal(parseWhen('2026-07-01', now).getMonth(), 6);
  assert.equal(parseWhen('gibberish', now), null);
  assert.equal(parseDuration('3w'), 3 * 7 * 86400000);
});
