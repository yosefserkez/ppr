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

test('parseWhen resolves the phrases a reminder is actually typed in', () => {
  // A Monday, so every weekday case has a known answer.
  const now = new Date(2026, 6, 27, 15, 0, 0);
  const day = (when) => {
    const d = parseWhen(when, now);
    return d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  for (const [input, expected] of [
    ['tonight', '2026-07-27'],
    ['this evening', '2026-07-27'],
    ['tomorrow', '2026-07-28'],
    // A bare weekday is the next one, forwards.
    ['friday', '2026-07-31'],
    ['fri', '2026-07-31'],
    ['sunday', '2026-08-02'],
    // Today is Monday: "monday" is the one coming, never the one you are in.
    ['monday', '2026-08-03'],
    // "next friday" says the same thing as "friday" on purpose — no reading of
    // it surprises everybody, and two spellings that disagree surprise more.
    ['next friday', '2026-07-31'],
    ['this friday', '2026-07-31'],
    ['last friday', '2026-07-24'],
    ['last monday', '2026-07-20'],
    ['in 3 days', '2026-07-30'],
    ['in 1 day', '2026-07-28'],
    ['in 2 weeks', '2026-08-10'],
    ['in a week', '2026-08-03'],
    ['in 6 months', '2027-01-27'],
    ['in a year', '2027-07-27'],
    ['next week', '2026-08-02'],
    ['next month', '2026-08-01'],
    ['next year', '2027-01-01'],
    // Still the old behaviour, which the filter flags depend on.
    ['today', '2026-07-27'],
    ['7d', '2026-07-20'],
    ['2026-10-20', '2026-10-20'],
    // Not a date, however much English it is.
    ['dentist', null],
    ['call mum', null],
    ['in 3 dentists', null],
    ['someday', null],
    ['', null],
  ]) {
    assert.equal(day(input), expected, `parseWhen(${JSON.stringify(input)})`);
  }

  // Month arithmetic clamps rather than overflowing: 31 January plus a month
  // is the end of February, not the third of March.
  const endOfJanuary = new Date(2027, 0, 31, 9, 0, 0);
  const inAMonth = parseWhen('in 1 month', endOfJanuary);
  assert.equal(inAMonth.getMonth(), 1);
  assert.equal(inAMonth.getDate(), 28);
});
