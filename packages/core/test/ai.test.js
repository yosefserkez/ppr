import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Vault,
  MemoryStorage,
  DEFAULT_CONFIG,
  tasks,
  toFact,
  heuristicDistill,
  parseJsonLoose,
  extractFromHtml,
} from '../dist/index.js';

/** A scripted model, so the AI paths are testable without a network or a GPU. */
function fakeProvider(reply, { record } = {}) {
  return {
    id: 'fake',
    model: 'fake-1',
    local: true,
    async generate(req) {
      record?.push(req);
      return typeof reply === 'function' ? reply(req) : reply;
    },
  };
}

async function makeVault({ provider, fetcher, config } = {}) {
  const storage = new MemoryStorage();
  const vault = await Vault.open({
    root: '/memory',
    storage,
    config: structuredClone({ ...DEFAULT_CONFIG, ...config }),
    provider,
    fetcher,
  });
  return vault;
}

test('distill uses the model when it returns usable JSON', async () => {
  const provider = fakeProvider(
    JSON.stringify({ title: 'Drop legacy auth', body: '- Legacy auth is dead\n- Tell Sam', tags: ['auth', 'cleanup'] }),
  );
  const result = await tasks.distill('um so like we should drop legacy auth', { provider });

  assert.equal(result.ai, true);
  assert.equal(result.title, 'Drop legacy auth');
  assert.deepEqual(result.tags, ['auth', 'cleanup']);
});

test('a model that returns garbage never costs you the dump', async () => {
  for (const bad of ['', 'I am so sorry, I cannot help with that.', '{"title": "x"', 'null']) {
    const result = await tasks.distill('the original words are here and must survive', {
      provider: fakeProvider(bad),
    });
    assert.equal(result.ai, false, `expected fallback for: ${bad}`);
    assert.match(result.body, /original words/);
  }
});

test('distill falls back to heuristics with no provider at all', async () => {
  const result = await tasks.distill('um, so basically i shipped it. it works now. tell the team.');
  assert.equal(result.ai, false);
  assert.match(result.body, /shipped it/);
  assert.doesNotMatch(result.body, /\bum\b/i);
});

test('JSON is recovered from fences and surrounding prose', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! Here you go: {"a":[1,2]} Hope that helps.'), { a: [1, 2] });
  assert.deepEqual(parseJsonLoose('{"quote":"a } brace inside"}'), { quote: 'a } brace inside' });
  assert.equal(parseJsonLoose('no json at all'), null);
});

test('the offline distiller strips filler without eating content', () => {
  const { body } = heuristicDistill('um, so basically i was thinking, like, we should ship. it is ready. sam agrees.');
  assert.doesNotMatch(body, /\bum\b/i);
  assert.doesNotMatch(body, /like,/i);
  assert.match(body, /ship/);
  assert.match(body, /ready/);
  assert.match(body, /Sam agrees|sam agrees/i);
});

test('dump routes a bare URL to the clip pipeline', async () => {
  const fetcher = async () => ({
    status: 200,
    contentType: 'text/html',
    url: 'https://example.com/post',
    body: '<html><head><title>Real Title</title></head><body><article><p>The actual content of the page.</p></article></body></html>',
  });
  const vault = await makeVault({
    fetcher,
    provider: fakeProvider(JSON.stringify({ title: 'Real Title', body: 'The actual content.', tags: ['web'] })),
  });

  const entry = await vault.dump('https://example.com/post');
  assert.equal(entry.kind, 'clip');
  assert.equal(entry.source, 'https://example.com/post');
  assert.match(entry.body, /example\.com/);
});

test('clip degrades to raw extraction when there is no model', async () => {
  const fetcher = async () => ({
    status: 200,
    contentType: 'text/html',
    url: 'https://example.com',
    body: '<html><head><title>Plain</title></head><body><p>Body words here.</p><script>ignore()</script></body></html>',
  });
  const vault = await makeVault({ fetcher });
  const entry = await vault.clip('https://example.com');

  assert.equal(entry.kind, 'clip');
  assert.match(entry.body, /Body words here/);
  assert.doesNotMatch(entry.body, /ignore\(\)/);
});

