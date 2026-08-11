# 002: Review of the three ideas — verdicts and routing

> Reviewed 2026-08-10 against `e773b65` plus the uncommitted 001 remediation
> work on `advisor/001-audit-remediation`. This document is the **verdict
> layer**: what each idea is really asking for, what ppr already has, what it
> would cost, and whether to build it. The plans it routes to are the
> executable half.

Source: [`plans/002-ideas.md`](002-ideas.md).

## Verdicts at a glance

| # | Idea (as written) | Verdict | Plan | Effort | Risk |
|---|---|---|---|---|---|
| 3 | Daily report pulling Slack / GitHub / tool calls into a log | **BUILD** — mostly as a plugin, plus three small CLI affordances | [003](003-daily-report.md) | S–M | LOW |
| 2 | "cleanup"/prune, compaction, biome-style safe/unsafe apply | **BUILD, REDUCED AND RENAMED** — `ppr tidy`, nothing deletes | [004](004-tidy.md) | M | MED |
| 1a | Mac app, adaptive interface, normie-focused | **BUILD, STAGED** — but not the way the idea assumes; see the benchmark below | [005](005-mac-app.md) | XL | HIGH |
| 1b | ppr cloud sync (Obsidian Sync-alike), website | **DO NOT BUILD YET** — shape it now, build it on a stated trigger | [006](006-cloud-sync.md) | XL | HIGH |

