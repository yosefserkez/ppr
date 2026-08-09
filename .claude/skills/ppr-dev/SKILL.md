---
name: ppr-dev
description: Working on the ppr codebase — a local-first markdown note CLI with a portable core and a terminal UI. Use when adding or changing commands, AI providers, storage adapters, interactive views, the memory layer that distils standing facts out of entries, or the entry format; when deciding whether code belongs in @ppr/core or the CLI; or when reviewing a change against the project's invariants. Covers the architecture, the non-negotiable rules, and the traps that have already been hit.
---

# Working on ppr

`AGENTS.md` at the repo root is the canonical context: philosophy, the thirteen
invariants, the data model, conventions, and the bugs already learned from.
**Read it before your first change in a session.** This skill is the task-shaped
companion — what to do, in what order, for the changes that come up most.

## Orient in 30 seconds

```
packages/core   @ppr/core        the engine. Imports no platform API.
                @ppr/core/node   fs + subprocess adapters, shell-backed providers.
packages/cli    ppr              commander.js. Parse, call core, render.
```

`Vault` (`core/src/vault.ts`) is the entire public API. Core reaches the world
only through the ports in `core/src/ports.ts` (`Storage`, `Clock`, `AIProvider`,
`Transcriber`, `Fetcher`). That boundary is the load-bearing decision: a future
mobile or web client implements those ports and reuses everything else verbatim.

The terminal UI repeats the split one level down — pure reducer (`ui/state.ts`),
pure rendering (`ui/layout.ts`), all I/O isolated in `ui/screen.ts`.

A vault holds two trees. `entries/YYYY/MM/` is what happened; `memory/` is what
is true — one-line facts distilled out of the journal, outside the timeline and
rebuildable from it (I12). Facts are ordinary markdown entries with
`kind: memory`; everything the layer adds rides in `Entry.extra`.

A `kind: reminder` is an intention and lives in the *first* tree: you did say it
when you said it. What it shares with a fact is only `date:`/`recurs:` in
`extra`, which is what `ppr brief` counts down — dated anything, including a
file somebody typed `date:` into by hand.

## The six questions to ask before writing code

1. **Would a future mobile app need this logic?** Then it goes in core, not the CLI.
2. **Does it need `fs`, a subprocess, or `process.env`?** Then it cannot go in
   `@ppr/core` — use `@ppr/core/node` or the CLI.
3. **What happens with no AI configured?** Every feature needs a defined offline
   answer. "It errors" is only acceptable when there is genuinely nothing to do.
4. **What happens when it is piped?** Interactive behaviour must never change what
   a script sees.
5. **Is it something that happened, something that is true, or something to
   do?** The first is an entry, the second is a fact — and a fact must stay out
   of `latest`, `ls`, `recap`, and search unless `-k memory` asks for it (I12).
   The third is a reminder, which is an entry with a date on it and *stays* in
   the timeline; it completes rather than becoming untrue.
6. **Am I solving a problem someone actually has?** The dependency list is three
   packages. Keep it that way.
7. **Is something else already doing this?** Then hand it over rather than
   rebuilding it — `$EDITOR`, `launchd`, a program named by convention on PATH.
   Everything outside the vault is a third-party tool, the OS included (I13):
   ppr emits an event or prints something pipeable, and a separate program
   acts. One-way, fire-and-forget, vault write first, so a failure costs a
   stderr line and never an entry (`references/plugins.md`).

## Recipes

Load the reference for the task at hand:

| Task | Reference |
| --- | --- |
| Add or change a command, flag, or output format | `references/add-command.md` |
| Add an AI provider or transcription backend | `references/add-provider.md` |
| Add or change an interactive terminal view | `references/interactive-ui.md` |
| Add something that can be misconfigured or missing | `references/checks.md` |
| Change what ppr learns, a fact's shape, or a prompt | `references/memory.md` |
| Add an event, a hook, a plugin, or a `ppr-foo` subcommand | `references/plugins.md` |
| Hand something to another program — a notification, a push | `references/plugins.md` |

## Always, regardless of task

- Throw `PprError(code, message, hint)` — the hint is the next thing the user
  should type. A stack trace reaching a user is a bug with a test against it.
- Support `--json` and `-q` on anything that emits entries. Data to stdout,
  everything else to stderr.
- Read global flags with `globals()`, and open the vault with `withVault()`.
- Add a test that names the behaviour a user would notice. No test may reach the
  network or touch the developer's real config.

## Before saying you are done

```bash
pnpm build && pnpm typecheck && pnpm test
```

Then actually run the command you changed. Report what you verified and what you
did not — untested paths are fine to have, but not to imply otherwise.

`pnpm eval` is separate and deliberately not part of that line: it costs money,
needs a network, and is not deterministic. Run it — with `--repeat 3` — when you
change a prompt, the fact schema, or reconciliation, and never to check a
refactor.

## Do not

Add a database, embeddings, or a sync daemon. Make AI required where an offline
path exists. Add a config option instead of making a decision. Reformat or rename
code you were not asked to touch. Commit unless asked.