test('html extraction prefers article content and drops chrome', () => {
  const page = extractFromHtml(
    `<html><head><title>T</title><meta name="description" content="A description"></head>
     <body><nav>menu menu menu</nav><article>${'<p>Real sentence.</p>'.repeat(30)}</article><footer>legal</footer></body></html>`,
  );
  assert.equal(page.title, 'T');
  assert.equal(page.description, 'A description');
  assert.match(page.text, /Real sentence/);
  assert.doesNotMatch(page.text, /menu menu/);
  assert.doesNotMatch(page.text, /legal/);
});

test('ask cites entry ids and passes them to the model', async () => {
  const seen = [];
  const vault = await makeVault({
    provider: fakeProvider((req) => `We dropped redis because of latency [${/\[(\w{16})\]/.exec(req.prompt)?.[1]}]`, { record: seen }),
  });
  const entry = await vault.add({ body: 'Dropped redis, latency was worse than memcached', kind: 'log' });

  const answer = await vault.ask('why did we drop redis?');
  assert.equal(answer.ai, true);
  assert.deepEqual(answer.cited, [entry.id]);
  assert.match(seen[0].prompt, /why did we drop redis/);
});

test('what ppr knows is always in the answer, not only when the words match', async () => {
  const seen = [];
  const vault = await makeVault({ provider: fakeProvider('answer', { record: seen }) });
  await vault.addFact("Emily's birthday is 20 October");
  await vault.add({ body: 'Unrelated note about the deploy', kind: 'log' });

  // Shares no word with the fact but the name — lexical retrieval alone would
  // miss it, which is exactly the case a memory layer has to survive.
  const answer = await vault.ask('is anything coming up for Emily?');
  assert.match(seen[0].prompt, /Standing facts/);
  assert.match(seen[0].prompt, /20 October/);
  assert.equal(answer.facts.length, 1);
});

test('follow-up questions see what is already known', async () => {
  const seen = [];
  const vault = await makeVault({ provider: fakeProvider(JSON.stringify({ questions: ['q?'] }), { record: seen }) });
  await vault.addFact('Emily likes chocolate');

  await vault.followUps('bought a birthday present');
  assert.match(seen[0].prompt, /Known facts/);
  assert.match(seen[0].prompt, /chocolate/);
});

test('with no model, ask still surfaces the facts it holds', async () => {
  const vault = await makeVault();
  await vault.addFact("Emily's birthday is 20 October");

  const answer = await vault.ask('emily');
  assert.equal(answer.ai, false);
  assert.match(answer.text, /20 October/);
});

test('ask still returns the right entries with no model', async () => {
  const vault = await makeVault();
  await vault.add({ body: 'Dropped redis for latency reasons' });
  await vault.add({ body: 'Unrelated note about lunch' });

  const answer = await vault.ask('redis');
  assert.equal(answer.ai, false);
  assert.equal(answer.used[0].body, 'Dropped redis for latency reasons');
});

test('recap falls back to a grouped list without a model', async () => {
  const vault = await makeVault();
  await vault.add({ body: 'Did a thing', title: 'Did a thing' });
  const result = await vault.recap(vault.list());

  assert.equal(result.ai, false);
  assert.match(result.text, /Did a thing/);
});

/**
 * The learn pipeline makes two calls: extract, then reconcile. Answering each
 * by what the system prompt asks for keeps the scripts readable.
 */
function learnProvider({ facts = [], verdicts = [] } = {}) {
  return fakeProvider((req) =>
    /Decide how each candidate/.test(req.system)
      ? JSON.stringify({ verdicts })
      : JSON.stringify({ memories: facts }),
  );
}