Recommended order: **003 → 004 → 005**, with 006 held. 003 and 004 are
independent of each other and of 005. Nothing in 005 or 006 should start until
003 and 004 have shipped, for a reason that is in the ideas file itself: the
Mac app is a *surface* for commands, and two of the commands it most wants to
surface (a day's report, a hygiene pass) do not exist yet.

---

## The one measurement that changed a recommendation

The idea for the Mac app implies a front-end talking to ppr. The obvious and
most architecturally pure route is "shell out to `ppr … --json`" — it is exactly
I13, it needs no new API, and it makes the GUI just another consumer. I
benchmarked it before recommending it, on synthetic vaults with realistic entry
sizes (~160 words median, 4.2 MB at 800 entries, 31 MB at 6 000):

| Vault | `ls --json` cold | `ls --json` warm | `search --json` | `context --json` |
|---|---|---|---|---|
| 800 entries | 168 ms | 92 ms | 102 ms | — |
| 6 000 entries | 668 ms | 181 ms | 299 ms | 172 ms |

Node's own startup is ~25 ms of that; the rest is `Catalog.load()`, which
re-stats every file (I1, by design) and parses `.ppr/cache/index.json`. That
file is **8.2 MB at 6 000 entries** because it caches the full `body` of every
entry (`packages/core/src/catalog.ts:10`, and the `entry` field in each cache
record) — it is a complete second copy of the vault in one JSON document,
re-parsed on every single command.

Two conclusions follow, and both are in plan 005:

1. **Spawn-per-interaction is fine for actions and wrong for typing.** 90–300 ms
   is invisible when you hit ⌘↵ to save a note. It is unusable for
   search-as-you-type, which is the single interaction a "retrieve without
   effort" app lives or dies on.
2. **Therefore the Mac app must hold a `Vault` in memory**, which means the host
   must be able to import `@ppr/core` — which rules out a pure-Swift app unless
   you are willing to either reimplement core (destroying the reason I8 exists)
   or run a warm Node sidecar anyway.

This is the payoff I8 was written to buy, and it is only collectable by a host
that can run TypeScript. That is a real constraint on the "native Mac app"
instinct and it is better known now than after a month of SwiftUI.

---

## What each idea is actually asking for

### Idea 3 — the daily report

The idea already contains its own correct answer: *"perhaps not even a plugin
but merely an alias or schedule command that pipes a collection of details into
my ppr log."* That is I13 verbatim. Almost none of this is ppr's job.

What review found that the idea did not anticipate:

- **`gh` is easy; Slack is the whole problem.** GitHub ships a real CLI with
  `gh api` and `gh search commits`. Slack's official `slack` CLI is for building
  Slack *apps*, not for reading your own messages — a real collector needs a
  user token against the Web API. Any plan that treats "use the native CLIs" as
  uniformly available is planning on something that does not exist.
- **The composition problem is the design problem.** Two sources is a script;
  six sources is a plugin nobody can extend. The answer is `run-parts`: a
  directory of collector executables, concatenated. ppr never learns what Slack
  is, and adding a source is a five-line shell script.
- **Three genuine gaps in ppr**, all small: no `--source` flag on any capture
  command even though `Vault.dump()` accepts one; `ppr schedule` has a closed
  set of two jobs (`packages/cli/src/schedule.ts:21`) so a collector cannot be
  scheduled by ppr at all; and re-running a collector twice a day produces two
  entries with no way to say "this is the same day's report."

Verdict: build the plugin and close those three gaps. Nothing else.

### Idea 2 — cleanup / prune / compact

This is the idea with the sharpest tension against the project's own promise.
Read together:

> *"delete ppr tomorrow and your notes are exactly as readable as they are today"* (AGENTS.md §1)
> *"I2. No AI failure costs the user their words."*

…and then the idea: a command that uses a model to score entries as meaningless
and remove them. That is I2 pointed backwards — a feature whose entire premise
is a model deciding which of your words to stop keeping. Shipped as `prune` with
an `--unsafe` auto-apply, one bad model day silently eats a year of a person's
journal, and the "biome" analogy does not hold: biome's fixes are mechanically
verifiable and `git checkout` away, whereas "this log was meaningless" is a
judgement with no ground truth and no undo unless the vault happens to be
committed.

But there is a real and valuable command underneath it, and the review found
that ppr already has most of the machinery:

- **Facts are a projection, not data.** AGENTS.md §5 says it outright — delete
  `memory/` and `ppr memory learn --all` rebuilds it. Retiring a stale fact
  therefore loses nothing, and `status: retired` / `supersededBy` already exist
  (`packages/core/src/memory.ts:38`, `:182`). *This is where pruning is safe,
  and it is the only place.*
- **`from` provenance is an unused high-signal noise detector.** Every fact
  records the entry ids it came from. Invert it and you get, for free: which
  entries have never contributed a fact, are linked by nothing, are referenced
  by nothing, and appear in no thread walk. That is a defensible definition of
  "low signal" that needs **no model at all**.
- **Near-duplicate detection is already half-written.** `factKey`
  (`memory.ts:210`) normalises a fact's text to collapse exact repeats. The same
  normalisation over entry bodies gives duplicate detection for the reference
  cases the idea mentions.

So: build `ppr tidy` — a read-only, deterministic hygiene *report* first;
fact retirement (reversible) second; archival-not-deletion third; and an
AI-assisted merge queue last, gated, never auto-applying. Rename away from
`prune`, because the name is a promise about what the command does to your
files.

### Idea 1 — Mac app, adaptive interface, cloud sync, website

Four products in one bullet. They separate cleanly by risk and by dependency:

| Piece | Depends on | Verdict |
|---|---|---|
| Mac app, local vault only | nothing (I8 already paid for it) | build, staged |
| Adaptive interface | the app | build a **narrow** version; the broad version is L17 all over again |
| Cloud sync | infrastructure, a company, and a threat model | hold |
| Website | split: docs/marketing now; web app depends on sync | docs now, app held |

The adaptive-interface part deserves its own warning here because it is the
part most likely to be built enthusiastically and regretted. The idea:
*"if i often switch to dump then that becomes new default."* ppr has already
paid for this lesson, in L17:

> *"No heuristic can separate a mistyped command from a short note — the
> information is not in the text. … When a guess would sometimes destroy
> intent, make the intent explicit instead of improving the guess."*

An interface that silently changes where typed text lands based on inferred
habit is the same bug with a nicer surface, and it is worse in a GUI, because in
a GUI there is no `^C` and no visible command to re-read. The rule plan 005
adopts: **adapt what is shown and in what order; never adapt what an action
means.** Surfacing the brief at the top because you read it every morning is
good. Making ⌘↵ mean "dump" today and "log" tomorrow is not.

The cloud-sync piece runs straight into AGENTS.md §11 — *"Do not add a database,
an index server, or a sync daemon. Git is the sync story."* Plan 006 argues that
rule is about ppr the CLI, not about a separate product, and that the right
shape is `ppr-sync` as a PATH plugin over a managed git remote. It still
recommends holding, for reasons of sequencing rather than principle.

---

## Cross-cutting findings (not scheduled, recorded so they are not lost)

- **The index cache stores full bodies.** 8.2 MB / 6 000 entries, parsed per
  command. It is the reason cold start is 668 ms at that size. Not urgent for a
  CLI, load-bearing for 005. Fixing it (store a search-ready projection; read
  bodies from disk on demand) is a core change worth doing before the app, and
  it is listed as a prerequisite in 005 rather than a plan of its own.
- **No `--source` on capture commands.** `Vault.dump()` takes `source`
  (`packages/core/src/vault.ts:667`) and no CLI path sets it. Every
  machine-generated entry is therefore indistinguishable from a typed one, which
  matters for 003 (provenance) and 004 (a robot's log should be prunable on
  different terms from a human's). Closed in 003.
- **`ppr import` still does not exist** — carried over from 001's direction
  findings. 003 makes it more wanted, not less: a day's report is an import.
  Still deferred; a collector calling `ppr dump` is sufficient for now.
- **`ppr schedule` has a closed job set.** Reasonable when there were two jobs.
  It becomes the reason a user cannot schedule their own collector. 003 widens
  it to *any `ppr-*` external subcommand* — not to arbitrary shell, which keeps
  L22's absolute-path discipline intact and keeps the scheduler running ppr.

## Ideas considered and rejected outright

- **A `ppr daemon` / long-running background service** to make the GUI fast.
  §11 forbids the sync daemon; a read daemon is a different thing but it brings
  the same costs (a lifecycle, a socket, a stale-state class of bug, an
  autostart entry). The app holding its own in-process `Vault` gets the same
  latency with none of it. See 005.
- **A `ppr prune --unsafe` that deletes entries.** See above. 004 offers
  archive-not-delete instead, and the archive is still markdown in the vault.
- **A plugin registry / manifest to manage collectors.** §11, explicitly. The
  collector directory in 003 is `run-parts`, not a registry: no versions, no
  metadata, no install step, just executables in a directory.
- **Embedding / vector search to power the app's retrieval.** §11 again. The
  benchmarks above say lexical search answers in 100–300 ms cold and will answer
  in single-digit milliseconds from a warm in-process `Vault`. There is no
  problem here to solve.
