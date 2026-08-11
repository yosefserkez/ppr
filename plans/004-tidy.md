# Plan 004: `ppr tidy` — keep the store worth reading, without deleting anybody's words

> **Verdict: BUILD, reduced and renamed.** The idea as written — an AI-scored
> `prune` with a biome-style unsafe auto-apply over entries — should not be
> built; it inverts I2. The command underneath it should, and ppr already has
> most of the signals it needs, none of which require a model.
>
> **Executor instructions**: the four phases are ordered by how much they can
> cost a user if they are wrong: phase 1 can cost nothing (it is a report),
> phase 4 can cost a paragraph. Do not reorder them. Do not start phase 4
> without an explicit decision from the maintainer — it is the only phase that
> asks a model for a judgement. `pnpm build && pnpm typecheck && pnpm test`
> between phases; update `plans/README.md` when done.

## Status

- **Priority**: P2 (P1 for the `memory/` half — see "the wall", below)
- **Effort**: M — phase 1 is S, phases 2–3 are S each, phase 4 is M
- **Risk**: MED overall; LOW for phases 1–2, MED for 3, HIGH for 4 (which is
  why 4 is gated)
- **Depends on**: nothing. Benefits from 003's `--source` flag but does not
  need it
- **Category**: feature (core + CLI), data hygiene
- **Planned at**: `e773b65`, 2026-08-10
- **Reviewed in**: [002-review.md](002-review.md)

---

# Part I — PRD

## Problem

Two different problems wear the same clothes, and the idea file merges them.
They need separating, because one is cosmetic and one is a functional wall.

**Problem A — the fact store has a hard budget and nothing enforces it.**
`FACTS_IN_PROMPT = 150` (`packages/core/src/vault.ts:127`). Under that number,
retrieval is the design AGENTS.md §4 describes: send *everything*, rank
lexically above it, let dates be arithmetic. Over it, `relevantFacts()`
(`vault.ts:1213`) silently degrades to a per-candidate lexical slice — the same
guessing that "the corpus is small enough to fit in a prompt" was supposed to
make unnecessary. Worse, `context()` (`vault.ts:783`) with no query returns
`this.facts()` **uncapped**, so every `ppr context` handoff — the point of the
whole product, per AGENTS.md §4 — grows without limit as the store does.

Nothing today retires a fact whose sources were deleted, whose date passed and
does not recur, or that was superseded in substance but not in frontmatter. The
store only grows. This is not tidiness; it is the maintenance the architecture
requires and does not have.

**Problem B — the timeline accumulates entries that are not worth reading.**
A four-word log from eleven months ago that nothing links to, that no fact was
ever drawn from, and that nobody has opened since. Individually harmless;
collectively they are what makes `ppr ls` and `ppr recap` less useful every
month, and they are the reason the idea file was written.

## Who this is for

Someone eighteen months into using ppr daily. Everything here is invisible and
unnecessary in month one, which is why it is P2 for entries and P1 for facts —
the fact store hits its wall much sooner than the timeline hits annoyance.

## Jobs to be done

1. *"Tell me what in here is dead weight, and be specific enough that I believe
   you."*
2. *"Clean up the fact store for me. I do not want to curate it by hand — that
   was the point of it being a projection."*
3. *"Get the noise out of my lists without deleting anything, ever."*
4. *"If you are going to use a model, ask it something I can check at a glance."*

## Non-goals — and one of them is the whole point

- **Nothing this command does may delete an entry.** Not with `--force`, not
  with `--unsafe`, not with a confirmation prompt. The product promise is
  *"delete ppr tomorrow and your notes are exactly as readable as they are
  today"*, and a ppr that removes files it decided were low-value has broken
  that promise in the one direction that cannot be undone. `ppr rm` exists and
  is a human typing about one entry they named; that is different.
- **No score is shown as a number.** A "value: 0.34" invites both trust and
  tuning, and deserves neither. Findings are *named reasons*: "no links, no
  tags, no fact ever drawn from it, 11 months old."
