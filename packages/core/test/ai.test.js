import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Vault,
  MemoryStorage,
  DEFAULT_CONFIG,
  tasks,
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

test('memories are extracted once and never duplicated', async () => {
  const vault = await makeVault({
    provider: fakeProvider(JSON.stringify({ memories: ['Prefers memcached over redis', 'Sam owns auth'] })),
  });

  const first = await vault.remember('some text');
  assert.equal(first.length, 2);
  assert.equal(first[0].kind, 'memory');

  const second = await vault.remember('some text again');
  assert.equal(second.length, 0, 'the same fact must not be stored twice');
  assert.equal(vault.list({ kind: 'memory' }).length, 2);
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
