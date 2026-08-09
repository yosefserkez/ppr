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
| The shape of a reminder, or reading a date out of typed words | `core/src/remind.ts` |
| A prompt, or parsing what a model answered with | `core/src/ai/tasks.ts` |
| Which entries a run reads, chunking, reconciling, the high-water mark | `Vault.learn()` / `Vault.absorb()` in `core/src/vault.ts` |
| How a fact looks, or its `--json` shape | `cli/src/commands/think.ts` |
| Whether a model is any good at it | `packages/core/eval/cases.js` |

`memory/<slug>-xxxx.md` is flat and undated: a fact is about a thing, not a day.
Everything ppr adds rides in `Entry.extra`, which round-trips for free (I3), so
the layer owns no new frontmatter keys and a fact stays readable in Obsidian.

## The reminder shape

A reminder is the mirror image of a fact and lives in the opposite place:

```yaml
kind: reminder            # an ordinary entry, in entries/YYYY/MM/, in `ppr ls`
date: 2026-08-10          # extra; parsed by parseFactDate, same as a fact's
recurs: yearly            # extra; only ever yearly, same stance as a fact's
status: done              # extra; written by `ppr done`, and nothing else
```

You *did* say "remind me to call the dentist" at the moment you said it, so a
reminder is an event with a date attached, not state — I12 is untouched and
`filterEntries()` does not special-case it.

`Vault.upcoming()` is therefore about **dated anything**, not dated facts:
`toFact` and `toDated` both produce a `DatedItem`, and a note somebody typed
`date:` into by hand surfaces in `ppr brief` with no ppr command involved. That
is the feature. The asymmetry to keep: a fact whose date passed drops out (the
day happened), an unfinished timeline item stays for seven days with negative
`days` (it did not happen, which is the point of telling you).

Adding a reminder field is the same four edits as a fact's, against
`reminderExtra()` / `REMINDER_KEYS` / `toDated()` / the `--json` shape in
`commands/think.ts`.

## Todos are reminders with the date left off

```yaml
kind: reminder            # the same kind, the same file, the same `ppr done`
                          # and no `date:` at all
```

`addReminder` takes an optional date; there is no second writer, because "buy
milk" and "buy milk on Friday" are one act with a field filled in. What the
missing field costs is the calendar — `toDated()` returns null, so a todo
cannot reach `ppr brief` and should not: a countdown that included dateless
things would stop being one.

`Vault.todos()` is the other view of the same entries: `kind: reminder` only
(deliberately narrower than `upcoming()`, which is dated *anything* and would
make a todo list out of birthdays), ordered most-overdue, then soonest, then
oldest-undated, ties on id because ids are monotonic (L2). It reuses
`nextOccurrence` with an effectively infinite grace window rather than doing
its own arithmetic — a brief forgets after a week because it is a heads-up, a
list you can finish keeps everything until you finish it, and two countdowns
would disagree inside a release.

`ppr brief` and the bare `ppr` overview each end with a count of the undated
ones, never the items themselves: the brief's `--json` array is dated things,
and a script filtering it on `.overdue` should not have to step over a
sentence. It is a count of the *dateless* ones and not of everything the brief
is not showing — a reminder past the seven-day grace has left the brief and is
at the top of `ppr todos`, which is the list that keeps things until they are
done.

**The fallback story is the lesson.** A dateless `ppr remind …` used to become
a log, honestly, because nothing could display an undated intention. `ppr
todos` removed the reason and the fallback changed with it. When you add a
surface, go and look at what was degraded because it did not exist.

No new event: a todo is `entry.created` with `kind: reminder` and no `date` —
an absent field, not a name (I13).

## Handing a reminder to something else

`remind.push` (and `--push` / `--no-push`) hands a dated reminder to
`ppr-reminders-push`; `ppr brief --notify` hands the brief to `ppr-notify`.
Both are conventional program names resolved on PATH, never code inside ppr:
the flag names the intent, the name on PATH resolves the tool, and replacing
the executable rebinds the intent (I13, and `references/plugins.md`).

One-way, fire-and-forget — no sync, nothing read back. A tickbox moved in
whatever received the copy does not reach the vault, because two owners of one
row is the end of I1.

The vault write happens first and always survives. A plugin that is missing,
slow, or broken costs a stderr line, never the entry (I2's shape), which is why
`runChild` reports `{ok, hint?}` instead of throwing.

`pushDecision()` in `cli/src/porcelain.ts` is the only thing that decides, so
`ppr remind` and `ppr "remind me …"` cannot disagree — both reach it through
the one `remind()` in `commands/capture.ts` (L18). Order is flag, then day,
then whether the tool exists: a dateless line is a todo and has no moment to
ring at, so `--push` cannot conjure a reminder out of it.

What goes down the pipe is the `entry.created` event, in exactly the shape a
hook on `entry.created` receives — one serializer, two doors. That is also why
`entryJson` publishes `extra`: a consumer told a reminder was created has to be
able to see the day it carries without reading the file back.

The decisions are pure and unit-tested. **No test runs osascript** — a suite
that creates reminders leaves litter in someone's list.

| If it is... | It goes in... |
| --- | --- |
| The AppleScript, its escaping, an osascript error hint | `plugins/` — not ppr |
| Whether to push, and what a notification says | `cli/src/porcelain.ts` |

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

**One run must not store the same fact twice.** A backfill chunks the journal,
so something said on Monday and again on Friday lands in two chunks of one run.
Two layers catch it: `factKey` collapses the identical sentence with no model
involved, and reconciliation is asked about the candidates *before* each one as
well as about the known facts — a `duplicate-of-candidate` verdict merges into
whatever that earlier sibling became. Sibling pointers only ever run backwards;
one that does not is ignored and the fact is kept, because losing it is worse.

## Adding a field to a fact

Four edits, in this order:

1. `factExtra()` writes it (empty fields are left out, never nulled).
2. `FACT_KEYS` lists it, so `factPatch()` can *clear* it — without that, a
   settled conflict keeps pointing at the fact it settled.
3. `toFact()` reads it back, and decides what absence means.
4. `factJson()` in `commands/think.ts` names it. `entryJson` already publishes
   the whole of `extra`, so it is visible to a script and to an event consumer
   from the moment it is written — this step is about giving it a place in the
   flat shape people read `ppr memory ls --json` with.

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