test('memories are extracted once and never duplicated', async () => {
  const vault = await makeVault({
    provider: learnProvider({ facts: ['Prefers memcached over redis', 'Sam owns auth'] }),
  });

  const first = await vault.remember('some text');
  assert.equal(first.length, 2);
  assert.equal(first[0].kind, 'memory');

  // The model volunteers no verdicts. The exact-match floor still has to catch
  // the repeat, or a quiet model would double the store on every run.
  const second = await vault.remember('some text again');
  assert.equal(second.length, 0, 'the same fact must not be stored twice');
  assert.equal(vault.list({ kind: 'memory' }).length, 2);
});

test('entries the model garbles stay queued instead of being marked read', async () => {
  // The failure this prevents: a mangled reply reads exactly like "nothing
  // durable in here", so the mark advanced and those entries were never
  // offered to a model again.
  const vault = await makeVault({ provider: fakeProvider('{"memories": [ "fact\\": "],') });
  await vault.add({ body: 'Emily likes chocolate', kind: 'log' });

  const first = await vault.learn();
  assert.equal(first.unreadable, 1);
  assert.equal(first.learned.length, 0);

  vault.provider = learnProvider({ facts: ['Emily likes chocolate'] });
  const second = await vault.learn();
  assert.equal(second.scanned, 1, 'the entry is still in the window');
  assert.equal(second.learned.length, 1);
});

test('shards of a half-parsed response are not stored as facts', async () => {
  const vault = await makeVault({
    provider: learnProvider({
      facts: ['"from": ["', 'x', 'fact\\": "', '{', 'Emily likes chocolate'],
    }),
  });
  await vault.add({ body: 'note', kind: 'log' });
  const result = await vault.learn();

  assert.deepEqual(result.learned.map((e) => e.body), ['Emily likes chocolate']);
});

test('a fact that opens with a wikilink is a fact, not debris', async () => {
  // Found by the eval suite: with `capture.autoLink` on, every fact about a
  // person starts with `[[Their Name]]`, and the debris filter ate all of them.
  const vault = await makeVault({
    provider: learnProvider({ facts: ['[[Sam]] owns the auth service.'] }),
    config: { capture: { ...DEFAULT_CONFIG.capture, autoLink: true } },
  });
  await vault.add({ body: 'Sam owns auth', kind: 'log' });
  const result = await vault.learn();

  assert.equal(result.learned.length, 1);
  assert.equal(result.learned[0].body, '[[Sam]] owns the auth service.');
  assert.deepEqual(result.learned[0].links, ['sam']);
});

test('the extraction budget grows with the batch it is given', async () => {
  // A fixed ceiling truncated the JSON on a real day of entries, and a
  // half-written object is indistinguishable from a model that failed — so a
  // backfill kept reporting "nothing durable" while the model answered fine.
  const seen = [];
  const vault = await makeVault({
    provider: fakeProvider(JSON.stringify({ memories: ['Emily likes chocolate'] }), { record: seen }),
  });
  await vault.add({ body: 'x'.repeat(6000), kind: 'log' });
  await vault.add({ body: 'short one', kind: 'log' });
  await vault.learn();

  const extraction = seen.find((req) => /durable facts/.test(req.system));
  assert.ok(extraction.maxTokens >= 3000, `budget was ${extraction.maxTokens} for a 6k-char batch`);
});

