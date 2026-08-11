# Plan 001: Remediate the full ppr audit — security, data-loss, TUI, debt, shippability, perf

> **Executor instructions**: Follow this plan part by part, in order. Each part
> is a self-contained fix with its own verification command. Run every
> verification and confirm the expected result before moving on. If anything in
> the "STOP conditions" section occurs, stop and report — do not improvise.
> Commit after each part (see Git workflow) so a failing part can be reverted
> without losing the others. When done, update the status table in
> `plans/README.md`.
>
> **Drift check (run first)**:
> ```
> git diff --stat e773b65..HEAD -- packages/core/src packages/cli/src packages/cli/package.json packages/core/package.json tsconfig.base.json .github/workflows/ci.yml README.md
> ```
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts in the affected part against the live code before editing that
> part. On a mismatch you cannot reconcile, treat it as a STOP condition for that
> part only (the other parts are independent).

## Status

- **Priority**: P1
- **Effort**: L (many small-to-medium fixes; ~1–2 days total)
- **Risk**: MED (spans security, data-loss, and the TUI; each part is individually LOW–MED)
- **Depends on**: none
- **Category**: mixed (security, bug, tech-debt, perf, dx, docs)
- **Planned at**: commit `e773b65`, 2026-08-09

## Why this matters

The audit found three classes of problem worth fixing together: (1) a cloned
vault can execute a shell or redirect the user's API key, because `validateConfig`
only strips `hooks` and not the other shell/endpoint config keys — the exact
threat AGENTS.md §"Extending ppr" describes for hooks, left unguarded for the
rest; (2) two silent data-loss paths — a title-rename that deletes the old file
before writing the new one (violates invariant I2), and hand-written files that
get a fresh random id on every parse (dangling provenance); (3) a cluster of TUI
bugs, drift, and shippability gaps. Landing all of it removes the code that
would embarrass the project on its first `npm publish` and closes the
data-integrity holes that its own invariants exist to prevent.

Read AGENTS.md before starting — it is the single source of context for this
repo, it is shorter than the code, and several fixes below restore an invariant
it names (I1, I2, I7, L2). The house rules that matter here:

- **Comments explain *why*, never *what*.** Match the density already present.
- **Data on stdout, chrome on stderr (I10).** Never print to stdout from a fix.
- **`@ppr/core` imports no platform API (I8).** Do not add `node:*` imports to
  anything under `packages/core/src/` except inside `packages/core/src/node/`.
- **Types are `strict` + `noUncheckedIndexedAccess`.** Prefer narrow types over
  `as` casts. Optional fields use conditional spread `...(x ? { x } : {})`.
- Tests are plain JS (`node --test`) against built `dist/`, in
  `packages/*/test/*.test.js`. No test may reach the network or run `osascript`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Build both packages | `pnpm build` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Full test suite | `pnpm test` | all pass (338 baseline + new) |
| Core tests only | `pnpm --filter @ppr/core test` | all pass |
| CLI tests only | `pnpm --filter ppr test` | all pass |
| One test file | `node --test packages/core/test/vault.test.js` | that file passes |
| Pack dry-run | `pnpm --filter ppr pack --dry-run` | lists the files that would ship |

`pnpm build` runs `tsc` in each package; a type error fails the build. There is
no linter and none is being added (see Part 12). Run `pnpm build` before
`pnpm test` until Part 1 lands, because today the CLI test script does not
compile first.

## Scope

**In scope** (only these files may be modified or created):

- `packages/cli/package.json`, `packages/core/package.json`
- `tsconfig.base.json`
- `.github/workflows/ci.yml`
- `README.md`, `packages/cli/README.md` (create)
- `packages/core/src/config.ts`, `packages/core/src/node/paths.ts`
- `packages/core/src/vault.ts`, `packages/core/src/entry.ts`, `packages/core/src/markdown.ts`
- `packages/core/src/catalog.ts`, `packages/core/src/links.ts`, `packages/core/src/memory.ts`
- `packages/core/src/adapters/node-storage.ts`
- `packages/core/src/node/download.ts`, `packages/core/src/models.ts`, `packages/core/src/node/transcribe.ts`
- `packages/cli/src/schedule.ts`
- `packages/cli/src/ui/state.ts`, `packages/cli/src/ui/layout.ts`, `packages/cli/src/ui/text.ts`, `packages/cli/src/ui/browser.ts`, `packages/cli/src/ui/screen.ts`
- `packages/cli/src/commands/settings.ts`, `packages/cli/src/index.ts`
- New test files under `packages/core/test/` and `packages/cli/test/`

**Out of scope** (do NOT touch, even though they look related):

- `Catalog.load()`'s re-stat-every-file behavior — invariant I1, by design.
- `parseDocument`'s "broken YAML still loads" behavior — by design; Part 6 only
  stops the *rewrite* from destroying the block, it does not change loading.
- The `--pipe` string in `schedule.ts` — deliberately left unquoted (it is a
  user-typed command line); Part 10 quotes the *argv*, never the pipe.
- Anything under `plugins/` — the AppleScript escaping was audited and is
  complete; no change needed.
- Adding ESLint / Prettier / Biome — explicitly declined (Part 12 note).
- The `Vault` facade size, lexical-search design, whole-fact-store-in-prompt —
  recorded tradeoffs, not findings.

## Git workflow

- Branch: `advisor/001-audit-remediation`.
- Commit per Part, message style matching `git log` (a short imperative subject
  line stating the *why*, e.g. `A cloned vault could run your shell; only hooks
  were fenced off`). End each commit body with the invariant it protects where
  one applies.
- Do NOT push or open a PR unless the operator asks.

---

## Part 1 — Make `pnpm test` build the CLI first (do this first)

