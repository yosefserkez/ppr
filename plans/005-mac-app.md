# Plan 005: ppr for Mac — a surface for the engine that already exists

> **Verdict: BUILD, STAGED — and not the way the idea assumes.** I8 has already
> paid for this: a second host is a wiring exercise. But the benchmarks say the
> obvious route (a native Swift app shelling out to `ppr … --json`) cannot
> deliver the one interaction the app exists for, and the "adaptive interface"
> as described would re-introduce the exact bug L17 was written about.
>
> **Executor instructions**: stage 0 is a two-week spike with a written
> go/no-go. Do not start stage 1 until it passes. Stage −1 (the core
> prerequisites) is real work inside `packages/core` and is worth doing even if
> the app is never built.

## Status

- **Priority**: P3 — after 003 and 004, both of which the app wants to surface
- **Effort**: XL. Stage −1 is M; stage 0 is two weeks; stage 1 is a product
- **Risk**: HIGH — not technical risk, *commitment* risk. A GUI is a permanent
  second maintenance surface with signing, updates, crash reports, and users who
  cannot read a stack trace
- **Depends on**: 003 and 004 shipped (the app should surface finished commands,
  not become the reason they get designed under UI pressure)
- **Category**: new host
- **Planned at**: `e773b65`, 2026-08-10
- **Reviewed in**: [002-review.md](002-review.md)

---

# Part I — PRD

## Problem

From the idea file, and it is the best sentence in it:

> *"i want to input without thought and retrieve without effort. a second brain
> that emerges instead of being built."*

ppr's engine already delivers the second half of that. `ppr context` hands
another tool a grounded snapshot with no model run; the memory layer distils
standing facts out of entries without anyone curating them; `ppr brief` is
arithmetic over dates. The thing that *emerges instead of being built* is
already shipped.

What is missing is the first half. Capture currently costs: focus a terminal,
recall which of `write` / `dump` / `+` / `remind` you want, type it correctly
enough that I11 does not reject it, and quote a phrase so it is not mistaken for
a command. Each of those is defensible in isolation and correct for a CLI. Their
sum is *thought*, at the exact moment the product promises none.

## Who this is for

Two audiences, and conflating them is the main way this plan fails.

**The maintainer.** Already has the CLI, already types fast, wants the capture
latency gone and the brief ambient rather than summoned. Everything in stage 1
is for this person and it is a real product on its own.

