# Adding an AI provider or transcription backend

## Decide where it lives

**Reachable over HTTP?** `core/src/ai/providers.ts`, alongside `anthropic`,
`openaiCompatible`, and `ollama`. It stays portable and a mobile client gets it free.

**Needs a shell, a binary, or the filesystem?** `core/src/node/`, then register it
from `core/src/node.ts`:

```ts
registerProvider('apple', (ai) => appleProvider(ai));
```

The registry exists so `createProvider()` can offer platform providers without
`@ppr/core` ever importing `node:child_process` (invariant I8).

## The interface is deliberately tiny

```ts
interface AIProvider {
  readonly id: string;
  readonly model: string;
  readonly local: boolean;   // true = nothing leaves the machine
  generate(req: GenerateRequest): Promise<string>;
}
```

Text in, text out. No streaming, no tools, no message history — nothing in ppr
needs them, and every capability added here has to be implemented by every
provider including the on-device ones.

`req.json` asks for raw JSON. Providers that support a JSON mode should use it;
those that cannot should append the instruction to the prompt, as the Apple shim
does. Callers never trust the result anyway — `parseJsonLoose()` handles fences and
surrounding prose, and every task falls back when parsing fails.

## Wire it up

1. Add the id to the `AIConfig['provider']` union in `core/src/config.ts`.
2. Add defaults to `PROVIDER_DEFAULTS` — model, `baseUrl`, and `apiKeyEnv` if it
   needs a key. Store the env var *name*, never a key (invariant I7).
3. Any new config key without a default must be added to `OPTIONAL_KEYS`, or
   `ppr config set` will reject it as unknown (lesson L5).
4. Add a line to `PROVIDER_HELP` in `commands/settings.ts` so it appears in
   `ppr ai list` and the setup picker.
5. If it needs an external binary, add a check to `ppr doctor` with the exact
   install command as the hint.

## Errors

```ts
throw new PprError('ENETWORK', `Could not reach ${host}: ${message}`,
  'Check the endpoint is running, or run with --no-ai.');
throw new PprError('EAI', `${host} returned ${status}: ${detail}`);
throw new PprError('ECONFIG', `No API key for ${provider}`,
  `Set ${envVar}, or run \`ppr ai setup\`.`);
```

Distinguish "cannot reach it" from "it said no" from "you have not configured it" —
they need different fixes, and the hint should say which.

## Test the wire format, never a live API

`core/test/providers.test.js` runs a local `node:http` server and asserts exactly
what gets sent:

```js
await withServer(
  () => ({ body: { message: { content: 'hello' } } }),
  async (baseUrl, requests) => {
    const provider = createProvider(ai({ provider: 'mine', model: 'm', baseUrl }), secrets({}));
    assert.equal(await provider.generate({ prompt: 'hi' }), 'hello');
    assert.equal(requests[0].url, '/api/chat');
    assert.equal(requests[0].body.stream, false);
  },
);
```

Cover the error paths too: a non-2xx response, an unreachable host, and a missing
key. The suite must stay offline and deterministic.

## Transcription backends

Same shape, in `core/src/node/transcribe.ts`, implementing `Transcriber`. Two
rules learned the hard way:

- **Validate before recording.** `ppr voice` checks the backend exists before it
  starts capturing audio — discovering the problem afterwards throws away the
  recording (lesson L7).
- **Convert only when you must.** whisper.cpp needs 16 kHz mono WAV, so ffmpeg is
  invoked only for inputs that are not already WAV, and its absence is an error
  with the `brew install` line attached.

## The offline path is not optional

Before adding a provider, check that whatever calls it still works without one.
Every task in `ai/tasks.ts` takes `provider?: AIProvider | undefined` and falls
back to `ai/fallback.ts`. That is invariant I2, and `core/test/ai.test.js` proves
it by feeding five kinds of malformed model output and asserting the user's
original text survives.