test('a batch too large for one prompt is split, and no entry is split with it', async () => {
  // The other half of the lossy backfill. A month of entries in one call fits
  // any context window and still extracts badly — attention per entry is the
  // scarce resource — so learn chunks at EXTRACT_CHUNK_CHARS. Nothing measured
  // that, which is how a batch size that reads two thirds of a vault shipped.
  const seen = [];
  const vault = await makeVault({
    provider: fakeProvider(JSON.stringify({ memories: [] }), { record: seen }),
  });

  const entries = [];
  for (let i = 0; i < 6; i++) {
    entries.push(
      await vault.add({
        kind: 'log',
        body:
          `Deploy note ${i}. ` +
          `The staging database is on postgres 14 and the search index moved to typesense. `.repeat(12),
      }),
    );
  }
  await vault.learn();

  const isExtraction = (req) => /durable facts/.test(req.system);
  const extractions = seen.filter(isExtraction);
  assert.ok(extractions.length > 1, `6 kilobytes of entries went out as ${extractions.length} call(s)`);

  for (const entry of entries) {
    const carrying = extractions.filter((req) => req.prompt.includes(`[${entry.id}]`));
    assert.equal(carrying.length, 1, `${entry.id} appeared in ${carrying.length} prompts`);
    // Whole, not clipped at the chunk boundary: half an entry is exactly the
    // kind of silent loss the chunking exists to prevent.
    assert.ok(carrying[0].prompt.includes(entry.body), 'the entry arrived truncated');
  }

  // Piped text is its own source with no entry id, so it gets its own call
  // rather than riding along in whichever chunk happened to be last.
  seen.length = 0;
  await vault.learn({ text: 'Rae took over billing from Sam.' });
  const piped = seen.filter(isExtraction);
  assert.equal(piped.length, 1);
  assert.match(piped[0].prompt, /Rae took over billing/);
});

test('facts live outside the journal tree', async () => {
  const vault = await makeVault({ provider: learnProvider({ facts: ['Emily likes chocolate'] }) });
  const [fact] = await vault.remember('emily likes chocolate');

  assert.match(fact.path, /^memory\/emily-likes-chocolate-\w{4}\.md$/);
});

test('a fact records which entries it came from', async () => {
  const vault = await makeVault({
    provider: fakeProvider((req) =>
      /Decide how each candidate/.test(req.system)
        ? JSON.stringify({ verdicts: [] })
        : JSON.stringify({
            memories: [{ fact: 'Emily likes chocolate', from: [/\[(\w{16})\]/.exec(req.prompt)?.[1]] }],
          }),
    ),
  });
  const source = await vault.add({ body: 'Emily likes chocolate', kind: 'log' });
  const result = await vault.learn();

  assert.equal(result.scanned, 1);
  assert.equal(result.learned.length, 1);
  const fact = toFact(result.learned[0]);
  assert.deepEqual(fact.from, [source.id]);
  assert.deepEqual(vault.sourcesOf(fact).map((e) => e.id), [source.id]);
});

test('an invented source id is not accepted as provenance', async () => {
  const vault = await makeVault({
    provider: learnProvider({ facts: [{ fact: 'Emily likes chocolate', from: ['0000000000000000'] }] }),
  });
  const source = await vault.add({ body: 'Emily likes chocolate', kind: 'log' });
  const result = await vault.learn();

  // Falls back to the batch, which is where the fact really came from.
  assert.deepEqual(toFact(result.learned[0]).from, [source.id]);
});

test('learn only reads what it has not read before', async () => {
  const vault = await makeVault({ provider: learnProvider({ facts: ['Sam owns auth'] }) });
  await vault.add({ body: 'Sam owns auth now', kind: 'log' });

  assert.equal((await vault.learn()).scanned, 1);
  const second = await vault.learn();
  assert.equal(second.scanned, 0, 'the same entry must not be re-read');
  assert.equal(second.learned.length, 0);

  await vault.add({ body: 'Rae owns billing', kind: 'log' });
  assert.equal((await vault.learn()).scanned, 1, 'a new entry is picked up');
  assert.equal((await vault.learn({ all: true })).scanned, 2, '--all ignores the mark');
});

test('a run over part of the journal does not declare the rest read', async () => {
  // `ppr memory learn <ref>` and `--since` read a window that can start after
  // the mark. Moving the mark to that window's newest entry writes off
  // everything in between, and nothing ever offers those entries to a model
  // again — the incremental learner's one way to lose your words (L20, L21).
  const vault = await makeVault({ provider: learnProvider({ facts: [] }) });
  const skipped = await vault.add({ body: 'Rae took over billing', kind: 'log' });
  const newest = await vault.add({ body: 'Sam owns auth now', kind: 'log' });

  await vault.learn({ entries: [vault.get(newest.id)] });
  assert.equal((await vault.learn()).scanned, 2, 'the entry beside it is still unread');

  const later = await vault.add({ body: 'Ana runs deploys', kind: 'log' });
  await vault.learn({ since: new Date(later.created) });
  assert.equal((await vault.learn()).scanned, 1, '--since does not move the mark either');
  assert.equal((await vault.learn()).scanned, 0, 'the incremental run still does');
  assert.ok(skipped.id < newest.id);
});

