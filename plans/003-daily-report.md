# Plan 003: `ppr-day` — a day's work, collected from the tools that already have it

> **Verdict: BUILD.** Almost none of it belongs in ppr. One plugin, a directory
> of user-owned collector scripts, and three small CLI affordances that ppr is
> missing anyway.
>
> **Executor instructions**: phases are independent and each ships something
> usable. Phase 1 (the CLI affordances) is the only part inside `packages/`;
> everything else is `plugins/`, which imports nothing from ppr and which ppr
> imports nothing from. Run `pnpm build && pnpm typecheck && pnpm test` before
> claiming a phase is done. Update the status row in `plans/README.md`.

## Status

- **Priority**: P1 (highest value-per-line of the three ideas)
- **Effort**: S for phases 1–2, M with both reference collectors
- **Risk**: LOW — the vault-writing path is `ppr dump`, which already exists and
  is already tested; everything new is outside ppr
- **Depends on**: nothing
- **Category**: feature (plugin) + three small CLI gaps
- **Planned at**: `e773b65`, 2026-08-10
- **Reviewed in**: [002-review.md](002-review.md)

---

# Part I — PRD

## Problem

At the end of a day the record of what you actually did is scattered across
four systems that each know a fraction of it: commits in GitHub, decisions in
Slack threads, tickets in Linear, and a handful of notes in ppr. Reconstructing
the day means visiting all of them, which means it does not happen, which means
the one place designed to remember — ppr — has the *least* complete record of
the day of any tool involved.

ppr's own thesis makes this worse rather than better. It is the input layer that
feeds other AI tools (`ppr context`), and a context snapshot assembled from a
vault that saw one note out of a day's twelve events is a confident, grounded,
incomplete answer.

## Who this is for

The maintainer, first and specifically: a developer whose day produces machine
-readable artifacts in three or four SaaS tools and who wants one grounded
paragraph per day in their own vault without writing it.

Second, and only as a consequence: anyone whose day is legible to a CLI. The
design goal is that adding *your* source is a five-line shell script you write,
not a feature request.

## Jobs to be done

1. *"At 18:00, without me doing anything, put today into my vault."*
2. *"When I add a new tool to my life, teach the report about it in five minutes."*
3. *"Run it twice and don't give me two of the same day."*
4. *"When Slack is down or my token expired, still give me the GitHub half."*

## Non-goals

- **ppr never learns what Slack, GitHub, or Linear are.** No API clients, no
  OAuth, no service names in `packages/`. This is I13 and it is the whole design.
- **No plugin registry, manifest, lifecycle, or versioning** (AGENTS.md §11). A
  collector is an executable in a directory. That is the entire contract.
- **No two-way sync.** Nothing written here is ever pushed back to Slack or
  GitHub, and a ticket closed over there does not close anything here (§11).
- **Not a time tracker.** No durations, no billing, no "focus time" analytics.
- **No new event names.** A day report is `entry.created` with `kind: day`
  (AGENTS.md, *Add an event*).

## Requirements

**R1.** `ppr day` produces one entry per calendar day, `kind: day`, tagged
`#daily`, with `source: ppr-day` in frontmatter.

**R2.** Sources are executables in a collector directory. `ppr-day` runs each,
concatenates stdout under a heading per collector, and hands the whole thing to
`ppr dump`.