- **No model decides whether words are meaningful.** See "the one rule about
  the model", below.
- **No `--exit-code` by default.** A pre-commit hook that fails because your
  notes are untidy is a hook people delete. Report, exit 0.
- **Not a deduplicator for `memory/`'s job.** Reconciliation already collapses
  duplicate facts on the way in (AGENTS.md §4). This cleans up what drifted
  after the fact, and it must not become a second reconciler.

## Requirements

**R1.** `ppr tidy` is read-only by default and prints a report grouped by
reason, with `--json` and `-q` (I10, AGENTS.md §6).

**R2.** Every finding names the specific, checkable reasons it was flagged.

**R3.** `ppr tidy --write` applies only *reversible* fixes, and only to
`memory/`. Reversible means: a frontmatter field changed, no file moved, no file
removed, and one documented command puts it back.

**R4.** `ppr tidy --archive` sets `status: archived` on entries, which removes
them from `ls`, `recap`, and `brief` and leaves them in `search`, `export`, and
on disk. It never moves or deletes a file.

**R5.** Anything the report cannot justify with a deterministic reason is not in
the report. A model's opinion appears only under `--suggest`, only as a queue a
person walks, and never applies itself.

**R6.** `--dry-run` shows the frontmatter diff it would write, per AGENTS.md §6.

**R7.** Running `ppr tidy --write` twice changes nothing the second time.

## Success metrics

- On a vault whose fact store has crossed 150, `ppr tidy --write` brings it back
  under, and `ppr context --json` is measurably smaller with no fact a person
  wanted having gone.
- Zero reports of a user losing something. This is the only metric that can fail
  the feature outright.
- The maintainer runs it monthly without dread. If it needs to be double-checked
  every time, the deterministic signals are wrong and phase 4 must not ship.

---

# Part II — Review: why `prune` is the wrong command and what the right one is

## The naming is a promise

`prune` means removal. `git prune`, `docker prune`, `npm prune` all delete. Ship
a command called `prune` in a note tool and users will correctly infer that it
deletes notes; then either it does (and I2 is inverted) or it does not (and the
name lied). `tidy` is honest about the ceiling: it rearranges, it does not
remove. Everything else in this plan follows from picking that word first.

## The biome analogy does not survive contact

The idea says: *"recommends before commits with biome like commands to auto or
unsafe apply."* Biome's model works because of three properties, and a note
vault has none of them:

| Biome | A vault |
|---|---|
| A fix is mechanically verifiable — the AST is equivalent | "This log was meaningless" has no ground truth |
| Every file is in git, so every fix is `git checkout` away | A vault is *assumed* to be in git (I7's threat model) but is not *required* to be, and people do not commit before running a tool they just installed |
| A wrong fix is caught by the tests you already have | A wrongly removed note is caught in six months by not being there |

The one property that does transfer is the **safe/unsafe split as a
communication device** — and this plan keeps it, with the line drawn in a
different place: safe means *reversible*, not *probably right*.

## What ppr already knows, and has never used

This is the substantive review finding. Every signal below is already in the
data model and none needs a model to compute.

| Signal | Where it comes from | What it means |
|---|---|---|
| **`from` inverted** | `Fact.from` holds the entry ids it was extracted from (`memory.ts:182`, `Vault.sourcesOf`) | An entry that has been read by the learner and yielded nothing durable — *and the learner has definitely read it*, because the high-water mark says so (`.ppr/state.json`) |
| **Backlinks** | `Vault.backlinks(entry)` | Nothing in the vault refers to it |
| **Forward links + tags** | `Entry.links`, `Entry.tags` | It refers to nothing and is filed under nothing |
| **Thread membership** | `core/src/thread.ts` — a walk bounded by strength | It is on no line of thought, by the project's own high-bar definition |
| **Normalised text** | `factKey` (`memory.ts:210`) already collapses exact repeats | Exact and near duplicates, deterministically |
| **Word count** | `wordCount`, used by `Vault.stats()` | A stub |
| **`status`** | `done` / `retired` conventions already in `extra` | Where `archived` will live, by the same mechanism |
| **`source`** | `Entry.source`, set by 003's `--source` | A robot's output can be tidied on different terms from a person's words |

The combination of the first four is the honest definition of "low signal" the
idea file said it did not have yet:

> **An entry is *unreferenced* when: no backlinks, no forward links, no tags, no
> fact was ever extracted from it, it is on no thread, and it is older than the
> review window (default 90 days).**

That is six conditions, all deterministic, all explainable in the report, and
the conjunction is deliberately hard to satisfy — "high-bar and boring beats
clever" is the lesson `thread.ts` already paid for, and it applies here
unchanged. On a healthy vault this should flag very little, and that is the
correct behaviour: a hygiene tool that flags 40% of your notes is a tool you
stop running.

The `from`-inversion deserves emphasis because it is the strongest of the six
and it is free. The learner has already read every entry below the high-water
mark and made a judgement about whether it contained anything durable. "The
model read this and found nothing to remember" is a *recorded past judgement*,
not a new one — which means the report gets AI-quality signal with no model
call, no cost, and no non-determinism.

**One trap, and it is a real one:** the inversion is only valid for entries the
learner has actually processed. An entry newer than the high-water mark, or one
written while no AI was configured, has no `from` for reasons that say nothing
about its value. The implementation must read `.ppr/state.json`'s mark and
exclude anything at or after it, and must skip the signal entirely on a vault
that has never run `learn`. Getting this wrong turns "you have never configured
AI" into "all your notes are worthless" — which is L21's shape exactly: a
failure and an empty answer looking alike.

## The one rule about the model

The idea wants AI to identify things that are "incoherent or meaningless or
outdated or contradictory". Split that list by whether a human can check the
answer in one second:

| Question for the model | Checkable at a glance? | Verdict |
|---|---|---|
| "Do these two entries say the same thing?" | Yes — read both | Allowed, in phase 4 |
| "Does this fact contradict that one?" | Yes — read both | Already exists (`ppr memory review`) |
| "Is this fact still true given this newer one?" | Yes — read both | Allowed, in phase 4 |
| "Is this entry meaningful?" | **No** | Never |
| "Is this entry outdated?" | **No** — outdated relative to what? | Never |
| "Score this entry's value 0–1" | **No** | Never |

**The rule: only ask the model questions whose answer is a comparison between
two things the user can see side by side.** A comparison is auditable; a
judgement is not. This is not squeamishness — it is the difference between a
review queue a person can clear in two minutes and one they have to think about,
and the second one never gets cleared.

## Considered and rejected

- **Moving archived entries to `entries/archive/`.** Tempting and wrong: the
  catalog lists under `entries/`, so a move either keeps them in every view
  (pointless) or takes them out of search too (a loss), and it churns paths in
  git and breaks nothing-in-particular in a way that is hard to reason about.
  A frontmatter flag does the job, reuses the `done`/`retired` mechanism that
  already exists, and is reversible with one edit in vim.
- **A `.ppr/tidy-ignore` file.** A second place that decides what is visible,
  which is a second owner of a property the frontmatter already owns. If an
  entry should never be flagged, it can be pinned (`pinned` is already an owned
  field) — and phase 1 must honour `pinned` as an absolute exemption.
- **Deleting on a schedule.** Not offered, at any confirmation level. There is
  no `ppr schedule add tidy --write`; the job set in 003 makes it *possible*,
  and the report will say so if anyone tries: a scheduled tidy is a tidy nobody
  read.
- **Compacting many logs into one file, deleting the originals.** This is what
  the idea asked for, and phase 3's digest is the version that keeps the
  originals. The delete half is refused; see the product promise.

---

# Part III — Design

## The surface

```
ppr tidy                     the report. read-only. exit 0.
ppr tidy --json              the same, machine-readable
ppr tidy --write             apply reversible fixes (memory/ only)
ppr tidy --archive [filter]  set status: archived on matching entries
ppr tidy --suggest           phase 4: build a review queue with a model
ppr tidy --since <when>      limit the scan window
ppr tidy --exit-code         opt-in non-zero when anything is found
```

`--write` and `--archive` are separate flags on purpose. They act on different
halves of the vault with different reversibility, and one flag that did both
would be the flag people run without reading.

## The report

```
Facts (52 current, budget 150)
  3  sources gone         the entries these came from were deleted
  1  date passed          2026-03-14, does not recur
  2  exact duplicates     same text after normalisation

Entries (1,204)
  7  unreferenced         no links, no tags, no fact drawn, no thread, >90d
  2  near-duplicates      95% shingle overlap with another entry

Nothing here is deleted. `ppr tidy --write` retires the 6 facts (reversible).
`ppr tidy --archive --unreferenced` hides the 7 entries from lists.
```

Reasons, not scores (R2). Counts before details, because the first question is
"is this a lot?" The budget line is there because it is the number that makes
the fact half urgent rather than cosmetic.

## The signals, specified

### Facts — all safe to act on, because the store is a projection

`memory/` is rebuildable (`ppr memory learn --all`, AGENTS.md §5), so retiring a
fact costs at most one relearn. That is what makes phase 2 the safe phase.

| Finding | Rule | Fix under `--write` |
|---|---|---|
| `sources-gone` | Every id in `from` resolves to nothing via `Catalog.get` | `status: retired` |
| `date-passed` | `date` is before today, `recurs` absent, `status: current` | `status: retired` |
| `exact-duplicate` | Two current facts share a `factKey` | Retire the newer, `supersededBy` the older; merge `from` via the existing `absorb()` path |
| `unresolved-conflict` | `conflicts` set, both sides current, older than 30 days | **Report only.** The fix is `ppr memory review`; do not settle a disagreement automatically |
| `over-budget` | `facts().length > FACTS_IN_PROMPT` | **Report only**, with a line explaining that retrieval has degraded |

`source: manual` facts are exempt from every automatic fix — *"nothing automatic
may rewrite a `manual` one"* (AGENTS.md §5). They can still be *reported*.

### Entries — reported always, archived only when asked

| Finding | Rule |
|---|---|
| `unreferenced` | The six-condition conjunction above, `pinned` exempt, learner-mark guard applied |
| `stub` | Fewer than 8 words **and** older than the window **and** unreferenced. Never on its own — a four-word note that three things link to is a good note |
| `near-duplicate` | ≥90% Jaccard overlap on 5-word shingles of the normalised body, both older than 7 days |
| `generated` | `source` set and matching `plugins.tidy.generatedSources` — reported with a shorter window, because a robot's output ages faster than a person's |

Shingling is deliberately boring: normalise with the same lowering/punctuation
rules as `factKey`, take overlapping 5-word windows, hash each, compare sets.
No embeddings (§11), no configuration knob for the threshold beyond the one
constant, and it runs over `Catalog` in memory in a single pass.

### Archiving

`status: archived` in `extra`, joining `done` and `retired` — one more value in
a convention that already exists, rather than a new mechanism.

Where it is honoured:

| Surface | Archived entries |
|---|---|
| `ppr ls`, `today`, `week`, `recap`, `brief`, `todos` | hidden |
| `ppr search` | **shown**, marked dim `(archived)` |
| `ppr show`, `ppr path`, `ppr export` | shown, unchanged |
| `ppr memory learn` | skipped — it has already been read |
| The interactive browser | hidden, with `a` to toggle, matching how filters already work |

Search keeps them because the alternative is a tool that hid something you can
prove is there, which is the single fastest way to lose trust in a note system.
Export keeps them for the same reason `export` already widens for facts (I12's
deliberate exception).

Undo is `ppr tidy --unarchive <ref>` and also just deleting the line in vim,
which the docs should say in those words.

## Where the code goes

Per AGENTS.md's *Where does my change go?* table:

| Piece | File | Why |
|---|---|---|
| The signals, as pure functions over a `Catalog` | `packages/core/src/tidy.ts` (new) | "A rule about entries, search, links, or the graph" → core |
| Fact-specific rules | `core/src/memory.ts` | "Anything about facts: shape, paths, provenance, state" |
| `Vault.tidy()` returning findings; `Vault.archive(ref)` / `unarchive(ref)` | `core/src/vault.ts` | `Vault` is the entire public API — a future Mac app needs this |
| Honouring `archived` in list filters | `core/src/catalog.ts` `filterEntries()` | One definition, as with `MEMORY_KIND` (I12's guard is the model to copy) |
| The command and its rendering | `packages/cli/src/commands/` — new `tidy.ts` | It is its own category |
| Shingling | `core/src/util/text.ts` | Alongside the text helpers that exist |

`Vault.tidy()` returns findings and applies nothing. `--write` walks them and
calls existing mutators. That split means the Mac app (plan 005) gets the report
for free and the CLI owns none of the logic.

---

# Part IV — Implementation

## Phase 1 — the report (read-only, no risk)

1. `core/src/tidy.ts`: `TidyFinding = { kind: FindingKind; entry: Entry; reasons: string[] }`
   and `findings(catalog, opts)`. Pure, synchronous, no I/O, no provider.
2. The learner-mark guard: read `.ppr/state.json`'s high-water id through
   `Storage` and exclude entries at or after it from any `from`-based signal;
   skip the signal entirely when the mark is absent. Comment it with *why* —
   this is the L21-shaped trap and the comment is the most valuable line in
   the file.
3. `Vault.tidy(opts): TidyReport`.
4. `commands/tidy.ts`: report rendering, `--json`, `-q`, `--since`,
   `--exit-code`. Register in `cli/src/index.ts`.

**Tests**
- `core/test/tidy.test.js` — *"a note nothing points at, that nothing was
  learned from, is dead weight"*; *"a four-word note three things link to is
  not"*; *"a pinned entry is never flagged"*; *"nothing is flagged on a vault
  that has never learned"* (the guard); *"an entry newer than the learner's mark
  is not held against it"*.
- `cli/test/cli.test.js` — *"tidy tells you what is stale and changes nothing"*:
  run it, assert the vault's mtimes are untouched.

**Ship it here and live with it for a few weeks before phase 2.** The report is
the deliverable that answers the idea file's own open question — *"not sure yet
how to define the measures"* — and the answer is only good if it is right on a
real vault.

## Phase 2 — `--write` for facts (reversible)

1. `Vault.retireFact(id, { supersededBy? })` if `keepFact`'s internals cannot be
   reused directly (`vault.ts:914`); prefer reuse.
2. Apply the four fixable fact findings. `source: manual` exempt.
3. Idempotence (R7): a retired fact is not `current`, so it is not re-found.
   Test it explicitly anyway.
4. `--dry-run`: print the frontmatter diff per fact (R6). It goes through the
   `Storage` port, so `cli/src/dryrun.ts` already holds the write — verify, do
   not re-implement.
5. Events: retiring a fact is `entry.updated`. **Do not add a `fact.retired`
   event** — AGENTS.md, *Add an event*: a new kind is a filter, not an event.

**Tests** — `core/test/memory.test.js`: *"a fact whose sources are gone is
retired, not deleted"*; *"a fact you wrote by hand is never retired for you"*;
*"tidying twice changes nothing the second time"*.

## Phase 3 — `--archive` for entries

1. `Vault.archive(ref)` / `unarchive(ref)`; `status: archived` in `extra`.
2. `filterEntries()` gains the default exclusion, with the same shape as I12's
   memory guard and a comment naming this plan.
3. `search` shows them with a dim marker; `export` and `show` unchanged.
4. `--archive` takes the standard filter flags plus `--unreferenced` /
   `--near-duplicate` to archive exactly what the report named.
5. Confirmation: archiving more than 20 entries in one run prompts, unless
   `-q`/`--json`/non-TTY, where it proceeds (I4 — interactive is a rendering
   mode, never a change in semantics; the *count* is not the semantics).

**Tests** — `core/test/vault.test.js`: *"an archived entry leaves your lists and
stays in your searches"*; *"archiving is a frontmatter edit and nothing else"*
(assert the path is unchanged); `cli/test/cli.test.js`: *"nothing tidy does ever
removes a file"* — snapshot the file list before and after every flag
combination.

That last test is the one that keeps this plan honest. Write it first.

## Phase 4 — `--suggest` (gated; do not start without a decision)

Only two questions, both comparisons (see the rule in Part II):

1. Given two near-duplicate entries the shingling already found: *are these the
   same thing, and if so which text is better?*
2. Given a fact and a newer fact that mentions the same subject: *does the newer
   one supersede the older?*

Output is a **queue**, not an action: `ppr tidy --suggest` writes nothing and
prints pairs; `ppr tidy --review` walks them interactively with the existing
`select()` picker, exactly as `ppr memory review` does (`commands/think.ts:544`
is the model to copy, including its re-read-between-pairs care).

Every AI path needs a fallback (I2): with no provider, `--suggest` reports the
deterministic pairs and says a model would rank them. Tested in
`core/test/ai.test.js` with the scripted fake provider, including garbage
output.

**Do not build phase 4 until phases 1–3 have been in use for a month.** If the
deterministic report is good, phase 4 is a small convenience. If it is not,
phase 4 is a way to make a bad signal look authoritative.

---

# Part V — Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A user archives 400 entries and thinks they are gone | MED | `search` still shows them, marked; the report and the docs say "hidden from lists, not removed"; `--unarchive` is in the same help text |
| The `from` inversion misfires on a never-learned vault | HIGH if unguarded | The high-water-mark guard, phase 1 step 2, with its own test |
| Shingling flags legitimately similar daily logs | MED | 90% threshold on 5-word shingles is strict; `kind: day` entries from 003 are near-identical in *shape*, not in words. Validate against a real vault before shipping phase 3 |
| `archived` collides with somebody's own `status` value | LOW | `status` is already ppr's (`done`, `retired`); it is in `FACT_KEYS`. Document the third value |
| Scope creep into a curation UI | MED | The browser change in phase 3 is one keybinding. Anything more belongs in plan 005 |
| The command makes the vault feel like a chore | MED | It is never scheduled, never fails a build, and prints nothing when there is nothing to say |

---

# Part VI — Open questions

1. **Should `over-budget` be a warning on `ppr context` too?** The degradation
   at 150 facts is silent today and that is arguably a bug independent of this
   plan. Recommendation: yes, one dim stderr line from `ppr memory ls` when the
   store is over budget — but as a separate one-line change, not bundled here.
2. **Window default: 90 days?** Guessed. Phase 1's report on a real vault should
   settle it. Make it `plugins.tidy.window` only if the answer turns out to be
   personal; otherwise pick a number and hard-code it (§11: no config option to
   avoid making a decision).
3. **`ppr digest`** — the idea's "compact many logs into one with a reference to
   the old". Deliberately not in this plan. The shape if it is ever wanted: a
   new `kind: digest` entry containing a summary and `[[wikilinks]]` to every
   source, followed by `--archive` on the sources — two explicit steps, both
   reversible, no new mechanism. Worth doing only if, after phase 3, the
   archived pile turns out to be something you want to read a summary of. It
   probably is not.
4. **Should `--write` be allowed to act on entries at all, ever?** This plan says
   no, permanently. Recorded here so the decision is visible rather than
   forgotten and re-litigated.