test('piped text the model garbles is reported, not counted as empty', async () => {
  const vault = await makeVault({ provider: fakeProvider('not json at all') });
  const result = await vault.learn({ text: 'Emily likes chocolate', entries: [] });

  assert.equal(result.learned.length, 0);
  assert.equal(result.unreadable, 1, 'a mangled reply is not "nothing durable in there"');
});

test('a refinement rewrites the fact and keeps both sources', async () => {
  const vault = await makeVault({ provider: learnProvider({ facts: ['Emily likes chocolate'] }) });
  const first = await vault.add({ body: 'emily likes chocolate', kind: 'log' });
  const [fact] = (await vault.learn()).learned;

  vault.provider = learnProvider({
    facts: ['Emily likes dark chocolate'],
    verdicts: [{ i: 1, verdict: 'refines', of: fact.id, text: 'Emily likes dark chocolate' }],
  });
  const second = await vault.add({ body: 'specifically dark chocolate', kind: 'log' });
  const result = await vault.learn();

  assert.equal(result.learned.length, 0);
  assert.equal(result.refined.length, 1);
  assert.equal(vault.facts().length, 1, 'a refinement replaces, it does not accumulate');
  assert.deepEqual(toFact(result.refined[0]).from, [first.id, second.id]);
});

test('a contradiction keeps both and settles nothing', async () => {
  const vault = await makeVault({ provider: learnProvider({ facts: ["Emily's birthday is 20 October"] }) });
  await vault.add({ body: 'emily birthday oct 20', kind: 'log' });
  const [fact] = (await vault.learn()).learned;

  vault.provider = learnProvider({
    facts: ["Emily's birthday is 22 October"],
    verdicts: [{ i: 1, verdict: 'contradicts', of: fact.id }],
  });
  await vault.add({ body: 'actually the 22nd', kind: 'log' });
  const result = await vault.learn();

  assert.equal(result.conflicts.length, 1);
  assert.equal(vault.facts().length, 2, 'nothing automatic may discard a fact');
  const [newer, older] = [result.conflicts[0].fact, result.conflicts[0].with];
  assert.deepEqual(toFact(newer).conflicts, [older.id]);
  assert.deepEqual(toFact(older).conflicts, [newer.id]);
});

test('a fact you wrote yourself is never rewritten by the model', async () => {
  const vault = await makeVault({ provider: learnProvider({ facts: ['x'] }) });
  const mine = await vault.addFact("Emily's birthday is 20 October");
  assert.equal(toFact(mine).origin, 'manual');

  vault.provider = learnProvider({
    facts: ["Emily's birthday is 21 October"],
    verdicts: [{ i: 1, verdict: 'refines', of: mine.id, text: "Emily's birthday is 21 October" }],
  });
  await vault.add({ body: 'birthday note', kind: 'log' });
  const result = await vault.learn();

  assert.equal(vault.get(mine.id).body, "Emily's birthday is 20 October", 'your words stay yours');
  assert.equal(result.refined.length, 0);
  assert.equal(result.learned.length, 1, 'the model may add its version alongside');
});

test('memory never becomes the thing `latest` means', async () => {
  const vault = await makeVault({
    provider: fakeProvider(JSON.stringify({ memories: ['Emily likes chocolate'] })),
  });
  const log = await vault.add({ body: 'Emily likes chocolate', kind: 'log' });
  await vault.remember('Emily likes chocolate');

  // The bug this exists to stop: `learn` defaulted to `latest`, `latest` became
  // the memory it had just written, and every later run re-read its own output.
  assert.equal(vault.get('latest').id, log.id);
  assert.equal(vault.get('^1').id, log.id);
});