**R3.** A collector that is missing, slow, broken, or unauthenticated costs one
line on stderr and never the report. (I2's shape, applied one level out.)

**R4.** Re-running the same day appends only what is new: each collector is told
the window it must cover, and on a re-run that window starts where the last run
finished.

**R5.** `--dry-run` prints the assembled markdown and writes nothing.

**R6.** The report is markdown a person can read with no ppr installed, because
that is the product promise and a day report is not exempt from it.

**R7.** No secret is ever written to the vault or to `~/.config/ppr/config.json`
(I7). A collector reads its token from the environment; ppr stores at most the
*name* of the variable, under `plugins.day.*`.

## Success metrics

- A day with GitHub activity and no manual notes produces an entry whose body a
  human recognises as their day. Judged by reading it, not by a metric.
- `ppr day` on a machine with no `gh` and no Slack token exits 0, writes nothing,
  and says why on stderr.
- Adding a fourth source requires touching zero files under `packages/`.
- `ppr schedule add day --at 18:00` works and survives a reboot (L22).

---

# Part II — Review: what already exists, and the three real gaps

## What is already sufficient

| Need | Already there |
|---|---|
| A new subcommand in any language | `ppr-day` on PATH → `packages/cli/src/external.ts` |
| Env handed to it | `PPR_VAULT`, `PPR_JSON`, `PPR_QUIET`, `NO_COLOR`, `PPR_NO_AI` (`external.ts:150`) |
| Turning raw text into a clean entry | `ppr dump`, stdin-driven, distills with fallback (I2) |
| Reading the vault back to check for today's entry | `ppr ls --json -k day --since today` |
| Adding to an existing entry | `ppr append <ref>` |
| Settings for a tool ppr never heard of | `plugins.<name>.<key>` (`core/src/config.ts`) |
| A worked pull-plugin example | `plugins/ppr-contact` — call `ppr … --json`, transform, act |

That table is the argument for the verdict: the idea is ~80% already shipped and
nobody noticed, because the missing 20% is the boring 20%.

## Gap 1 — no capture command can say where an entry came from

`Vault.dump()` accepts `source` (`packages/core/src/vault.ts:667`, passed
through to `add()`), `Entry.source` is a real field (`core/src/types.ts:48`), and
**no CLI path ever sets it**. `captureFlags()`
(`packages/cli/src/commands/capture.ts:118`) offers `--title`, `--tag`,
`--edit`, `--inline`, `--ask`, `--no-follow`, `--print`, and nothing else.

So a robot-written entry is indistinguishable from a typed one. That matters
here (you want to know the day report was assembled, not written) and it matters
more in plan 004, where "this was generated" is one of the strongest signals for
what may be tidied on different terms from a person's words.

## Gap 2 — `ppr schedule` cannot schedule this

`JOBS` (`packages/cli/src/schedule.ts:21`) is a closed set of exactly two:
`learn` and `brief`. `JobName` is `keyof typeof JOBS`, and `agentPath`,
`labelFor`, and `jobArgv` are all typed against it. There is no way to say
"run `ppr day` at 18:00" — the user is pushed out to `crontab -e`, where L22's
lesson (absolute interpreter path, absolute script path, explicit `--vault`)
has to be re-learned by hand and will not be.

The closed set was right when there were two jobs. It is now the thing standing
between this feature and being used.

## Gap 3 — an external subcommand is never told about `--dry-run`

`externalEnv()` (`external.ts:150`) passes five environment variables and not
`PPR_DRY_RUN`. So `ppr day --dry-run` today runs the collectors *and writes the
entry* — a dry run that is not one. AGENTS.md §6 is explicit that `--dry-run` is
two seams (the `Storage` port and `runChild`), and an external subcommand
replaces the ppr command entirely, so it is outside both. The honest fix is to
tell it, and let it decide: the plugin contract gains "if `PPR_DRY_RUN` is set,
print what you would do and write nothing."

## What review rejected

- **A `ppr day` built into ppr, with source adapters.** It would mean ppr
  shipping a Slack client. Every argument in I13 applies; this is the exact case
  the invariant was written for.
- **Making the collectors ppr hooks.** Hooks react to writes. A day report is
  initiated by a clock, not by a write, and wiring it to `entry.created` would
  fire it per note (L24's neighbourhood).
- **A `--source`-per-collector entry** (one entry per tool per day). Four
  entries a day is noise — the exact thing plan 004 then has to clean up. One
  entry, sectioned.
- **Reading git history locally instead of `gh`.** Tempting (no auth!) but it
  only sees repos you have cloned and misses reviews, issues, and anything you
  did in a browser. `gh` is the right dependency and it is the user's, not ppr's.

## The honest part: Slack is not GitHub

The idea says "use the native clis for those and not rebuild that". For GitHub
that works perfectly — `gh` is a first-party, authenticated, scriptable CLI.

For Slack it does not. The official `slack` CLI is a *Slack app development*
tool; it does not read your messages. Reading your own Slack activity requires a
user token (`xoxp-…`) with `search:read`, called against `search.messages` over
plain HTTPS, and on free workspaces search history is limited. There is no way
around this that is not "get a token."

The plan therefore treats the Slack collector as a **reference implementation
with a documented prerequisite**, not as a thing that works out of the box, and
`ppr day` is designed so that a Slack collector which cannot authenticate
degrades to silence rather than to failure (R3). Being clear about this now is
better than discovering it in phase 3.

---

# Part III — Design

## The shape

```
        ~/.config/ppr/day.d/
        ├── 10-github     ─┐
        ├── 20-slack       ├─ executables. stdin: nothing.
        └── 30-linear     ─┘  stdout: markdown. exit 0 = fine.
                 │
                 ▼
            ppr-day            concatenates, headings per collector
                 │
                 ▼
   ppr dump --kind day --source ppr-day --tag daily
                 │
                 ▼
        entries/2026/08/2026-08-10-1800-…md
```

`run-parts`, which is how every Unix system has composed "a set of things to do
at a time" since before ppr existed. Nothing to register, nothing to version,
nothing to keep compatible — the properties AGENTS.md §11 asks a plugin story to
have.

## The collector contract

One page, and it will live in `plugins/ppr-day/README.md`:

> A collector is any executable in the collector directory. `ppr-day` runs each
> one in lexical order, with:
>
> | Variable | Meaning |
> |---|---|
> | `PPR_DAY_SINCE` | ISO-8601 instant. Report activity **after** this. |
> | `PPR_DAY_UNTIL` | ISO-8601 instant. Report activity up to this. |
> | `PPR_VAULT` | Absolute vault root (inherited from ppr). |
> | `PPR_DRY_RUN` | Set when nothing should be written anywhere. |
> | `NO_COLOR` | Set. Collectors print plain markdown, never ANSI. |
>
> It prints **markdown** on stdout — no heading of its own, `ppr-day` adds one —
> and anything it wants a human to see on stderr.
>
> **Exit 0 means "I am done", including when you have nothing to say.** Print
> nothing and exit 0 when the tool is not installed, not authenticated, or had a
> quiet day. A non-zero exit is reported as one stderr line and the section is
> dropped; it never fails the report.
>
> A collector that has not printed anything within `PPR_DAY_TIMEOUT` seconds
> (default 20) is killed and treated as empty. A day report that hangs at 18:00
> is a day report nobody gets.

## Idempotency (R4), concretely

The naive version — "check if today's entry exists, skip if so" — makes the
second run useless. The version that is actually wanted: a re-run adds the part
of the day that happened since the last run.

```
1. today = ppr ls --json -k day --since today --tag daily
2. if none:      SINCE = start of today (local)
   if one:       SINCE = that entry's `updated` timestamp
3. run collectors with PPR_DAY_SINCE=SINCE, PPR_DAY_UNTIL=now
4. if all sections empty  -> exit 0, one stderr line, write nothing
5. if none existed        -> ppr dump  --kind day --source ppr-day --tag daily
   if one existed         -> ppr append <id>   (a `## 18:04` sub-heading)
```

This puts the burden where it belongs — the collector already has to filter by
time to call an API sensibly — and it means the intended usage is not one run at
18:00 but *any number of runs*, each of which is cheap and adds only the delta.
Running it hourly becomes a reasonable thing to do.

Two consequences worth being explicit about:

- **`updated` is the watermark, and it is second-resolution.** L20's lesson
  applies in spirit (a second-resolution timestamp is a weak mark) but not in
  force: the cost of a one-second overlap is a duplicated line in a report, not
  a permanently skipped entry. An id-based mark would need ppr to store state
  for a plugin, which it must not. Accept the overlap; document it.
- **Appending means the distiller does not re-run over the whole day.** `ppr
  append` is verbatim. That is the correct trade: the 18:00 run gets a distilled
  day, later runs get appended raw sections. A `--redistill` flag is listed
  under Open Questions rather than built.

## Where the pieces live

| Piece | Location | Why there |
|---|---|---|
| `ppr-day` | `plugins/ppr-day/` | Not part of ppr (AGENTS.md, *The plugins are not part of ppr*) |
| Reference collectors | `plugins/ppr-day/collectors/` | Shipped as examples; `install.sh` copies to `~/.config/ppr/day.d/` **only if the directory does not exist** |
| Pure logic (assembly, headings, window maths) | `plugins/ppr-day/lib/*.js` | Same split as `applescript.js` / `osascript.js`: pure builders unit-tested, three lines that spawn |
| `--source` flag | `packages/cli/src/commands/capture.ts` | One line in `captureFlags()` |
| Schedulable externals | `packages/cli/src/schedule.ts` | The closed `JOBS` set widens |
| `PPR_DRY_RUN` | `packages/cli/src/external.ts` | One line in `externalEnv()` |

---

# Part IV — Implementation

## Phase 1 — the three CLI affordances (inside `packages/`)

Independently useful; land first so the plugin has something to target.

### 1.1 `--source <name>` on capture

`packages/cli/src/commands/capture.ts:118`, add to `captureFlags()`:

```ts
.option('--source <name>', 'where this came from (a tool name, not a person)')
```

Thread it through `write`, `dump`, and `append`'s creation path the same way
`--tag` is threaded — `...(flags.source ? { source: flags.source } : {})`, the
conditional-spread house style (AGENTS.md §6).

Validation: reject anything that is not `COMMAND_WORD`-shaped
(`/^[a-z0-9][a-z0-9._-]*$/i`, already defined in `external.ts` — export it or
mirror the regex with a comment saying why). A free-text `source` invites a
sentence, and this field is for grouping.

**Test** (`packages/cli/test/cli.test.js`): *"an entry knows which tool wrote
it"* — `ppr dump --source ppr-day --json` round-trips `source` into frontmatter,
and `ppr ls --json` shows it.

### 1.2 Schedule any `ppr-*` subcommand

`packages/cli/src/schedule.ts`. Today:

```ts
export const JOBS = { learn: {...}, brief: {...} } as const;
export type JobName = keyof typeof JOBS;
```

Widen minimally — **not** to arbitrary shell:

```ts
/**
 * A scheduled job is either one ppr ships or a `ppr-<word>` on PATH.
 *
 * Deliberately not "any shell command": the scheduler runs *ppr*, which is what
 * lets `jobArgv` keep naming the interpreter and the script by absolute path
 * (L22). An external job is still one word, still dispatched by ppr, and still
 * gets `--vault` written out rather than inherited.
 */
export type JobName = keyof typeof JOBS | (string & {});
export const isJobName = (n: string): boolean => n in JOBS || COMMAND_WORD.test(n);
```

Then:

- `jobArgv()` — for an external job, `args` is `[word]` instead of
  `JOBS[job].args`. Everything else (absolute `process.execPath`, absolute entry
  script, explicit `--vault`) is unchanged, so L22 holds by construction.
- `labelFor(job)` / `agentPath(job)` — **must** be guarded. They build
  `sh.ppr.<job>` and a path under `~/Library/LaunchAgents/`. An unvalidated word
  is a path-traversal write. Validate against `COMMAND_WORD` at the top of both,
  throw `PprError('EINVALID', …)` otherwise. This is the one place in the phase
  where a mistake is a security bug rather than a broken feature.
- `ppr schedule ls` — external jobs need a description. There is none to read;
  print the argv, which `ls` already does.
- `ppr schedule add day` — warn (do not fail) when `ppr-day` is not yet on PATH,
  exactly as `--pipe` already warns (`commands/schedule.ts`, the `resolveCommand`
  check).

**Tests** (`packages/cli/test/schedule.test.js`, which already covers the plist
and the crontab line): *"a plugin subcommand can be put on a timer, with its
interpreter named absolutely"* and *"a job name that would escape the LaunchAgents
directory is refused"*.

### 1.3 `PPR_DRY_RUN` for externals

`packages/cli/src/external.ts:150`, in `externalEnv()`:

```ts
...(opts.dryRun ? { PPR_DRY_RUN: '1' } : {}),
```

and pass `dryRun()` from the dispatch site in `cli/src/index.ts`. Add the
variable to the documented list in that file's comment block and in
`plugins/README.md`.

**Test** (`packages/cli/test/cli.test.js`): *"a plugin is told when this is a
rehearsal"* — a stub `ppr-echoenv` on a temp PATH, run with `--dry-run`, asserts
`PPR_DRY_RUN=1`.

## Phase 2 — `ppr-day` itself

`plugins/ppr-day/`, following `ppr-contact`'s split exactly.

```
plugins/ppr-day/
  ppr-day               # executable: arg parsing + spawning. thin.
  lib/window.js         # pure: SINCE/UNTIL from an existing entry + now
  lib/assemble.js       # pure: sections -> one markdown document
  lib/collectors.js     # pure: which files in a dir are collectors, in order
  collectors/10-github  # reference
  collectors/20-slack   # reference
  README.md             # the contract above
```

**`lib/window.js`** — `windowFor({ existing, now, startOfDay })` →
`{ since, until, mode: 'create' | 'append' }`. Pure, table-driven tests: no
existing entry, an entry from an hour ago, an entry from *yesterday* that
`--since today` should never have matched (guard against a timezone slip), a
clock that has gone backwards.

**`lib/assemble.js`** — `assemble(sections, { at })` → markdown. Rules:

- Drop empty sections entirely. A `## Slack` heading with nothing under it is
  worse than no heading, because the reader concludes Slack was quiet when in
  fact the token expired.
- Heading per collector, derived from the filename with the sort prefix stripped
  (`10-github` → `GitHub`; a `collectors.json`-style title map is explicitly not
  added).
- In append mode, one `## HH:MM` heading above the sections, so a day read later
  shows the shape of the day.
- Never emit a section whose content contains a line starting with `---` at
  column 0 without escaping it — it would be read as frontmatter by a naive
  parser and as a horizontal rule by the reader. (ppr's own `parseEntry` is
  forgiving, but the promise is that these files are readable *without* ppr.)

**`ppr-day`** — the thin part:

```
ppr day [--dry-run] [--dir <path>] [--since <iso>] [--timeout <s>]
```

Reads `plugins.day.dir` via `ppr config get --json` when `--dir` is absent,
defaulting to `$XDG_CONFIG_HOME/ppr/day.d`. Spawns collectors with the documented
env, a timeout, stdout captured, stderr inherited. Then either `ppr dump …` or
`ppr append <id>` on stdin.

Two rules it inherits from `plugins/README.md` and must not break: **nothing on
stdout** except when `PPR_JSON` is set (then a single JSON object describing what
it did), and **it never writes into the vault directly** — always through the
`ppr` binary, so events fire and the index stays honest.

**Tests** (`plugins/test/day.test.js`): pure functions only. Window arithmetic;
assembly with a hostile section (a `---` line, a section that is only
whitespace, a collector name with a space); the collector-ordering rule. No test
spawns `gh`, `curl`, or `ppr` — same rule as "no test may run osascript".

## Phase 3 — the reference collectors

### `10-github`

```sh
#!/bin/sh
command -v gh >/dev/null 2>&1 || exit 0        # not installed: silence, exit 0
gh auth status >/dev/null 2>&1 || exit 0       # not logged in: same
```

Then three `gh` calls, each `|| exit 0`-guarded, formatted as markdown bullets:
commits authored in the window (`gh search commits --author=@me
--author-date=…`), PRs opened or merged (`gh search prs`), and reviews
submitted. Prefer `gh search` over `gh api graphql` — one flag changes the
window, and a GraphQL document in a shell script is a maintenance liability.

### `20-slack`

Documented prerequisite at the top of the file, in a comment a person will read
before they run it:

```
# Requires a Slack user token with `search:read`.
#   ppr config set plugins.day.slackTokenEnv SLACK_USER_TOKEN
#   export SLACK_USER_TOKEN=xoxp-…        (in your shell profile, not here)
# ppr stores the variable's NAME, never the token (I7). If the variable is
# unset this collector prints nothing and exits 0.
```

`curl` against `search.messages` with `from:@me` and the window, `jq` to
markdown bullets with permalinks. Every failure path exits 0.

**Neither collector may be installed over an existing `~/.config/ppr/day.d/`.**
`install.sh` copies them only when the directory is absent, because a user who
edited `10-github` should not have it replaced by an upgrade.

## Phase 4 — documentation

- `plugins/ppr-day/README.md` — the contract, verbatim from Part III.
- `plugins/README.md` — add `ppr-day` to the worked examples, noting it is the
  first plugin that is *neither* pushed-to nor a pure reader: it reads the world
  and writes the vault through the CLI.
- Root `README.md` — one example line in the plugins section.
- `AGENTS.md` — one row in the *Extending ppr* table? **No.** The seams are
  unchanged; `ppr-day` is an instance of `ppr-foo` on PATH. Resist the edit.

---

# Part V — Risks, and what would make this a bad idea

| Risk | Severity | Mitigation |
|---|---|---|
| A collector hangs and the 18:00 job never completes | MED | Hard timeout, default 20 s, section treated as empty (R3) |
| Slack token in a config file, then in git | HIGH | `plugins.day.slackTokenEnv` holds a *name*; `guardSecret()` already refuses a value under `plugins.*` (AGENTS.md §5) — verify it does, and add a test if not |
| The day entry becomes a noisy wall of bullets | MED | It is a `kind: day`; plan 004's tidy pass treats generated entries on their own terms. Also: this is why `ppr dump` distills rather than storing raw |
| Two machines both run the 18:00 job into a synced vault | LOW | Two entries, both real, both kept. Git's problem, not ppr's — and the reason R4 is per-vault rather than global |
| `gh` changes its output format | LOW | The collector is the user's file after install; ppr ships a copy, not a dependency |
| Scheduling arbitrary words widens the attack surface | MED | The word must match `COMMAND_WORD` and resolve to `ppr-<word>`; the plist still names node and the script absolutely. Guarded in 1.2 and tested |

**What would make me change the verdict:** if phase 1.2 (schedulable externals)
turns out to require restructuring `Schedule` and `installed()` in a way that
makes the launchd code harder to read, drop it. `crontab -e` with the line ppr
prints is an acceptable v1, and the feature is not worth degrading the one file
where L22 was learned.

---

# Part VI — Open questions for the maintainer

1. **`--redistill`?** After appending three times, the day entry is one
   distilled section and three raw ones. A flag that re-runs the distiller over
   the whole body would fix the shape and would also rewrite words the user may
   have edited by hand. Recommendation: do not build it; if the shape annoys
   you in practice, the answer is to run `ppr day` once, at the end.
2. **Should `ppr day` also feed `memory learn`?** It is already scheduled at
   03:00 and would pick the day entry up on its own. Recommendation: leave it;
   two schedules that each do one thing beat one that does two.
3. **A `kind: day` or a `kind: log` with a tag?** Recommendation: `kind: day`.
   Kinds are open (`core/src/types.ts`), a new one costs nothing, and it makes
   `ppr ls -k day` a useful thing to type — which a tag also does, but a kind
   also keeps day reports out of `ppr recap`'s idea of "what I wrote".
4. **Linear / calendar collectors** — obvious next sources, both trivial once
   the contract exists (`linear` has an MCP and a GraphQL API; calendar is
   `icalBuddy` on macOS). Deliberately not in this plan: the contract is the
   deliverable, and three shipped collectors is a suite to maintain.
