# @ppr/core

The engine behind [ppr](../../README.md). No platform APIs, no CLI concerns — just
entries, search, links, capture pipelines, and AI tasks.

This package exists so the second front-end is a wiring exercise instead of a rewrite.

## The boundary

Core touches the outside world through five small interfaces:

```ts
interface Storage {          // a flat key/value store keyed by vault-relative path
  read(path): Promise<string | null>;
  write(path, data): Promise<void>;
  remove(path): Promise<void>;
  list(prefix): Promise<FileStat[]>;
  stat(path): Promise<FileStat | null>;
}

interface Clock { now(): Date }
interface AIProvider { id; model; local; generate(req): Promise<string> }
interface Transcriber { id; local; transcribe(audio): Promise<string> }
type Fetcher = (url, opts?) => Promise<{ status; contentType; body; url }>
```

`Storage` is the only one that is required. Everything else is optional, and every
feature has a defined behaviour when it is absent.

## Two entry points

```ts
import { Vault, MemoryStorage } from '@ppr/core';        // portable: Node, RN, browser
import { openVault, NodeStorage } from '@ppr/core/node'; // filesystem, subprocesses
```

`@ppr/core` imports nothing platform-specific. The `/node` entry point adds the
filesystem adapter, config and secret loading, and the providers that need a shell
(Apple Foundation Models, arbitrary commands, whisper.cpp).

## Using it

```ts
const vault = await Vault.open({
  root: '/wherever',
  storage: new MemoryStorage(),
  config: DEFAULT_CONFIG,
  provider,      // optional
  transcriber,   // optional
  fetcher,       // optional; defaults to global fetch
});

await vault.add({ body: 'Rolled back the deploy #infra', kind: 'log' });
await vault.dump('um so basically the cache is cold on every deploy');
await vault.clip('https://example.com/post');

vault.list({ tag: 'infra', since: new Date('2026-07-01') });
vault.search('deploy', { limit: 10 });
vault.related(vault.get('latest'));
vault.backlinks(vault.get('latest'));
vault.lenses(vault.get('latest'));   // ways to move on: backlinks, related, tag, day
await vault.refresh();               // re-read after something changed on disk

await vault.recap(vault.list({ limit: 20 }), { style: 'weekly' });
await vault.ask('why did we drop redis?');
await vault.remember('Sam owns auth. We prefer memcached.');

await vault.close();   // flushes the parse cache
```

`Vault` is the whole API. If a front-end needs something it cannot express through
`Vault`, that is a signal the method belongs in core rather than in the front-end.

## Building a front-end

1. **Implement `Storage`.** React Native: `expo-file-system` or `react-native-fs`.
   Browser: OPFS or IndexedDB. A sync service: whatever it stores blobs in. Paths are
   vault-relative and POSIX-separated; `list()` is recursive.
2. **Supply a provider, or don't.** Every AI task degrades to a documented offline
   path. Ship without one and the app still works.
3. **Call `Vault`.** Rendering is the only thing left to write.

`MemoryStorage` is exported for exactly this reason — it is what the test suite uses,
so the portable path is exercised on every run rather than assumed.

## Where the behaviour lives

| Module | Responsibility |
| --- | --- |
| `entry.ts` | Create, patch, parse, serialize. Owns the file path scheme. |
| `catalog.ts` | Loads the vault, mtime-keyed cache, ref resolution (`latest`, `^2`, ids, titles). |
| `search.ts` | Filtering and lexical ranking. Pure functions over `Entry[]`. |
| `links.ts` | Backlinks, forward links, relatedness, tag counts, graph projection. |
| `navigate.ts` | Lenses: the named routes out of an entry, for any UI that browses. |
| `capture.ts` | The dump and clip pipelines. |
| `ai/tasks.ts` | distill, summarizePage, recap, ask, followUps, extractMemories. |
| `ai/fallback.ts` | What each task does with no model. |
| `markdown.ts` | Frontmatter parse/serialize. Never loses a body to bad YAML. |

## Rules the code follows

- **The markdown is the source of truth.** The index is a cache and is always
  rebuildable. A file edited in vim, or arriving via git, is picked up on the next load.
- **No AI failure costs a user their words.** A model that returns garbage, times out,
  or is not configured falls back to the offline path. The raw text is never dropped
  on the way.
- **Unknown frontmatter round-trips.** Keys ppr does not own are preserved on write,
  so the vault can be shared with Obsidian or anything else.
- **Writes are atomic** in the Node adapter. An interrupted command cannot leave half
  a note behind.
