import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProvider, DEFAULT_CONFIG } from '../dist/index.js';

/** A stand-in API, so the request shape each provider sends is actually checked. */
async function withServer(handler, fn) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      const reply = handler(requests.at(-1));
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl, requests);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const ai = (over) => ({ ...structuredClone(DEFAULT_CONFIG).ai, ...over });
const secrets = (map) => (name) => map[name];

test('the anthropic provider sends the Messages API shape', async () => {
  await withServer(
    () => ({ body: { content: [{ type: 'text', text: 'hello from claude' }] } }),
    async (baseUrl, requests) => {
      const provider = createProvider(
        ai({ provider: 'anthropic', model: 'claude-sonnet-5', baseUrl, apiKeyEnv: 'TEST_KEY' }),
        secrets({ TEST_KEY: 'sk-test' }),
      );
      const reply = await provider.generate({ prompt: 'hi', system: 'be terse', maxTokens: 42 });

      assert.equal(reply, 'hello from claude');
      const [req] = requests;
      assert.equal(req.url, '/v1/messages');
      assert.equal(req.headers['x-api-key'], 'sk-test');
      assert.equal(req.headers['anthropic-version'], '2023-06-01');
      assert.equal(req.body.system, 'be terse');
      assert.equal(req.body.max_tokens, 42);
      assert.deepEqual(req.body.messages, [{ role: 'user', content: 'hi' }]);
    },
  );
});

test('an OpenAI-compatible endpoint gets chat completions with max_tokens', async () => {
  await withServer(
    () => ({ body: { choices: [{ message: { content: 'hello from the local server' } }] } }),
    async (baseUrl, requests) => {
      const provider = createProvider(ai({ provider: 'openai', model: 'local-model', baseUrl }), secrets({}));
      const reply = await provider.generate({ prompt: 'hi', system: 'sys', json: true });

      assert.equal(reply, 'hello from the local server');
      const [req] = requests;
      assert.equal(req.url, '/chat/completions');
      assert.equal(req.body.model, 'local-model');
      // Local and compatible servers only understand max_tokens.
      assert.ok('max_tokens' in req.body);
      assert.deepEqual(req.body.response_format, { type: 'json_object' });
      assert.equal(req.body.messages[0].role, 'system');
      assert.equal(req.headers.authorization, undefined, 'a local endpoint must not require a key');
    },
  );
});

test('ollama uses its native chat API and never asks for a key', async () => {
  await withServer(
    () => ({ body: { message: { content: 'hello from ollama' } } }),
    async (baseUrl, requests) => {
      const provider = createProvider(ai({ provider: 'ollama', model: 'llama3.2', baseUrl }), secrets({}));
      const reply = await provider.generate({ prompt: 'hi', json: true, maxTokens: 100 });

      assert.equal(reply, 'hello from ollama');
      assert.equal(provider.local, true);
      const [req] = requests;
      assert.equal(req.url, '/api/chat');
      assert.equal(req.body.stream, false);
      assert.equal(req.body.format, 'json');
      assert.equal(req.body.options.num_predict, 100);
    },
  );
});

test('a hosted provider with no key fails before it sends anything', async () => {
  const provider = createProvider(
    ai({ provider: 'anthropic', model: 'claude-sonnet-5', apiKeyEnv: 'MISSING_KEY' }),
    secrets({}),
  );
  await assert.rejects(() => provider.generate({ prompt: 'hi' }), /No API key/);
});

test('an API error surfaces the status and body, not a stack trace', async () => {
  await withServer(
    () => ({ status: 429, body: { error: 'rate limited' } }),
    async (baseUrl) => {
      const provider = createProvider(ai({ provider: 'ollama', model: 'x', baseUrl }), secrets({}));
      await assert.rejects(() => provider.generate({ prompt: 'hi' }), /429/);
    },
  );
});

test('an unreachable endpoint is a network error with a hint', async () => {
  const provider = createProvider(
    ai({ provider: 'ollama', model: 'x', baseUrl: 'http://127.0.0.1:1' }),
    secrets({}),
  );
  await assert.rejects(
    () => provider.generate({ prompt: 'hi' }),
    (err) => err.code === 'ENETWORK' && /--no-ai/.test(err.hint),
  );
});

test('provider `none` returns nothing at all, rather than failing', () => {
  assert.equal(createProvider(ai({ provider: 'none' }), secrets({})), undefined);
});