**Finding**: TESTS-01. CLI tests import `dist/`, but `packages/cli`'s test script
does not compile; core's does. A source edit + `pnpm test` passes green against
the *previous* build. Fixing this first means every test you add later actually
runs against your changes.

**Current state** — `packages/cli/package.json` scripts:
```json
"test": "node --test \"test/*.test.js\""
```
Compare `packages/core/package.json`, which does it right:
```json
"test": "tsc -p tsconfig.json && node --test \"test/*.test.js\""
```

**Step 1.1**: Change the CLI test script to compile first, matching core:
```json
"test": "tsc -p tsconfig.json && node --test \"test/*.test.js\""
```

**Verify**: `pnpm --filter ppr test` → builds then runs; introduce a deliberate
type error in `packages/cli/src/index.ts`, run `pnpm --filter ppr test`, confirm
it now *fails at compile* rather than passing; revert the deliberate error.

---

## Part 2 — Fence off shell/endpoint config keys from the vault layer

**Findings**: SECURITY-01, SECURITY-02, SECURITY-08. `validateConfig` strips only
`hooks`. `ai.command`, `ai.provider: command`, `transcribe.command`,
`transcribe.binary` are executed via `shell:true`/spawn and are settable from the
vault layer; `ai.baseUrl`/`ai.apiKeyEnv` (and transcribe twins) can redirect the
live API key to an attacker host. A `git clone && ppr <anything that runs a
model>` is enough. Also harden the merge against prototype-supplied keys so the
strip cannot be side-stepped.

**Current state** — `packages/core/src/node/paths.ts:101-108`:
```ts
/** Defaults < global config < vault config. Later wins, key by key. */
export async function loadConfig(root: string, env: Env = process.env): Promise<Config> {
  const [global, local] = await Promise.all([
    readJson(globalConfigPath(env)),
    readJson(join(root, VAULT_CONFIG)),
  ]);
  return validateConfig(mergeConfig(structuredClone(DEFAULT_CONFIG), global, local));
}
```
`packages/core/src/config.ts:391-396`:
```ts
export function validateConfig(config: Config): Config {
  trimStrings(config as unknown as Json);
  delete (config as unknown as Json).hooks;
```
`packages/core/src/config.ts:228-236` (`deepMerge`) copies every own key of the
override with no key filtering; `JSON.parse` can produce a real `__proto__` own
key.