**"Normies"** (the idea's word). Do not have a terminal, have never heard of
frontmatter, and will judge the whole thing on whether their notes are still
there in a year. This audience is **out of scope until sync exists** ([006](006-cloud-sync.md)) —
not because they do not matter but because an app that requires manually
choosing a folder, and offers no way to see the notes on a phone, does not
actually serve them. Building the normie UI before the normie infrastructure
produces a demo, not a product.

## Jobs to be done (stage 1)

1. *"Something occurred to me. Get it into the vault before the thought
   finishes."* — global hotkey, panel, type, ⌘↵, gone. Sub-100 ms to first
   keystroke.
2. *"What was I doing?"* — today, this week, the thread I was on, without
   remembering a command.
3. *"Where did I write about that?"* — search as I type, over the whole vault,
   with results before I stop typing.
4. *"What is coming up?"* — the brief, present without being asked for.

## Non-goals

- **Not a markdown editor.** §11: *"Do not build a text editor."* A plain
  `<textarea>` for capture, and "Open in \$EDITOR" / "Reveal in Finder" for
  anything longer. The moment there is a formatting toolbar, this plan has
  failed.
- **Not a second engine.** Any logic the app needs goes into `@ppr/core` and
  becomes available to the CLI on the same commit. If the app has business logic
  in it, that is a bug (the generalisation of §11's "do not let the CLI
  accumulate logic that belongs in core").
- **No feature the CLI does not have.** The app is a surface. A capability that
  exists only in the GUI splits the product in two.
- **No account, no login, no telemetry** in stage 1. "Bring your own key" is the
  model (§2).
- **No sync.** Point it at a folder. If that folder is in iCloud Drive or
  Dropbox, sync is somebody else's problem and it works today.

## Requirements

**R1.** Capture panel opens on a global hotkey in under 100 ms and accepts
typing immediately, whatever the vault size.

**R2.** Search is incremental and returns in under 50 ms at 10 000 entries.

**R3.** A file changed by vim, by the CLI, or by `git pull` is reflected in the
app within a second, without a manual refresh. (I1 — the markdown is the source
of truth, and an app that disagreed with the disk would be the most expensive
possible violation of it.)

**R4.** Every write the app makes emits the same events as the CLI's, so hooks
fire identically (I13).

**R5.** The app never writes a field the CLI would not, and unknown frontmatter
round-trips (I3).

**R6.** Quitting the app changes nothing about the vault. Deleting the app
changes nothing about the vault.

**R7.** Adaptation is limited to presentation and ordering. See Part III.

## Success metrics

- Captures per day go up and the CLI's capture usage goes *down* — that is the
  latency win showing up in behaviour.
- Median hotkey-to-first-keystroke under 100 ms on a 10 000-entry vault.
- Zero divergence bugs: no report of the app showing something the CLI does not,
  or vice versa.

---

# Part II — The architecture decision, and the measurement that made it

## The obvious route, and why it fails

The purest design is a native SwiftUI app that shells out to `ppr … --json`. It
is exactly I13, it needs no new API, it makes the GUI just another consumer, and
it would be a genuinely satisfying proof that the extension story works.

Measured, on synthetic vaults with realistic entry sizes:

| Vault | `ls --json` cold | `ls --json` warm | `search --json` | `context --json` |
|---|---|---|---|---|
| 800 entries | 168 ms | 92 ms | 102 ms | — |
| 6 000 entries | 668 ms | 181 ms | 299 ms | 172 ms |

Node's startup is ~25 ms of that. The rest is `Catalog.load()`, which re-stats
every file on every invocation (I1, deliberately) and parses
`.ppr/cache/index.json` — **8.2 MB at 6 000 entries**, because the cache holds
each entry's full `body` (`packages/core/src/catalog.ts:10` and the `entry`
field of each record). It is a complete second copy of the vault in one JSON
document, re-read per command.

90–300 ms is invisible for "save this note" and fatal for "search as I type",
which is R2 and the interaction the whole app is justified by. And it gets worse
linearly with the vault, which is to say: worse exactly as the product succeeds.

## The options, judged

| | Route | Latency | Reuses core | Bundle | Verdict |
|---|---|---|---|---|---|
| A | SwiftUI + spawn `ppr` per action | ✗ R2 fails | ✓ verbatim | tiny | Rejected on the numbers |
| B | SwiftUI + warm Node sidecar, JSON-RPC over stdio | ✓ | ✓ verbatim | ~60 MB | Viable; invents a protocol and a process lifecycle |
| C | Electron + `@ppr/core` in the main process | ✓ best | ✓ verbatim, in-process | ~90 MB | **Recommended for stage 1** |
| D | Tauri + Node sidecar | ✓ | ✓ verbatim | ~25 MB | B's complexity with C's UI stack |
| E | Native Swift, core reimplemented | ✓ | ✗ **two engines** | tiny | Rejected — throws away the reason I8 exists |

**E is the one to be loud about.** Two implementations of entry parsing, id
generation, the thread walk, and reconciliation will drift, and they will drift
in the direction of the one that has users complaining. Every invariant in
AGENTS.md would need enforcing twice. I8 exists precisely so that this is never
necessary, and the only way to collect on it is a host that can run TypeScript.

**Recommendation: C.** One language, one engine, `new Vault(...)` in the main
process, and the renderer talks to it through a typed IPC bridge that mirrors
the `Vault` API one-to-one and contains no logic of its own. Revisit D if bundle
size becomes a real complaint from real users; do not pre-optimise for it.

The cost of C is honest and should be stated: the app will not feel native. A
web view with good typography, no chrome, and instant response reads as "fast
tool" rather than "Mac app", and for a capture panel that is enough. If it turns
out not to be enough, B is the migration path and the core boundary is unchanged
by it.

## What this means for the CLI

Nothing. The CLI keeps spawning per command; 90 ms is fine for a CLI and the
re-stat is I1 doing its job. The only shared work is stage −1's incremental
refresh, which the CLI does not need but is not harmed by.

---

# Part III — The adaptive interface: what to build and what not to

The idea:

> *"interface adapts based on time of day, usage behaviour, etc. for example if
> i often switch to dump then that becomes new default."*

This is the part most likely to be built with enthusiasm and regretted, because
ppr has already paid for this exact lesson. L17:

> *"No heuristic can separate a mistyped command from a short note — the
> information is not in the text. … When a guess would sometimes destroy intent,
> make the intent explicit instead of improving the guess."*

An input that silently changes where typed text lands, based on inferred habit,
is that bug with better fonts. It is worse in a GUI than in a terminal: there is
no visible command line to re-read, no `^C`, and no scrollback showing what you
actually ran. And it fails hardest for the audience it is aimed at — a normie
cannot debug why their note went somewhere unexpected, because they never knew
there was a somewhere.

## The rule

> **Adapt what is shown, and in what order. Never adapt what an action means.**

This is I4 restated for a GUI: *interactive is a rendering mode, never a change
in semantics.* Ordering is rendering. Defaults are semantics.

## Allowed, and worth building

- **Frecency ordering in the command palette.** Standard, learnable, reversible
  by typing the name — the same contract Spotlight and every editor palette has.
- **Time-of-day surfacing.** The brief pinned at the top before 10:00; today's
  entries after. Nothing is hidden, only reordered.
- **A card suggesting a schedule.** *"You have run this 9 mornings in a row —
  schedule it?"* with the exact `ppr schedule add …` it would run. A suggestion
  a person accepts is explicit intent; the idea's instinct here is right and
  this is its safe form.
- **Remembered mode per context**, if and only if the current mode is visible in
  the panel at all times and one keystroke changes it.
- **Ambient memory.** Facts relevant to what is being typed, shown beside the
  input, never inserted into it. This is the "second brain that emerges" idea
  and it is already computable — `Vault.relevantFacts()` and `Vault.continues()`
  (`vault.ts:623`), which the CLI already prints unasked after a capture.

## Forbidden

- Changing the destination of the main input based on inference.
- Choosing a `kind` without showing it before the write.
- Hiding a rarely-used action. Discoverability in a GUI is the whole map.
- Any adaptation whose state is not inspectable and resettable in one place.

## The mitigation that makes the whole question smaller

**Reclassification after the fact.** A capture that landed as the wrong kind can
be changed with one keystroke from the confirmation toast, and from the entry
row afterwards. That turns a wrong guess from a loss into a correction, which is
the difference between a guess that is allowed to be wrong and one that is not.
It is also just a `vault.update({ kind })` call, so it costs nothing.

Build that first, then decide how much adaptation you want. With cheap
correction, a little inference is fine. Without it, none is.

---

# Part IV — Stage −1: core prerequisites

Real work in `packages/core`, valuable independently, and the app is not
buildable to R1/R3 without it.

## −1.1 A `Watcher` port, and incremental catalog refresh

R3 requires the app to notice external changes. Today the only mechanism is
`Vault.refresh()` (`vault.ts:1248`) → `Catalog.load()`, which re-stats every
file. At 6 000 entries that is ~600 ms, so watching a directory and calling it
per change is not viable.

Two pieces:

- A sixth optional port in `ports.ts`, in the shape of `Fetcher`:
  ```ts
  /** Optional. Hosts that can watch the filesystem supply one; the CLI does not. */
  export interface Watcher {
    watch(prefix: string, onChange: (paths: string[]) => void): () => void;
  }
  ```
  Optional, like `Transcriber` and `Fetcher`, so nothing existing changes and
  `MemoryStorage` runs the portable path unaffected (I8 intact).
- `Catalog.refresh(paths: string[])` — re-stat and re-parse only the named
  paths, drop removals, keep the rest of the cache. The cache is already keyed
  by path with `mtime`/`size`, so this is a narrowing of `load()`, not a new
  mechanism.

**Tests** (`core/test/vault.test.js`, alongside "files edited outside ppr are
picked up"): *"one file changing does not re-read the vault"*; *"a file deleted
outside ppr leaves the catalog on the next refresh"*.

## −1.2 Stop caching entry bodies (optional, measured)

8.2 MB / 6 000 entries, parsed on every CLI command. Storing a search-ready
projection and reading bodies on demand would cut cold start substantially.

**Measure before doing it.** With −1.1 in place the app loads once, so this is a
CLI improvement rather than an app prerequisite, and it trades a smaller cache
for a read-per-body in `ppr show`. Listed here because the app is what surfaced
it; schedule it on its own merits.

## −1.3 Pagination on list reads

`Vault.list()` returns everything and the renderer would hold all of it. Add
`offset` to `ListQuery` (`limit` exists). Small, and it keeps a 50 000-entry
vault from being an app problem.

## −1.4 Confirm the event channel is enough to drive a UI

`VaultOptions.onEvent` already exists and AGENTS.md §4 already says *"a mobile
app would redraw a list."* Verify in the spike that `entry.created` /
`entry.updated` / `entry.removed` carry enough to update a view without a
reload. They should — every payload is complete by design. If one does not, that
is a core fix, not an app workaround.

---

# Part V — Stage 0: the spike (two weeks, then a written decision)

Build exactly one thing: **the capture panel.**

- Electron, one window, global hotkey (`⌥Space` default, configurable).
- `@ppr/core` + `NodeStorage` in the main process, one `Vault`, loaded at launch.
- A `<textarea>`, a visible mode chip (log / dump / reminder), ⌘↵ to save.
- The saved-entry toast, with reclassify.
- Nothing else. No list, no search, no settings, no icon polish.

**Measure and write down:** hotkey-to-first-keystroke at 800 / 6 000 / 20 000
entries; memory at each; launch time; the size of a signed, notarised build.

**Go/no-go, decided against the numbers, not against enthusiasm:**

| Go if | No-go if |
|---|---|
| First keystroke < 100 ms at 20 000 entries | It needs a loading state to feel acceptable |
| Idle memory < 300 MB | It is a second app you notice running |
| You use it instead of the terminal for a week without deciding to | You keep reaching for the terminal |

A no-go is a good outcome: it costs two weeks and it keeps a permanent second
maintenance surface from existing. Say so in the spike doc before starting, so
the decision is not made retroactively.

---

# Part VI — Stage 1: the app

Assuming go. Four surfaces, in this order, each shippable.

1. **Capture** — the spike, hardened. Paste-image → attachment. Drag-drop a
   file. Voice via the existing `Transcriber` port.
2. **Today** — today / this week, grouped, with the brief above it before 10:00.
   Reclassify, complete a reminder, open in \$EDITOR, reveal in Finder.
3. **Search** — incremental, over the in-memory `Vault`, with a thread view
   (`Vault.thread()`) as the "where had I got to" surface. This is where
   `Vault.tidy()` from plan 004 gets a home too: a "needs attention" section.
4. **Ambient memory** — relevant facts beside the input while typing; the
   "continues a thread" line the CLI already prints.

**Structural rules for the codebase**, and they are the whole difference between
this ageing well and badly:

- Lives in `apps/mac/` in this repo, depending on `@ppr/core` by workspace
  version. One repo, one commit, no version skew between engine and app.
- The renderer imports **nothing** from `@ppr/core`. It talks to a preload
  bridge whose methods mirror `Vault`'s one-to-one and which contains no logic.
  A method that needs logic is a missing `Vault` method.
- Reducer/rendering split, as `ui/state.ts` and `ui/layout.ts` do for the
  terminal. AGENTS.md §4: *"Any new interactive surface follows the same
  shape."* It applies to React as much as to the TUI, and it is what makes the
  app testable without spawning Electron.
- No new dependency in `@ppr/core` for the app's sake. Ever.

**Distribution.** Developer ID signing + notarisation, direct download,
Sparkle for updates. The app is sandboxed *except* for the user-chosen vault
folder (security-scoped bookmark). No Mac App Store in v1 — the sandbox rules
around \$EDITOR and arbitrary folder access make it a fight, and a fight is not
worth a distribution channel this audience does not use.

**Licensing.** Memory of the project's direction says: open source now, paid
maybe later. The clean line, if that day comes: `@ppr/core` and the CLI stay
open under the current licence; `apps/mac` is the separable, differently
licensed artifact. Deciding the *split* now costs nothing and keeps the option;
deciding the *price* now is premature.

---

# Part VII — Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The app becomes the product and the CLI rots | HIGH | Rule: no feature exists in the app that does not exist in the CLI. Enforce at review |
| Logic leaks into the renderer, and the two hosts drift | HIGH | The IPC bridge mirrors `Vault` exactly; a bridge method with an `if` in it is a code-review failure |
| GUI users file bugs that need GUI debugging | MED | Ship "Copy diagnostics" that runs `ppr doctor` and the version; it is already a registry of what can be wrong (`cli/src/setup/checks.ts`) |
| Signing, notarisation, and updates rot between releases | MED | CI does it on tag from day one, not by hand |
| Adaptive UI misfires and a normie loses a note | HIGH | Part III's rule + reclassification; nothing inferred changes a destination |
| A 20 000-entry vault makes launch feel slow | MED | Stage 0 measures it before anything is committed to |
| Two-week spike becomes a two-month spike | MED | The go/no-go criteria are written before the spike starts |

---

# Part VIII — The website (the other half of idea 1)

Split it, because the two halves have nothing in common:

- **Docs + marketing site — do it, and soon, independent of everything here.**
  Static, in-repo, one page plus generated command docs from `--help`. It is the
  distribution channel for the CLI whether or not the app is ever built, and it
  is a day of work. Not planned in detail here because it needs no design.
- **A web app** — a third host, and it is only useful if the vault is reachable
  from a browser, which is sync, which is [006](006-cloud-sync.md). Held with
  006.

---

# Part IX — Open questions

1. **Electron or Tauri?** Recommended Electron for stage 0 because the spike's
   purpose is a latency number, and Electron gets there in a day. Re-ask after
   the numbers, with bundle size as the only argument for switching.
2. **Where does the vault folder come from on first run?** Recommendation: the
   same `findVault()` the CLI uses (`$PPR_DIR`, nearest `.ppr`, `~/ppr`), then a
   folder picker. Not a new discovery mechanism.
3. **Does the app run hooks?** It shares `onEvent`, but `runChild`,
   `PPR_HOOK_DEPTH`, and the "user layer only" security rule all live in
   `cli/src/hooks.ts` — CLI code the app cannot import. Recommendation: **no
   hooks in stage 1**, and say so plainly, because a half-implementation that
   ignores `PPR_HOOK_DEPTH` is L24 waiting to happen. If hooks are wanted later,
   the honest move is lifting the hook runner into a shared package with its
   depth guard intact — a plan of its own.
4. **iOS.** The same core, the same argument, a much harder host (no
   subprocesses, no \$EDITOR, sandboxed storage). Not in scope. Worth noting
   that it, too, is gated on sync.
