# Changing the thread walk

```
seed(s) ──links──▶ ──links──▶ ──links──▶ ──links──▶ ✂
   │                 (0.7 each step, floor 0.2)
   └──tags/titles──▶ ✂
        (0.35, so one step and never two)
```

`core/src/thread.ts` answers "where had I got to". It stores nothing, adds no
frontmatter, and asks no model whether two notes are one thought — linking or
tagging them is how the user already said so, and inventing that claim is how a
recall tool starts lying.

## Where it goes

| If it is... | It goes in... |
| --- | --- |
| What a thread admits, how far it reaches, how a seed is chosen | `core/src/thread.ts` |
| Which facts belong to a thread | `threadFacts()` — provenance, not search |
| Where the silences are, and what they are called | `threadGaps()` / `gapWords()` |
| When a capture may say "this continues something" | `continuesThread()` |
| The prompt for the story, or its offline shape | `ai/tasks.ts` / `ai/fallback.ts` |
| How a thread looks in a terminal | `threadTimeline()` in `cli/src/render.ts` |

## The one thing to keep

**An expansion that pulls in the whole vault is the failure mode.** Once
"related to something related to something" chains, every entry is on every
thread and the feature says nothing at all. Everything else here is in service
of that:

- Strength, not hop counts. Seeds are 1, a wikilink multiplies by `0.7`,
  relatedness by `0.35`, and under `0.2` the walk stops. Links therefore reach
  four steps and tags reach one, so **tags widen a thread and never lengthen
  it** — the difference between "the same thought" and "the same subject".
- A weak edge needs a `related()` score of 4: two signals, not one. A tag is 3,
  a shared outbound link 2, a title word 1. One shared tag in a vault where
  everything is `#work` is a coincidence, and so is one word in common. This is
  the `mentionScore` lesson unchanged — high-bar and boring beats clever.
- Search seeds are kept only within a quarter of the best hit's score. A seed is
  where the walk *starts*, so a bad one costs everything downstream of it.

If you raise any of these, the test to run is "expansion is bounded" and
"relatedness widens a thread by one step and never chains" in
`core/test/thread.test.js`, plus the realistic fixture in `cli/test/cli.test.js`
— which asserts both halves, that the story is found *and* that none of the
noise is.

## Facts, reminders, and I12

Facts are gathered by provenance (`from` pointing into the thread), never
walked, and never placed in the sequence: state has no position in a timeline.
They render as their own block, because "this is what you concluded" is half of
what somebody came back for.

A *completed* reminder stays on the thread. You did send the email, and a story
that dropped it would be a worse story.

## The line a capture prints

`continuesThread` is the same walk with the bar doubled — a resolved wikilink
or a `related()` score of 8, plus a third entry, because a pair is a
coincidence. It runs after **every** capture, so it asks the cheap question
first and walks only when the answer was yes.

An unrequested line has to be right nearly every time or people learn to ignore
it, which is worse than not having it. If you are tempted to loosen this, read
`mentionsSince` first.

## Time

Gaps are the thread's own rhythm: six times the median interval, floored at a
fortnight and capped at two months. Arithmetic, so the offline timeline shows
the same shape of time the model's story describes — and so `threadRecap`'s
fallback still says "8 months later" with no model at all (I2).