**Step 2.1** — strip machine-scoped keys from the *vault layer only*, before the
merge, in `loadConfig`. The global layer keeps them (an operator's own machine).
Add, in `packages/core/src/node/paths.ts`, a strip applied only to `local`:

```ts
// Keys that name a program to run or an endpoint to send a key to are a
// property of the machine, not the notes. A vault is a repo people clone and
// share (I7), so honouring these from the vault layer means `git clone` can run
// a stranger's shell or redirect your API key — the same danger `hooks` is
// fenced off from. Global layer keeps them; vault layer never sets them.
const VAULT_FORBIDDEN_PATHS = [
  'ai.command',
  'ai.baseUrl',
  'ai.apiKeyEnv',
  'transcribe.command',
  'transcribe.binary',
  'transcribe.baseUrl',
  'transcribe.apiKeyEnv',
];
```
Then in `loadConfig`, after reading `local` and before the merge, delete each of
those dotted paths from the `local` object (a small `deletePath(obj, 'a.b')`
helper — walk to the parent, `delete parent[last]`). Also: if the vault layer
sets `ai.provider` to `"command"`, drop that single key from `local` too (a
vault must not be able to *switch* the provider to the shell one), leaving any
global/default provider intact.

**Step 2.2** — harden `deepMerge` in `packages/core/src/config.ts` against
dangerous keys, so the `hooks` strip (and any future `delete`-based guard) cannot
be bypassed via the prototype chain:
```ts
function deepMerge(base: Json, override: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const prev = out[k];
    out[k] = isPlainObject(v) && isPlainObject(prev) ? deepMerge(prev, v) : v;
  }
  return out;
}
```

**Step 2.3** — make the interactive path refuse too, mirroring how hooks are
refused. Find where `config set --local` writes a key (search
`packages/cli/src/` and `packages/core/src/config.ts` for the `guardHooks` /
hooks-refusal message). Add the same refusal shape for any path in
`VAULT_FORBIDDEN_PATHS` when `--local` is set, naming the global config file as
the right place. If a shared refusal helper already exists for hooks, extend it;
do not invent a second mechanism.

**Step 2.4** — tests in `packages/core/test/` (model after the existing hooks
test — find it with `grep -rn "hooks" packages/cli/test/cli.test.js`):
- A vault-layer `.ppr/config.json` setting `ai.command` does NOT survive
  `loadConfig` (effective config keeps the global/default value).
- A vault-layer `ai.baseUrl` does NOT survive `loadConfig`.
- A vault-layer `ai.provider: "command"` does NOT switch the effective provider.
- A config layer with a `"__proto__"` key does not alter `Object.prototype` and
  does not appear in the effective config.
- The *global* layer setting the same keys DOES survive (they are legitimate there).

**Verify**: `pnpm --filter @ppr/core test` → new tests pass; `pnpm typecheck` → 0.

**STOP** if `ai.command`/`transcribe.*` turn out already to be read only from a
non-vault path elsewhere (i.e. the merge is not the reader) — report the actual
reader before changing behavior.

---

## Part 3 — Write the renamed entry before deleting the old file (I2)

**Finding**: CORRECTNESS-01. A title change moves the file; `update()` removes the
old path *before* writing the new one, so a failing write leaves the note
nowhere. `relocateFacts` already does it in the safe order.

**Current state** — `packages/core/src/vault.ts:348-355`:
```ts
async update(ref: string, patch: EntryPatch): Promise<Entry> {
  const current = this.catalog.resolve(ref);
  const next = applyPatch(current, patch, this.clock.now());
  if (next.path !== current.path) await this.storage.remove(current.path).catch(() => {});
  await this.write(next);
  this.emit({ event: 'entry.updated', entry: next, previous: current });
  return next;
}
```
Safe-order reference — `relocateFacts` at `vault.ts:1272-1275` writes `next`
first, then removes the old path.

**Step 3.1**: Reorder so the new file exists before the old one is removed:
```ts
const next = applyPatch(current, patch, this.clock.now());
await this.write(next);
if (next.path !== current.path) await this.storage.remove(current.path).catch(() => {});
```
Keep the `.catch(() => {})` on the remove (a failed cleanup must not fail the
update — the write already succeeded).

**Step 3.2** — test in `packages/core/test/vault.test.js`: build a Vault over a
storage stub whose `write` rejects on the *second* call, do an update that
changes the title, assert the original entry still resolves and its file still
exists. (Use `MemoryStorage` wrapped so one write throws; see how vault tests
already construct a vault with an in-memory store.)

**Verify**: `node --test packages/core/test/vault.test.js` → passes incl. the new
"a failed write during rename never loses the entry" test.

---

## Part 4 — Stop broken frontmatter and adopted files from losing their identity

**Findings**: CORRECTNESS-02 + CORRECTNESS-12 (entangled — both destroy the id of
a hand-written file). Two fixes:

**4a. Stable id for adopted files.** `parseEntry` mints a fresh random id every
time an id-less file is parsed, so provenance (`fact.from`, `[[id]]` links, the
high-water mark) dangles on every reindex/cache-miss.

Current — `packages/core/src/entry.ts:123-126`:
```ts
export function parseEntry(path: string, raw: string): Entry {
  const { data, body } = parseDocument(raw);
  const created = firstDate(data.created, dateFromPath(path), timeFromId(String(data.id ?? '')));
  const id = typeof data.id === 'string' && data.id ? data.id : createId(created);
```
The fix: when `data.id` is absent, derive the id *deterministically from the
path* so re-parsing the same file always yields the same id. The filename already
ends in a stable suffix (`…-slug-xxxx.md`). Add a helper `idFromPath(path,
created)` in `entry.ts` that produces a stable 16-char id: the base32
millisecond prefix from `created` (reuse whatever `createId` uses for its prefix)
plus a 6-char tail derived by hashing the vault-relative path (not random). Keep
the shape identical to `createId`'s output (16 chars, `[0-9a-z]`) so `isId()` and
short-id resolution still accept it. Use only pure JS (no `node:crypto` — this is
`@ppr/core`, I8): a small deterministic string hash folded into base32 is
sufficient here; collisions across distinct paths are astronomically unlikely at
personal-vault scale and, if two adopted files ever collide, that is no worse
than today's per-parse re-roll.

**4b. Preserve unparseable frontmatter instead of erasing it on rewrite.**
Current — `packages/core/src/markdown.ts:15-30`: on YAML failure it returns
`{ data: {}, body }` and the raw frontmatter is kept nowhere, so the first
`edit`/`append`/`done` re-serializes the file without it (id and third-party keys
gone).

The fix, staying compatible with the "still loads" tradeoff:
- In `parseDocument`, when the frontmatter block is present but YAML parsing
  fails (or is non-object), return the raw block text alongside the body, e.g.
  `{ data: {}, body, rawFrontmatter: match[1] }` (add `rawFrontmatter?: string`
  to the `Document` interface).
- Carry it onto the `Entry` — add an optional field (e.g. `extra` cannot hold it
  because `extra` is object-valued and round-tripped as YAML; add a dedicated
  optional `raw?: { frontmatter: string }` on the `Entry` type, or reuse an
  existing escape hatch if one fits). Whichever you pick, it must NOT appear in
  normal serialized output for well-formed files.
- In `serializeEntry`, if the entry carries preserved raw frontmatter AND ppr has
  no parsed `data` of its own to write, re-emit the file with the original
  frontmatter block verbatim rather than a fresh ppr-built one. If this proves
  structurally awkward, the acceptable fallback is: refuse to rewrite such a file
  with a `PprError('EINVALID', "this file's frontmatter is not valid YAML — fix
  it by hand first", …)`. Either behavior is correct; silent destruction is not.

**Step 4.3** — tests:
- `packages/core/test/entry.test.js`: `parseEntry(p, raw).id === parseEntry(p,
  raw).id` for a frontmatter-less file (stability across calls), and the id is a
  valid id per `isId`.
- A file with deliberately broken YAML frontmatter: after a round-trip through
  `parseEntry` → `serializeEntry`, either the original frontmatter block is still
  present, or serialize threw the documented error — assert whichever behavior
  you implemented. Never assert the block silently vanished.

**Verify**: `node --test packages/core/test/entry.test.js` → passes.

**STOP** if adding a stable-id derivation would re-key entries that ppr *itself*
wrote (it must only affect files with no `id` in frontmatter — ppr-written files
always have one; confirm by reading how `serializeEntry` always emits `id`).

---

## Part 5 — Catch write-effect failures in the browser loop

**Finding**: CORRECTNESS-03. `onKey: (key) => void this.handle(key)` discards the
promise; `handle`/`apply` have no `catch`; the awaited vault writes can throw, and
Node terminates the process on an unhandled rejection — killing the interactive
session instead of showing a footer status.

**Current state** — `packages/cli/src/ui/browser.ts:72-92`:
```ts
private async handle(key: Key): Promise<void> {
  if (this.busy) { this.pending.push(key); return; }
  this.busy = true;
  try {
    const { state, effect } = reduce(this.state, key, (entry) => this.vault.lenses(entry));
    this.state = state;
    await this.apply(effect);
    if (this.state.done) { this.finish?.(); return; }
    this.paint();
  } finally {
    this.busy = false;
    const next = this.pending.shift();
    if (next) void this.handle(next);
  }
}
```

**Step 5.1**: Add a `catch` between `try` and `finally` that reports the error to
the footer and keeps the loop alive. Reuse the existing status mechanism — find
how the browser already sets a footer message (search `browser.ts` for
`status`). Extract a user-facing message from the error (`PprError` carries a
`message`; for anything else, a generic "couldn't do that" line). Repaint after
setting status. Do not print to stdout/stderr — this is inside the alt-screen.

**Step 5.2** — test in `packages/cli/test/state.test.js` or a new browser-focused
test: the reducer/apply path is pure enough to test the effect side by injecting
a Vault stub whose `remove` rejects; assert the session state does not go `done`
and a status message is set. If `apply` is not reachable without a real Screen,
add the narrowest seam needed (a Vault stub is enough; do not add a Screen seam
here — that is Part 13's optional work).

**Verify**: `pnpm --filter ppr test` → passes incl. the new "a failing write is
shown, not fatal" test.

---

## Part 6 — Fix the three TUI reducer/render bugs

Three independent bugs in `packages/cli/src/ui/`. All are pure-reducer/pure-layout
and unit-testable in `packages/cli/test/state.test.js`.

**6a. `G` (jump to last) is unreachable.** `key.ts` lowercases `G` to
`{name:'g', shift:true}`, and the `'g'` branch matches before the shift-`g`
branch.

Current — `packages/cli/src/ui/state.ts:184-187`:
```ts
case key.name === 'home' || key.name === 'g':
  return step(jump(state, 0));
case key.name === 'end' || (key.shift && key.name === 'g'):
  return step(jump(state, Number.MAX_SAFE_INTEGER));
```
Fix: guard the first branch so it only fires for un-shifted `g`:
```ts
case key.name === 'home' || (!key.shift && key.name === 'g'):
  return step(jump(state, 0));
case key.name === 'end' || (key.shift && key.name === 'g'):
  return step(jump(state, Number.MAX_SAFE_INTEGER));
```

**6b. `restack` clamps the cursor but not the offset.** After a delete/reload
that shrinks a scrolled list, the window slices past the end and renders blank
rows with a live cursor.

Current — `packages/cli/src/ui/state.ts:346-352`:
```ts
export function restack(state: BrowserState, byId: Map<string, Entry>, rootEntries: Entry[]): BrowserState {
  const stack = state.stack.map((view, i) => {
    const entries = i === 0 ? rootEntries : view.entries.map((e) => byId.get(e.id)).filter(Boolean as unknown as (e: Entry | undefined) => e is Entry);
    const cursor = Math.min(view.cursor, Math.max(0, entries.length - 1));
    return { ...view, entries, cursor };
  });
  return { ...state, stack };
}
```
Fix: reuse the existing `reposition(view, pageSize, cursor)` helper
(`state.ts:88`, which already clamps `offset` at line 94) instead of hand-clamping
the cursor. `restack` has `state.pageSize` available. Produce the new view via
`reposition({ ...view, entries }, state.pageSize, clampedCursor)`.

**6c. Pre-coloured breadcrumb fed into the width-measuring `row()`.** `row()`
measures `text.length`, which counts ANSI bytes; the breadcrumb is joined with a
coloured separator, so the header truncates ~9 chars early per separator and can
clip mid-escape.

Current — `packages/cli/src/ui/layout.ts:132-137`:
```ts
const crumbs = state.stack.map((v) => v.label).join(color.dim(' › '));
...
const left: Segment[] = [['ppr ', color.dim], [crumbs]];
```
Fix: build the breadcrumb as `Segment[]` — the label (unstyled) then `[' › ',
color.dim]` between labels — and let `row()` style each piece after clipping, the
way the rest of `layout.ts` already passes segments. So `left` becomes something
like `[['ppr ', color.dim], ...interleave(labels, [' › ', color.dim])]`.

**Step 6.4** — tests in `packages/cli/test/state.test.js`:
- `g` jumps to index 0; shift-`g` jumps to the last visible entry (two cases).
- `restack` after removing entries while scrolled (offset > 0, pageSize small
  enough that offset matters — e.g. 10 entries, pageSize 3, cursor+offset near the
  end, then restack with 4 entries): assert the resulting `offset` keeps the
  cursor visible (`offset <= cursor < offset + pageSize`) and no blank window.
- For 6c, a layout-level assertion is fine: render a state with a deep stack and
  assert the header line's *visible* width (strip ANSI, then measure) equals the
  terminal width and contains no partial escape sequence.

**Verify**: `pnpm --filter ppr test` → passes incl. the new reducer tests.

---

## Part 7 — Symmetric `exit` handler in Screen (stop the per-edit leak)

**Finding**: CORRECTNESS-07. `enter()` adds `process.once('exit', …)`; `leave()`
removes the resize listener but not the exit one; `suspend()` calls
`leave()`+`enter()` per editor round-trip, so one exit listener accumulates per
edit → `MaxListenersExceededWarning` corrupts the frame.

**Current state** — `packages/cli/src/ui/screen.ts:54-101`: `enter()` does
`process.once('exit', this.handleExit)`; `leave()` does not remove it; `close()`
does `process.off('exit', this.handleExit)`.

**Step 7.1**: Move `process.off('exit', this.handleExit)` into `leave()` so
`enter`/`leave` are symmetric, and let `close()` just call `leave()`:
```ts
private leave(): void {
  if (!this.open) return;
  this.open = false;
  this.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF);
  this.keyboard.stop();
  this.stdout.off('resize', this.handleResize);
  process.off('exit', this.handleExit);
}

close(): void {
  this.leave();
}
```
Confirm `handleExit` is a stable bound reference (a class field arrow or bound in
the constructor) so `off` removes the same function `once` added — if it is not,
that is the real bug; fix that instead of adding a second registration.

**Verify**: `pnpm build && pnpm --filter ppr test` → passes. Invariant I5 (the
terminal is always handed back) must still hold: `close()` after `enter()` still
writes `CURSOR_SHOW + ALT_SCREEN_OFF`.

**STOP** if `handleExit` needs to survive across a `suspend()` (i.e. the process
could exit *while the editor is open*) — if so, the exit handler must be
re-added by `enter()` (it is) and this fix is still correct, but note it in the
commit.

---

## Part 8 — One `byCreated` comparator; kill the five that miss the id tiebreak

**Finding**: DEBT-01. Eight hand-rolled `created` comparators; five sort on
`created` alone, so same-second entries order non-deterministically (the exact L2
failure) and the copies can drift. This is the repo's own "can the copies
disagree" test failing.

**Current state** — the correct pattern exists at `catalog.ts:69-71` and
`thread.ts:151-158` (`byTime`). The tiebreak-free sorts are at: `links.ts:90`,
`thread.ts:214`, `thread.ts:241`, `ai/tasks.ts:756`, `ai/fallback.ts:104`.

**Step 8.1**: Add one exported comparator module (or export from an existing util
— check `packages/core/src/util/`). Provide both directions and both shapes:
```ts
// Second-resolution `created` ties break on the id, which carries milliseconds
// and is monotonic (L2), so two entries written in the same second order the
// same way everywhere.
export const byCreatedDesc = (a: Entry, b: Entry): number =>
  a.created === b.created ? (a.id < b.id ? 1 : -1) : a.created < b.created ? 1 : -1;
export const byCreatedAsc = (a: Entry, b: Entry): number => -byCreatedDesc(a, b);
```
Provide `{ entry }`-wrapper variants if the call sites need them (e.g.
`thread.ts:214` sorts `{ fact: { entry } }`), or have callers map to the entry
first.

**Step 8.2**: Replace all five tiebreak-free sorts with the shared comparator.
Also route `catalog.ts:69-71` and `thread.ts` `byTime` through it so there is
exactly one definition (they already tiebreak correctly, but the point is one
copy). Do NOT change any sort whose semantics are *not* "by created" (e.g.
search-score sorts, tag-count sorts).

**Verify**: `grep -rn "created < b.created\|a.created ? " packages/core/src` →
only the new comparator module matches. `pnpm --filter @ppr/core test` → passes.
Add one test asserting two entries with identical `created` and different ids
sort deterministically through the shared comparator.

---

## Part 9 — Browse filter uses the real search matcher

**Finding**: DEBT-02. The interactive filter (`visibleEntries`) is a
substring-all-tokens matcher that disagrees with `searchEntries` (order, field
weighting, memory-kind rule) and runs `plainText()` over every entry four times
per keystroke.

**Current state** — `packages/cli/src/ui/state.ts:72-80`:
```ts
export function visibleEntries(view: View): Entry[] {
  const needle = view.filter.trim().toLowerCase();
  if (!needle) return view.entries;
  return view.entries.filter((entry) => {
    const haystack = `${entry.title} ${entry.tags.join(' ')} ${plainText(entry.body)}`.toLowerCase();
    return needle.split(/\s+/).every((token) => haystack.includes(token));
  });
}
```
`searchEntries(entries, query, opts)` in `packages/core/src/search.ts:61` is the
vault's real matcher and returns ranked `SearchHit[]`.

**Step 9.1**: Route the filter through `searchEntries` (map its `SearchHit[]`
back to `Entry[]`, preserving rank). Memoize the result on the `View` keyed by
the current filter string so cursor maths, layout, and status share one
computation instead of recomputing per call. `visibleEntries` is called from
`state.ts:84,89` and `layout.ts:81,131`, so the memo must live where all of them
see it — cache `{ filter, result }` on the view and recompute only when
`view.filter` changes.

**Step 9.2**: The existing `state.test.js` reducer tests assert visible ordering
under a filter — update them to the new (ranked) order, and add one test that the
in-browser filter and `searchEntries` agree on the *set* of matches for a query.

**Verify**: `pnpm --filter ppr test` → passes with updated ordering assertions.

**STOP** if `searchEntries` needs a `now` you cannot supply purely in the reducer
(it defaults `now` internally) — if the reducer has no clock, pass
`{ now: undefined }` and let it default; do not thread a real clock into the pure
reducer.

---

## Part 10 — Quote scheduled argv fully; stop leaking log paths into `schedule ls`

**Findings**: SECURITY-03 / CORRECTNESS-11 (same bug) + CORRECTNESS-10.

**10a. `quote()` only covers whitespace and quotes.** Shell metacharacters (`$`
`` ` `` `;` `&` `|` `(` `)` `*` `?` `~` `<` `>` `#`) pass raw into a crontab line
or `sh -c`.

Current — `packages/cli/src/schedule.ts:162`:
```ts
const quote = (arg: string): string => (/[\s"']/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg);
```
Fix — quote unless the arg is entirely safe characters:
```ts
// Anything outside this set gets single-quoted. Over-quoting a correct argv is
// harmless; under-quoting a vault path with a `$` or `;` in it runs extra shell
// words at 3am. The `--pipe` target stays unquoted on purpose (it is a command
// line the user typed).
const quote = (arg: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
```
Do NOT touch `schedule.pipe` — it stays raw (see `shellCommand`, `schedule.ts:153-156`).

**10b. `schedule ls` reads back argv with the log paths appended.** The plist
emits `<string>` for Label, then ProgramArguments, then two log paths; the
read-back `slice(1)` drops only the Label.

Current — `packages/cli/src/schedule.ts:250`:
```ts
argv: [...raw.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!).slice(1)
```
Fix: extract only from inside the `<key>ProgramArguments</key> … <array> …
</array>` block (scope the regex to that substring), so the trailing
`StandardOutPath`/`StandardErrorPath` strings are never included. A round-trip is
the correctness check.

**Step 10.3** — tests in `packages/cli/test/schedule.test.js`:
- A path containing `;` / `$` / `(` comes back single-quoted; a plain path does
  not; the `--pipe` string is unchanged (extend the existing quoting tests at
  `schedule.test.js:49,86`).
- Round-trip: `plist(schedule, argv)` parsed back by the `ls` reader yields
  exactly `argv` (no log paths).

**Verify**: `node --test packages/cli/test/schedule.test.js` → passes.

---

## Part 11 — Make the packages publishable and fix the onboarding docs

**Findings**: DEPS-01 + DOCS-01. `dist/` is gitignored, no `prepack`, `cli` lists
a nonexistent `README.md`, the README's clone URL is a `yourname` placeholder,
and neither manifest has `repository`/`homepage`.

**Step 11.1**: Add a build-on-pack script to both packages so a published tarball
contains code:
```json
"prepack": "pnpm build"
```
(in `packages/cli/package.json` and `packages/core/package.json`).

**Step 11.2**: Create `packages/cli/README.md` (the `files` array already lists
it). A short package-level readme is fine — one paragraph on what `ppr` is plus a
link to the repo root README. Do not duplicate the whole root README.

**Step 11.3**: Add `repository`, `homepage`, and `bugs` fields to both manifests.
Use the real GitHub URL. **You must obtain the real URL** — check `git remote -v`
first; if it is still a placeholder, STOP and ask the operator for the canonical
URL rather than inventing one.

**Step 11.4**: Fix `README.md:38` — replace `https://github.com/yourname/ppr`
with the real clone URL (same source as 11.3). Also update the stale test count
in the README dev section if you touched test scripts (it says "287 tests" at
`README.md:774` while AGENTS.md says 338 — set it to a claim that is true, or
drop the number).

**Step 11.5**: Add `engines` to `packages/core/package.json` matching the others
(`"node": ">=20.11"`).

**Verify**: `pnpm --filter ppr pack --dry-run` and `pnpm --filter @ppr/core pack
--dry-run` → each lists `dist/**` and a `README.md`; neither errors on a missing
file. `pnpm build && pnpm test` → still green.

**STOP** at 11.3/11.4 if there is no real remote URL to use — do not guess a URL.

---

## Part 12 — Turn on the unused-symbol checks and delete the dead code

**Finding**: DX-02. `noUnusedLocals`/`noUnusedParameters` are off; turning them on
surfaces ~15 dead symbols incl. two dead functions (`configTarget`,
`pruneDefaults` in `commands/settings.ts`) and eleven dead imports. This is the
one lint class `tsc` can add with no new dependency; ESLint/Prettier are
explicitly NOT being added (they would fight the hand-wrapped comment style §6
mandates).

**Step 12.1**: Add to `tsconfig.base.json` (currently has `strict`,
`noUncheckedIndexedAccess`, etc.):
```json
"noUnusedLocals": true,
"noUnusedParameters": true,
```

**Step 12.2**: `pnpm typecheck` now lists every offender. For each: if it is a
genuinely dead symbol (confirm with `grep -rn "<name>" packages/*/src` finding no
use), delete it. If a parameter is deliberately part of a signature but unused
(e.g. an interface-mandated arg), prefix it with `_`. Known offenders from the
audit to expect: `settings.ts` (`configTarget`, `pruneDefaults`, and imports
`mergeConfig`/`setPath`/`validateConfig`/`createTranscriber`/`openVault`/`which`),
`index.ts:7` (`entryJson`/`json`/`out`/`shortId`), `ui/layout.ts:46` (unused
`now` param), `memory.ts:171` (unused binding `y`). Verify each against the live
tree — do not delete anything still referenced.

**Verify**: `pnpm typecheck` → exit 0 with the flags on. `pnpm build && pnpm test`
→ green (deleting dead code must not change any test).

**STOP** if a flagged symbol is exported from `@ppr/core`'s public surface (it
might be intended for external consumers) — report it instead of deleting.

---

## Part 13 — Lower-leverage security & correctness tail

Each is independent and small. Do them in this order; commit per item.

**13a. Predictable audio temp files (SECURITY-04).** `transcribe.ts:11`
`tmpFile` builds `${tmpdir()}/ppr-<pid>-<Date.now()>.<ext>` and writes without
`O_EXCL`. Replace with a per-invocation directory: `await mkdtemp(join(tmpdir(),
'ppr-'))` (mode 0700), put all wav/audio artifacts inside it, and `rm(dir, {
recursive: true, force: true })` in the existing `cleanup()` closures. `input.ts:130`
already uses `mkdtemp` — match it. This file is under `packages/core/src/node/`,
so `node:*` imports are allowed here.
- Verify: `node --test packages/core/test/audio.test.js` (and any transcribe
  test) → passes; no test writes to a predictable shared path.

**13b. Redact key-shaped values in config display (SECURITY-05).** `config list`
(`settings.ts:85`, prints `String(v)`) and `ai status --json` (`settings.ts:219`)
emit values verbatim; `guardSecret` only runs on `config set`. Route any value
whose key matches the existing secret-key pattern OR whose value satisfies the
existing `looksLikeSecret` helper (imported already at `settings.ts:9`) through
`redactSecret` (also already imported) before printing, in both the `config list`
table and the `ai status --json` payload.
- Verify: add a test — a config layer holding a key-shaped `apiKeyEnv` is
  redacted in both `config list` output and `ai status --json`. `pnpm --filter
  ppr test` → passes.

**13c. Stop steering secrets onto the argv (SECURITY-06).** The `guardSecret`
hints and `ppr ai key` help/text recommend `ppr ai key <value>` (argv → shell
history + process table). Reword the hints and `--help` to recommend the prompt
form (`ppr ai key` with no value), and add a one-line note that passing the value
inline records it in shell history. Keep the positional arg working (scripting).
Find the strings with `grep -rn "ai key" packages/core/src packages/cli/src`.
- Verify: `grep -rn "ppr ai key <value>\|ai key sk-" packages/*/src` → the
  recommendation strings now point at the prompt form. `pnpm test` → green.

**13d. Digest-check model downloads (SECURITY-07).** `download.ts:31` fetches
with no integrity check; `models.ts:20` builds URLs from a mutable HF `resolve/main`
ref. Add an optional `sha256` to `ModelInfo` in `models.ts`, hash the stream
during download in `download.ts` (pure-JS streaming hash is fine, but this file
is under `node/` so `node:crypto` is allowed), compare before the final `rename`,
delete the `.part` file and throw a clear `PprError` on mismatch, and verify an
existing file once when `skipExisting` short-circuits. Populate digests for the
models currently listed (fetch each once and record its hash) — if you cannot
obtain them offline, leave `sha256` optional and only enforce when present, and
note in the commit that digests still need filling in.
- Verify: `pnpm --filter @ppr/core test` → passes; a download-path test with a
  stubbed fetch returning wrong bytes throws and leaves no file. If no download
  test harness exists, add a minimal one against a local `node:http` stub (no
  network — the same pattern `providers.test.js` uses).

**13e. Ambiguous exact-title resolve (CORRECTNESS-09).** `catalog.ts:130-131`
returns the newest of N identically-titled entries, while the id and partial-title
branches `throw ambiguous(...)`. Make exact-title consistent: return on exactly
one match, `throw ambiguous(ref, titleExact.map(e => \`${shortId} ${title}\`))`
on more than one.
- Verify: test in `packages/core/test/vault.test.js` — two entries with the same
  title make `resolve(title)` throw ambiguous, listing both. Note this is a
  behavior change (was "newest wins"); the ambiguous error's hint should show how
  to pick one (by id). `pnpm --filter @ppr/core test` → passes.

**STOP** on 13e if an existing test relies on "newest exact-title wins" — update
it to expect the ambiguous error (that was the bug), and say so in the commit.

---

## Part 14 — Performance cluster (personal-vault-safe; matters at 10k+ entries)

All confirmed; all preserve behavior. Do the three S-effort ones (14a–c); the two
M-effort ones (14d, 14e) are worth doing but land them last and revert
individually if any test ordering breaks.

**14a. Hoist the per-term regex in `mentionScore` (S).** `memory.ts:247`
compiles `new RegExp` per term on every call, and it is called per-occurrence
per-entry from `vault.ts:870`. Compile each `DatedItem`'s term regexes once
(cache on the item or precompute before the loop) and reuse. Semantics
(whole-word, per-term count) must not change.

**14b. Memoize `Catalog.entries()`/`timeline()` (S).** `catalog.ts:68-72` re-sorts
the whole map on every call; ~20 call sites hit it per command. Cache the sorted
array and the `timeline()` projection in private fields; invalidate in
`index()`/`upsert()`/`forget()`/`load()`/`invalidate()` (the only mutation
points). Return a defensive copy (or `Object.freeze`) because callers like
`filterEntries` do `.reverse()` in place — confirm by grepping for callers that
mutate the returned array before choosing copy vs. freeze.

**14c. Parallel `stat` in the vault walk (S).** `node-storage.ts:80-89` awaits
`stat` one file at a time. Batch each directory's file entries through
`Promise.all` with a concurrency cap (~64, to avoid fd exhaustion) and recurse
into subdirectories concurrently. Output ordering is not depended on
(`Catalog.load` keys by path) — but confirm that before relying on it.

**14d. Trim the index cache so a capture doesn't rewrite the whole vault (M).**
`catalog.ts:15-18` stores the full `entry` (body included) per path;
`persist()` rewrites the entire cache on every write. Either store only the
derived fields needed to skip a re-parse and re-read bodies lazily, or shard the
cache. Bump `CACHE_VERSION` so old caches are discarded not misread (the fallback
at `catalog.ts:189` already handles a version mismatch). This changes the cache
format only — I1 (files are truth, cache is disposable) must still hold: deleting
`.ppr/cache/index.json` must change nothing but speed. Add/keep a test asserting
that.

**14e. Build the link index once per walk, not per node (M).** `links.ts:20`
rebuilds a `Map` (with `slugify` per entry) on every `forwardLinks` call;
`thread.ts` `neighbours` calls it per frontier node. Introduce a `LinkIndex` built
once per pool (key→entry, id→backlink set, id→title tokens), thread it through
`backlinks`/`forwardLinks`/`related`/`neighbours`/`walkThread`, and keep the
current free functions as thin wrappers that build a throwaway index so the public
API is unchanged. Scores must not change — `links.test.js` and `thread.test.js`
are the characterization baseline; if any score assertion changes, you changed
behavior and must STOP.

**Verify (all of 14)**: `pnpm --filter @ppr/core test` → passes with NO changed
assertions for 14a–c and 14e (behavior-preserving); 14d may change only a
cache-format test you update deliberately. `pnpm typecheck` → 0.

**STOP** on any perf item if a test's *asserted output* changes — these are
optimizations, not behavior changes; a changed result means the optimization is
wrong.

---

## Part 15 — Test the untested load-bearing bits

**Finding**: TESTS-02 (and the coverage note on `node-storage` path guard). These
are pure additions.

**Step 15.1** — `packages/core/test/paths.test.js`: table-driven tests for
`findVault` (`node/paths.ts:29-51`), passing `cwd`/`explicit`/`env` explicitly so
no real home dir is touched. Cover: explicit beats `$PPR_DIR`; `$PPR_DIR` beats a
nearer `.ppr`; nested `.ppr` picks the nearest walking up; no marker anywhere
falls back to `defaultVaultDir`; the upward walk terminates at filesystem root.
Use `mkdtemp` for any directory structure and clean up in `finally`.

**Step 15.2** — add a `node-storage` test asserting the path guard
(`adapters/node-storage.ts:21-28`) rejects `..` escapes and absolute paths (the
audit noted the guard is correct but untested).

**Verify**: `node --test packages/core/test/paths.test.js` → passes; `pnpm test`
→ green.

---

## Part 16 — CI: stop triple-compiling and cancel superseded runs

**Finding**: DX-03. `.github/workflows/ci.yml` runs `pnpm build` then `pnpm
typecheck` (the same check, output discarded) then `pnpm test` (which, after
Part 1, compiles again); no `concurrency` block, so pushes stack up 18 jobs.

**Step 16.1**: Add a concurrency block so superseded runs cancel:
```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```
**Step 16.2**: Drop the redundant `pnpm typecheck` step from CI (`pnpm build`
already fails on any type error). Keep the `typecheck` npm script for local use.
Leave the build+test steps; after Part 1 the test step recompiles, which is
acceptable — do not try to share build artifacts across steps in this plan (out
of scope).

**Verify**: `.github/workflows/ci.yml` parses (it is YAML; a `yamllint` or a
GitHub Actions dry parse is enough) and still runs `pnpm build` and `pnpm test`
on the matrix. No local command changes.

---

## Test plan (whole)

New/changed tests, by file:

- `packages/core/test/*` — vault rename-safety (Part 3), stable id + broken-YAML
  round-trip (Part 4), shared comparator determinism (Part 8), config
  vault-layer strip + prototype (Part 2), download digest mismatch (13d), exact-
  title ambiguity (13e), `findVault` + path guard (Part 15).
- `packages/cli/test/*` — browser failing-write is non-fatal (Part 5), `g`/shift-`g`
  + `restack` offset + header width (Part 6), browse filter == search (Part 9),
  schedule quoting + argv round-trip (Part 10), config redaction (13b).

Model new core tests after `packages/core/test/vault.test.js` (Vault over an
in-memory store) and new CLI reducer tests after
`packages/cli/test/state.test.js`. No test may reach the network or run
`osascript`; the CLI harness must keep redirecting `XDG_CONFIG_HOME`/`PPR_DIR`
into a temp dir (see the existing `cli.test.js` harness).

## Done criteria

ALL must hold:

- [ ] `pnpm build` exits 0
- [ ] `pnpm typecheck` exits 0 (with `noUnusedLocals`/`noUnusedParameters` on)
- [ ] `pnpm test` exits 0; all new tests listed above exist and pass
- [ ] `grep -rn "yourname" README.md` → no matches
- [ ] `grep -rn "created < b.created" packages/core/src` → only the shared comparator module
- [ ] `pnpm --filter ppr pack --dry-run` lists `dist/**` and a README with no missing-file error
- [ ] A vault-layer `.ppr/config.json` setting `ai.command`/`ai.baseUrl` does not change effective config (test asserts it)
- [ ] No files outside the Scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report (do not improvise) if:

- Any "Current state" excerpt does not match the live code (drift since `e773b65`).
- There is no real GitHub remote URL for Part 11 (do not invent one).
- A perf optimization in Part 14 changes an asserted test result (means it is wrong).
- The vault-layer strip in Part 2 would break a legitimate reader you find that
  reads these keys from somewhere other than the merged config.
- Any step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Part 2 is the security spine.** A reviewer should check that the forbidden-key
  list is applied to the *vault layer only* (the global layer must keep them) and
  that `config set --local` refuses them with a message naming the global file —
  mirror the existing hooks refusal exactly. If a new shell/endpoint config key is
  ever added, it must be added to `VAULT_FORBIDDEN_PATHS` in the same commit.
- **Part 4** changes id derivation for id-less files. It must never affect files
  ppr wrote (they always carry an `id`). If a future migration re-keys adopted
  files, provenance pointers written before it will still dangle — that is
  pre-existing, not introduced here.
- **Part 8**: any new code that orders entries by `created` must import the shared
  comparator, never re-hand-roll it — that is the whole point (L2 + "copies drift").
- **Part 9**: the browse filter now shares `searchEntries`, so a change to search
  ranking now visibly changes the browser too — that coupling is intended (one
  matcher), and the "filter == search" test guards it.
- **Part 14d** (cache format): the invariant to protect is I1 — deleting the cache
  must change nothing but speed. Keep the version-mismatch fallback.
- **Deferred**: Screen/Keyboard stream-injection seam (TESTS-03) and model-derived-
  frontmatter validation (SECURITY-09) were judged lower-leverage than the rest and
  are not in this plan; revisit if the TUI cleanup logic or the fact-push path
  changes. The `graph()`/`GraphEdge` dead export (DEBT-03) is left in place because
  it is a public `@ppr/core` symbol and removing it is a breaking change better
  bundled with the first real API cleanup.
