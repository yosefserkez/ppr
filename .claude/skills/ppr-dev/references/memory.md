# Changing the memory layer

```
entries/**  ──learn──▶  candidates ──reconcile──▶  memory/**  ──▶  ask · brief · context
             extract      (facts)     new/dup/         (facts)
                                      refines/
                                      contradicts
```

Not a graph database and not embedding retrieval. The corpus *is* the curated
part: one-line facts, deduplicated on the way in, small enough that all of them
fit in a prompt. The intelligence is spent writing the store, not searching it.

## Where it goes

| If it is... | It goes in... |
| --- | --- |
| The shape of a fact: fields, paths, provenance, dates, recurrence | `core/src/memory.ts` |
| A prompt, or parsing what a model answered with | `core/src/ai/tasks.ts` |
| Which entries a run reads, chunking, reconciling, the high-water mark | `Vault.learn()` / `Vault.absorb()` in `core/src/vault.ts` |
| How a fact looks, or its `--json` shape | `cli/src/commands/think.ts` |
| Whether a model is any good at it | `packages/core/eval/cases.js` |

`memory/<slug>-xxxx.md` is flat and undated: a fact is about a thing, not a day.
Everything ppr adds rides in `Entry.extra`, which round-trips for free (I3), so
the layer owns no new frontmatter keys and a fact stays readable in Obsidian.

## The rules that are not negotiable

**Memory is state; everything else is a log (I12).** `latest`, `^2`, `ppr ls`,
`recap`, and search all skip `kind: memory` unless `-k memory` asks. `learn`
never reads a fact as a source. Ignoring this made `learn` re-read its own
output and report "nothing durable in there" forever. `ppr export` is the one
deliberate exception, and it widens the default at its own call site — never in
`filterEntries()`, which every browsing command depends on.

**The store is a projection.** Delete `memory/` and `ppr memory learn --all`
rebuilds it. Protect that property above any feature you are adding: it is what
makes the layer trustworthy rather than a second place the user's data lives.

**A manual fact is never rewritten.** `source: manual` means a person wrote it.
`refines` on one adds the model's version alongside instead of replacing it.

**Contradictions are recorded, never settled.** A cron job may not overwrite
what you told it and may not silently keep two facts that disagree either. It
flags the pair; `ppr memory review` is where a human decides (L17).

**A failed model is not an empty answer (L21).** `FactBatch.ok` exists because
"nothing durable in these entries" and "the reply was mangled" both produce zero
facts, and treating them alike advances the mark past entries no model ever
read. Anything new that can both legitimately return nothing *and* fail says
which happened.

**The mark is an id, and only a full run moves it (L20).** `.ppr/state.json`
holds `learnedThrough` — an entry id, because `created` is second-resolution and
cannot order two entries written in the same second. A run given `--since` or an
explicit list reads a window that can begin *after* the mark, so it must not
move it: that would write off the gap for good. Losing the mark costs a re-scan,
which reconciliation absorbs.

**One run must not store the same fact twice.** Reconciliation compares a
candidate against what was already known, never against its siblings — so
candidates are collapsed by `factKey` before they are reconciled. A backfill
chunks the journal, and something said on Monday and again on Friday lands in
two chunks of one run.

## Adding a field to a fact

Four edits, in this order:

1. `factExtra()` writes it (empty fields are left out, never nulled).
2. `FACT_KEYS` lists it, so `factPatch()` can *clear* it — without that, a
   settled conflict keeps pointing at the fact it settled.
3. `toFact()` reads it back, and decides what absence means.
4. `factJson()` in `commands/think.ts` exposes it. `entryJson` carries owned
   frontmatter only, so anything in `extra` is invisible to scripts until this
   line exists.

## Changing a prompt

The test suite scripts the model, which means everything handed *to* a model is
untested by construction. `pnpm eval` is the only thing that answers "did that
prompt get better":

```bash
pnpm eval --dimension dates --repeat 3     # while iterating
pnpm eval --repeat 3 --save                # the number worth keeping
```

`--repeat 3` is not optional advice: one pass cannot tell a regression from
model noise. Scoring is deterministic keyword matching — never a model judging a
model. Every case also states what would be *wrong*, because a suite that only
measures recall rewards a model that keeps everything.

It costs money and needs a network, so it is not part of `pnpm test`. Do not run
it to check a refactor; run it when you change a prompt, the fact schema, or
reconciliation.

## Testing without a model

`core/test/ai.test.js` — `learnProvider({ facts, verdicts })` answers extract and
reconcile by what the system prompt asks for, so a whole learn run is scriptable:

```js
const vault = await makeVault({ provider: learnProvider({ facts: ['Emily likes chocolate'] }) });
await vault.add({ body: 'emily likes chocolate', kind: 'log' });
const result = await vault.learn();
```

`core/test/memory.test.js` — the pure half: date parsing, recurrence, which words
identify a fact. No provider involved, and the first place a new pure helper
should be tested.

`cli/test/cli.test.js` runs with `PPR_NO_AI=1`, so every memory command there is
exercising its offline path. That is the point: `brief`, `context`, and
`memory ls` must all work with no model at all.