test('facts stay out of lists, recaps, and search until asked for by kind', async () => {
  const vault = await makeVault({
    provider: fakeProvider(JSON.stringify({ memories: ['Emily likes chocolate'] })),
  });
  await vault.add({ body: 'Bought a present today', kind: 'log' });
  await vault.remember('Emily likes chocolate');

  assert.equal(vault.list().length, 1, 'a standing fact is not a journal entry');
  assert.equal(vault.search('chocolate').length, 0);
  assert.equal(vault.list({ kind: 'memory' }).length, 1);
  assert.equal(vault.search('chocolate', { kind: 'memory' }).length, 1);
  // Still addressable, so `ppr show`/`edit`/`rm` work on a fact by title.
  assert.equal(vault.get('Emily likes chocolate').kind, 'memory');
});

test('follow-up questions degrade to a generic prompt', async () => {
  const vault = await makeVault();
  const questions = await vault.followUps('shipped it');
  assert.equal(questions.length, 1);
  assert.ok(questions[0].length > 10);
});

test('settling a conflict retires the loser and unlinks the pair', async () => {
  const vault = await makeVault({ provider: learnProvider({ facts: ["Emily's birthday is 20 October"] }) });
  await vault.add({ body: 'oct 20', kind: 'log' });
  const [first] = (await vault.learn()).learned;

  vault.provider = learnProvider({
    facts: ["Emily's birthday is 22 October"],
    verdicts: [{ i: 1, verdict: 'contradicts', of: first.id }],
  });
  await vault.add({ body: 'actually the 22nd', kind: 'log' });
  const second = (await vault.learn()).conflicts[0].fact;

  assert.equal(vault.conflicts().length, 1);
  const { kept, retired } = await vault.keepFact(second.id, first.id);

  assert.equal(toFact(vault.get(retired.id)).status, 'retired');
  assert.equal(toFact(vault.get(retired.id)).supersededBy, kept.id);
  // The pointer has to go, or the pair keeps showing up as unsettled forever.
  assert.deepEqual(toFact(vault.get(kept.id)).conflicts, []);
  assert.deepEqual(toFact(vault.get(retired.id)).conflicts, []);

  assert.equal(vault.conflicts().length, 0);
  assert.equal(vault.facts().length, 1, 'the retired fact leaves the working set');
  assert.equal(vault.facts({ includeRetired: true }).length, 2, 'but it is still on disk');
});

test('two facts that turn out to both be true are simply unlinked', async () => {
  const vault = await makeVault({ provider: learnProvider({ facts: ['Emily likes chocolate'] }) });
  await vault.add({ body: 'a', kind: 'log' });
  const [first] = (await vault.learn()).learned;

  vault.provider = learnProvider({
    facts: ['Emily likes marzipan'],
    verdicts: [{ i: 1, verdict: 'contradicts', of: first.id }],
  });
  await vault.add({ body: 'b', kind: 'log' });
  const second = (await vault.learn()).conflicts[0].fact;

  await vault.keepBoth(first.id, second.id);
  assert.equal(vault.conflicts().length, 0);
  assert.equal(vault.facts().length, 2);
  assert.equal(toFact(vault.get(first.id)).status, 'current');
});

test('deleting one side of a disagreement settles it', async () => {
  const vault = await makeVault({ provider: learnProvider({ facts: ['The staging database is Postgres 14'] }) });
  await vault.add({ body: 'a', kind: 'log' });
  const [first] = (await vault.learn()).learned;

  vault.provider = learnProvider({
    facts: ['The staging database is Postgres 16'],
    verdicts: [{ i: 1, verdict: 'contradicts', of: first.id }],
  });
  await vault.add({ body: 'b', kind: 'log' });
  await vault.learn();

  await vault.remove(first.id);
  assert.equal(vault.conflicts().length, 0, 'a dangling pointer is not an open question');
});
