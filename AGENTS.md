# Working on ppr

You are looking at a local-first note-taking tool. This document is the context
you need before changing anything: what ppr is for, the rules the code holds to,
where things live, and the traps that have already been hit.

Read it once, end to end. It is shorter than the code you are about to touch.

---

## 1. What ppr is

A CLI that keeps notes, logs, and brain dumps as **plain markdown files on disk**,
one file per entry. It adds search, linking, and optional AI on top — without ever
becoming the thing that owns your notes.

The user is a developer who types faster than they think and wants a record of outcomes and 
*why* decisions were made. The competition is a text file and `grep`. Anything ppr
does that a text file plus grep already does well needs to justify itself.

**The product promise, in one line:** delete ppr tomorrow and your notes are exactly
as readable as they are today.

Everything in section 3 follows from that sentence. When a design question comes up
and this document does not answer it, re-read that sentence and decide.

---

## 2. Philosophy

**Local by default.** Writing, reading, searching, and linking never touch the
network. AI is opt-in, and even switched on it can run entirely on-device (Apple
Foundation Models, Ollama, any shell command). "Bring your own key" is the model,
never "sign in to continue".

**Composable over featureful.** Every command speaks `--json`, accepts stdin, and
returns a meaningful exit code. ppr is designed to sit inside a pipeline, not to be
the last program you run. If a feature cannot be scripted, it is not finished.

**Degrade, never fail.** A missing model, a broken API, a rate limit — none of these
may cost the user their words. Every AI path has an offline fallback that is
documented and tested.

**YAGNI, honestly applied.** No speculative abstraction, no config knob for a
problem nobody has, no dependency that saves ten lines. The current dependency list
is `commander`, `picocolors`, and `yaml`. Adding a fourth needs a real argument.

**DRY where it matters.** One definition of the filter flags. One editor spawn. One
short-id format. One capture path. Duplication of *logic* is a bug; duplication of
a two-line literal usually is not. The test is whether the copies can drift into
disagreeing — `ppr "text"` and `ppr + text` had separate implementations and one
of them started asking AI follow-up questions the other did not.

---

## 3. Invariants

These are not preferences. Breaking one is a bug even if every test passes.

**I1. The markdown files are the source of truth.**
The index (`.ppr/cache/index.json`) is a disposable cache keyed by mtime and size.
Deleting it must change nothing but speed. A file edited in vim, or arriving from a
`git pull`, is picked up on the next command — never ignored because the cache
disagreed. *Enforced by:* `Catalog.load()` re-stats every file; tests
"files edited outside ppr are picked up" and "the cache never hides a changed file".

**I2. No AI failure costs the user their words.**
If a model returns garbage, times out, or is not configured, the command still
completes and the original text still reaches disk. A distiller that ate half a
brain dump would be worse than having no distiller. *Enforced by:* every task in
`ai/tasks.ts` falls back to `ai/fallback.ts`; test "a model that returns garbage
never costs you the dump" runs five kinds of bad output.

**I3. Unknown frontmatter round-trips.**
Keys ppr does not own are preserved verbatim on write, so a vault can be shared with
Obsidian or anything else. *Enforced by:* `Entry.extra` and the `OWNED` set in
`entry.ts`; test "unknown frontmatter keys are preserved".

**I4. Interactive is a rendering mode, never a change in semantics.**
`ppr ls` piped, `--json`, `--quiet`, or `--plain` produces exactly what it produced
before the browser existed. Interactive UI engages only when stdin *and* stdout are
a TTY. *Enforced by:* `canBrowse()`; test "list commands stay plain when there is no
terminal" asserts no alt-screen sequence ever reaches a pipe.

**I5. The terminal is always handed back.**
Raw mode, the alternate screen, and a hidden cursor are all restored on every exit
path: normal quit, `ctrl-c`, `SIGTERM`, an editor that crashed, an uncaught throw.
*Enforced by:* `Screen.close()` wired to `exit`, `SIGINT`, and `SIGTERM`.

**I6. Never block waiting for input nobody is sending.**
Read stdin only when it is a pipe, socket, or file — never when it is a character
device. A CLI that hangs in cron is broken. *Enforced by:* `hasStdin()` in `input.ts`.

**I7. Secrets never enter the vault, a config file, or an error message.**
API keys live in the environment or `~/.config/ppr/credentials.json` (mode 0600).
The vault is assumed to be in git. Config stores `apiKeyEnv`, a *name*, never a
value — and because everyone pastes the key there once, every path that touches
it refuses to: `guardSecret()` on the way in, `keyEnvFor()` when reading it back,
`redactSecret()` before it can reach stderr. *Enforced by:* tests "a key pasted
where a variable name belongs is refused, not written" and "a key pasted into
apiKeyEnv is caught, and never echoed back".

**I8. `@ppr/core` imports no platform API.**
No `node:fs`, no `node:child_process`, no `process.env` for behaviour. Everything
external arrives through a port. This is the single load-bearing architectural
decision — see section 4. *Enforced by:* review, and by the test suite running the
whole engine against `MemoryStorage`.

**I9. Writes are atomic.**
Temp file plus rename. An interrupted `ppr` cannot leave half an entry on disk.
*Enforced by:* `NodeStorage.write()`.

**I10. Output discipline.** Data goes to stdout; everything else — progress,
warnings, confirmations, rebuild chatter — goes to stderr. `ppr ls --json | jq`
must never see a stray word.

**I11. Never turn a mistake into data.** A command that is not recognised is an
error, never an entry. Capture requires an unambiguous signal: a single argument
containing whitespace (a quoted phrase), an explicit `+`/`add`/`new`/`write`, or
a pipe. A bare word is always a command — `sync`, `log`, and `note` are things
people expect this tool to do, and a vault only stays trustworthy if nothing
lands in it by accident. *Enforced by:* the default action in
`cli/src/index.ts`; tests "a mistyped command never becomes an entry" and "a
bare word is never a note, however ordinary it looks".

**I12. Memory is state; everything else is a log.**
`kind: memory` records something that *is true*, not something that *happened*.
It is therefore outside the timeline: `latest`, `^2`, `ppr ls`, `ppr recap`, and
search all skip it unless `-k memory` asks for it, and `ppr memory learn` never
reads a memory as a source. Ignoring this is how the memory layer ate its own
tail — learn defaulted to `latest`, `latest` became the fact it had just
written, and every run after the first reported "nothing durable in there".
A `kind: reminder` is on the log side of that line and stays there: you *did*
say "remind me to call the dentist" at the moment you said it, and it completes
rather than ceasing to be true. Carrying a date does not make something state —
`ppr brief` reads dates, not kinds (see §5, dated anything).
The one deliberate exception is `ppr export`, which is interchange rather than
a view: it means "everything you have", and a backup that silently omitted the
fact store would lose data. It widens the default at its own call site (an
explicit `-k` is still exactly a filter) — `filterEntries()` keeps its default,
because every browsing command depends on it. *Enforced by:* `MEMORY_KIND` in
`types.ts`, the guard in `filterEntries()`, and `Catalog.timeline()`; tests
"memory never becomes the thing `latest` means", "facts stay out of lists,
recaps, and search until asked for by kind", and "export hands over the facts
too, unless you asked for a kind".

---

## 4. Architecture

### The boundary

```
packages/core   @ppr/core        the engine. No platform APIs. Portable.
                @ppr/core/node   filesystem + shell-backed adapters.
packages/cli    ppr              commander.js. Parse, call core, render.
```

`@ppr/core` reaches the outside world through five interfaces in `ports.ts`:

```ts
Storage      read/write/remove/list/stat, keyed by vault-relative POSIX paths
Clock        now()
AIProvider   id, model, local, generate(req)
Transcriber  id, local, transcribe(audio)
Fetcher      (url) => { status, contentType, body, url }
```

Only `Storage` is required. A mobile, desktop, or web client implements those and
reuses every behaviour verbatim — that is the whole point, and it is why I8 is
non-negotiable. `MemoryStorage` exists so the portable path is exercised on every
test run rather than assumed.

`Vault` is the entire public API. If a front-end needs something it cannot express
through `Vault`, the method belongs in core, not in the front-end.

### The same split, one level down

The interactive browser repeats the pattern:

```
ui/key.ts           the keyboard vocabulary. Node's events translated once.
ui/keyboard.ts      raw mode and listener cleanup, shared by every surface.
ui/text.ts          width-safe row building, shared by every surface.
ui/state.ts         pure reducer: (state, key) -> { state, effect }. No I/O.
ui/layout.ts        pure rendering: state -> string[]. No I/O.
ui/screen.ts        alt screen + whole-frame drawing, for full-screen views.
ui/browser.ts       the shell: runs the loop, executes effects against the vault.
ui/select-state.ts  pure reducer for picking one thing from a list.
ui/select.ts        the inline picker: renders below the cursor, collapses when done.
```

Full-screen views (the browser) own the alternate screen. Prompts (`select`)
render inline and leave the scrollback intact — a picker should not erase the
terminal you were reading a second ago. Both share `Keyboard` and `text.ts`.

This is why cursor maths, the view stack, filtering, and the confirm flow are
covered by ordinary unit tests with no pseudo-terminal involved. **Any new
interactive surface follows the same shape.** Logic that cannot be tested without a
terminal is logic in the wrong file.

### The memory pipeline

```
entries/**  ──learn──▶  candidates ──reconcile──▶  memory/**  ──▶  ask · brief · context
             extract      (facts)     new/dup/         (facts)
                                      refines/
                                      contradicts
```

Not a graph database and not embedding retrieval. The corpus *is* the curated
part: one-line facts, deduplicated on the way in, small enough that all of them
fit in a prompt. Retrieval is therefore trivial and offline — send everything
under `FACTS_IN_PROMPT`, rank lexically above it, and let dates be arithmetic.
The intelligence is spent on writing the store, not on searching it, which is
why the store stays legible enough to fix by hand.

Reconciliation asks how a candidate relates to what is already known *and* to
the candidates before it — one call, because both questions were already in the
one prompt. Under the model, `factKey` collapses exact repeats with nothing
switched on: the case a backfill produces, because a fact said on Monday and
again on Friday lands in two chunks of one run. Over it, a
`duplicate-of-candidate` verdict points *backwards* at an earlier sibling, and
`absorb()` merges the provenance into whatever that sibling became instead of
storing the fact again. A pointer that goes forwards, at itself, or at nothing
is not a verdict — the candidate is stored, because losing a fact is the worse
failure (I2). **Known limit:** the model not noticing the paraphrase in the
first place. That is now a number rather than a structural gap — the
`reconciliation` dimension of `pnpm eval` has a case for it — and a miss still
costs only what it used to: a second fact, collapsible on the next run when one
of the pair is `known`.

`ppr context` is the point of the whole thing: ppr is the layer notes go into,
and what it does with them is hand another tool a grounded snapshot. It runs no
model, so it is instant and identical every time.

### Where does my change go?

| If it is... | It goes in... |
| --- | --- |
| A rule about entries, search, links, or the graph | `packages/core/src/` |
| Anything about facts: shape, paths, provenance, state | `core/src/memory.ts` |
| Anything dated: the shared shape, occurrences, overdue | `core/src/memory.ts` |
| Reminders: their frontmatter, and reading a date out of words | `core/src/remind.ts` |
| Something needing `fs` or a subprocess | `packages/core/src/node/` |
| A new command or flag | `packages/cli/src/commands/` |
| How something looks in a terminal | `packages/cli/src/render.ts` or `ui/` |
| A decision about "what can I see next" | `core/src/navigate.ts` (it is a graph question) |
| Something that can be wrong with a user's setup | `cli/src/setup/checks.ts` — one registry, rendered by both `doctor` and `setup` |
| Terminal input, raw mode, escape codes | `packages/cli/src/ui/screen.ts`, nowhere else |

---

## 5. The data model

**Entry.** One markdown file. YAML frontmatter ppr owns (`id`, `kind`, `title`,
`created`, `updated`, `tags`, `source`, `pinned`) plus anything else, preserved in
`extra` (I3). `#tags` and `[[wikilinks]]` are parsed out of the body and merged with
explicit frontmatter tags. Code fences are excluded from that scan.

**Path.** `entries/YYYY/MM/YYYY-MM-DD-HHmm-slug-xxxx.md` — date first so the tree
sorts and greps well, id suffix so it is unique. Assigned at creation. An explicit
retitle via `vault.update({title})` moves the file; editing the file in place never
does.

**Id.** 16 chars: 10 of base32 millisecond timestamp, 6 random. Monotonic within a
millisecond (see L2). The **short id** shown to humans is the *last* 6 characters,
because the first ten are a timestamp and would look identical for entries written
in the same second. `Catalog.resolve()` accepts prefix or suffix, so anything
printed can be typed back.

**Refs.** Everything that takes an entry accepts `latest`, `^2` (second newest), a
full or partial id, or a title fragment. Ambiguity is an error with candidates
listed, never a silent guess.

**Fact.** A `kind: memory` entry, living in `memory/<slug>-xxxx.md` — flat and
undated *as a file*, because a fact is about a thing rather than a day. The body
is the fact, one line. Everything else rides in `extra`, which round-trips for
free (I3): `from` (the entry ids it was extracted from), `status`, `conflicts`,
`supersededBy`, plus `date` and `recurs` when the fact carries a calendar day.
`source` is `manual` or `learned`, and nothing automatic may rewrite a `manual`
one.

`date` (`YYYY-MM-DD`, with `0000` for an unknown year) and `recurs: yearly` are
the only structure the layer adds, and they earn it: they make `ppr brief` and
`ppr context` arithmetic rather than a judgement, so the forward-looking half
runs offline and identically every time. `recurs` is deliberately not a
scheduling language — a tool that grows RRULEs has become a calendar.

**Reminder.** A `kind: reminder` entry: a future intention, carrying the same
`date`/`recurs` in `extra` plus `status: done` once it is dealt with. It is the
opposite of a fact in the way that decides where it lives — you *did* say
"remind me to call the dentist" at the moment you said it, so a reminder is in
`entries/`, in the timeline, and in `ppr ls`. I12 is about state; an intention
is not state, it is an event that has a date attached to it.

**Dated anything.** `Vault.upcoming()` is about things with a `date`, not about
facts: a dated fact, a reminder, and a note somebody typed `date: 2027-03-01`
into by hand all arrive in `ppr brief` through one piece of arithmetic. The
hand-written case is a feature, not a leak — `date:` in frontmatter is the whole
interface, so a file written in vim reaches the brief with no ppr command
involved. `DatedItem` in `memory.ts` is the shared shape; `toFact` and `toDated`
are the two ways in. The one asymmetry is deliberate: a *fact* whose date has
passed drops out (the day happened), while an unfinished *timeline* item stays
for a seven-day grace window with negative `days`, because a missed intention is
exactly the thing worth being told about.

The store is a **projection**: delete `memory/` and `ppr memory learn --all`
rebuilds it. That is the property to protect when changing anything here — it
is what makes the layer trustworthy rather than a second place your data lives.
`.ppr/state.json` holds the high-water mark (an entry *id*, not a timestamp —
see L20) so a cron run reads only what is new. It means "everything before
this has been read", so only a run that actually read the backlog may move it
(L23).

**Config.** Three layers, later wins: `DEFAULT_CONFIG` < `~/.config/ppr/config.json`
< `<vault>/.ppr/config.json`. Writes persist only the delta. Optional keys with no
default must be listed in `OPTIONAL_KEYS` or `config set` will reject them (L5).

---

## 6. Conventions

**Errors.** Throw `PprError(code, message, hint)`. The code maps to an exit code in
`cli/src/index.ts`; the hint is the next thing the user should type. Never let a
stack trace reach a user — there is a test asserting that.

Exit codes: `2` invalid input · `3` not found / ambiguous · `4` no vault, no AI, bad
config · `5` AI or network · `6` external tool · `130` cancelled.

**Flags.** Global flags (`--json`, `--quiet`, `--vault`, `--no-color`, `--no-ai`) are
hoisted out of argv before commander sees them, so they work in any position. Add a
new global in `hoistGlobals()` *and* declare it on the program for `--help`. Shared
filter flags come from `filterFlags()` — one definition, used by every list command.

**Output.** Data on stdout, chrome on stderr (I10). Every command that produces
entries supports `--json` and `-q`. Colour goes through the helpers in `render.ts`,
which collapse to identity when piped or when `NO_COLOR` is set.

**Comments.** Explain *why*, never *what*. A comment restating the code is noise; a
comment recording a decision or a trap is the most valuable line in the file. Match
the density already present.

**Types.** `strict`, plus `noUncheckedIndexedAccess`. Prefer narrow types over
casts. `exactOptionalPropertyTypes` is off, but conditional spreads
(`...(x ? { x } : {})`) are the house style for optional fields anyway.

---

## 7. Recipes

### Add a command

1. Write it in the right file under `commands/` (`capture`, `browse`, `think`,
   `settings`, `setup`, `schedule`, `meta`) — or a new file if it is a new
   category.
2. Return a `Command`. Take global options via `globals()`, never
   `cmd.optsWithGlobals()`.
3. Wrap the body in `withVault(self, async (vault) => …)` so `--vault` and `--no-ai`
   behave identically everywhere.
4. Handle `--json` and `-q` before the human-readable branch.
5. Register it in `cli/src/index.ts`.
6. Add an integration test in `packages/cli/test/cli.test.js`.

### Add an AI provider

1. Network-only? `core/src/ai/providers.ts`. Needs a shell? `core/src/node/`, then
   `registerProvider()` from `core/src/node.ts` so core stays portable.
2. Add it to the `AIConfig['provider']` union and `PROVIDER_DEFAULTS`.
3. Add it to `PROVIDER_HELP` in `commands/settings.ts` so setup and `ai list` show it.
4. Test the request shape against the local stub server in
   `core/test/providers.test.js`. Never test against a live API.

### Add an interactive surface

1. State in a pure reducer, rendering in a pure function, I/O in `screen.ts`
   (section 4). No exceptions — this is what makes it testable.
2. Gate it behind a TTY check, and make sure the non-TTY path is identical to what
   existed before (I4).
3. Unit-test the reducer. Then verify the real thing through a PTY (section 8).

### Change the entry format

Think twice. Files already on disk must keep parsing. `parseEntry` is deliberately
forgiving: no frontmatter, broken YAML, or a hand-written file all still load. Any
new field is optional, and absence has a defined meaning.

---

## 8. Testing

```bash
pnpm test        # 240 tests. No network. No TTY required.
pnpm typecheck
pnpm build
```

**Where things are tested:**

- `core/test/entry.test.js` — round trips, parsing, ids, time parsing.
- `core/test/vault.test.js` — CRUD, filtering, refs, links, external edits.
- `core/test/ai.test.js` — every AI task, with a scripted fake provider and its
  fallback. This is how AI behaviour is tested without a model. Learning and
  reconciliation live here too, because both are AI tasks with a fallback.
- `core/test/memory.test.js` — the pure half of the fact layer: date parsing,
  recurrence, overdue windows, and which words identify a fact. No provider
  involved.
- `core/test/remind.test.js` — reading a day out of a typed line, and the
  phrases that must *not* be read as one. Pure, table-driven, fixed `now`.
- `core/test/links.test.js` — auto-linking known names without touching code,
  URLs, or a link that is already there.
- `core/test/providers.test.js` — provider wire formats against a local HTTP stub.
- `core/test/search.test.js` — ranking and config paths.
- `core/test/audio.test.js` — silence detection on synthesised WAVs (L14).
- `core/test/microphone.test.js` — device enumeration and which inputs are
  virtual (L15).
- `cli/test/state.test.js` — the browser reducer. Pure, fast, no terminal.
- `cli/test/select.test.js` — the inline picker's reducer and the frame it
  renders, including typed answers for a machine with no terminal.
- `cli/test/schedule.test.js` — the launchd plist and crontab line, including
  the absolute paths a scheduler needs (L22).
- `cli/test/followups.test.js` — when a capture is allowed to ask a question.
- `cli/test/suggest.test.js` — did-you-mean, and what it refuses to guess.
- `cli/test/cli.test.js` — the real binary, spawned against a temp vault.

**Rules.** No test may reach the network. No test may touch the developer's real
config — the CLI harness redirects `XDG_CONFIG_HOME` and `PPR_DIR` into a temp dir,
and any new test must too. Tests assert behaviour a user would notice, and the test
name says what that behaviour is.

**Evals: `pnpm eval`.** The test suite scripts the model, which is the only way
to pin behaviour — and it means everything handed *to* a model is untested by
construction. Does it split a compound sentence, refuse to invent a year, notice
that "Sam owns auth" and "authentication is Sam's job" are one fact? Only
`packages/core/eval` answers that, by running the real pipeline against a real
model and scoring with deterministic keyword matching (never a model judging a
model).

It is not part of `pnpm test`: it costs money, needs a network, and is not
deterministic. Run it when you change a prompt, the fact schema, or
reconciliation — and use `--repeat 3`, because a single pass cannot tell a real
regression from model noise.

```bash
pnpm eval                                # the configured model
pnpm eval --model openai/gpt-4o-mini     # a specific one
pnpm eval --dimension dates --repeat 3   # while iterating on one prompt
pnpm eval --save                         # append the score to eval/runs.jsonl
pnpm eval --json > runs/$(date +%F).json # a number to compare next month
```

Dimensions: decomposition, precision, recall, provenance, dates,
reconciliation, retrieval, reminders, brief. A case asserts on *meaning* — a
set of words that must appear in some fact — and every case also says what
would be wrong, because a suite that only measures recall rewards a model that
keeps everything.

Three case shapes, for the three doors a model comes through. `rounds` (plus
`ask`) drive `learn()` and `ask()` on one vault. `remind` drives
`reminderFrom()` on a line the deterministic reader in `remind.ts` gives up on
— the only lines where a model is consulted at all — and `brief` drives
`brief()` over items whose dates were settled by arithmetic first, so what it
measures is the wording. Both pin "today" through the vault's `Clock`: an
assertion about a date is worth nothing if it means something else tomorrow.

`recall` is the one that carries a realistic load: eight entries, deliberately
past `EXTRACT_CHUNK_CHARS` so the batch spans more than one extraction call.
Every other case hands the model one or two short entries, which is the size at
which nothing can go wrong — and that is exactly why a backfill could extract
two thirds of a vault while the suite scored 100%.

`--save` appends one line of JSON (when, model, repeat, summary) to
`packages/core/eval/runs.jsonl`, so "did that prompt change help" has an answer
that is not a memory. The file is untracked on purpose: it is one machine's
measurements of a non-deterministic system, and a filtered run records a
filtered summary.

**Testing a TUI.** The reducer covers the logic. To verify real rendering, drive the
built binary through a pseudo-terminal — Python's `pty` module works where `script`
does not, because it needs no controlling terminal. Allocate a pty, set the window
size with `TIOCSWINSZ`, write keystrokes with pauses so frames render, then split the
output on cursor-home and strip escape codes to inspect the final frame.

---

## 9. Lessons already learned

Each of these was a real bug. They are the reason for code that might otherwise look
over-careful.

**L1. `!process.stdin.isTTY` does not mean "there is piped input".** A process
launched by a daemon, a test runner, or an editor plugin inherits a stdin that
reports non-TTY and never reaches EOF — so ppr hung forever. Check the *file type*
instead: anything but a character device can be read. Note that Node's
`stdio: 'pipe'` produces a **socket**, not a FIFO, which is why the predicate is
`!isCharacterDevice()` rather than a list of allowed types.

**L2. Time-prefixed random ids are not ordered within a millisecond.** Two entries
created in the same tick sorted randomly, so `ppr show ^2` picked between them at
chance. The fix is ULID-style monotonicity: within the same millisecond, increment
the random tail instead of re-rolling it.

**L3. Truncating a string that already contains ANSI codes breaks the terminal.**
Build rows from styled *segments*, measure width on the visible text, and apply
colour after clipping. See `row()` in `ui/layout.ts`.

**L4. Commander scopes options to the command they follow.** `ppr ls --json` and
`ppr --json ls` would behave differently, which is unacceptable for a tool built to
be piped. Global flags are therefore pulled out of argv before parsing.

**L5. Optional config keys were unsettable.** `ai.baseUrl` has no default, so it was
absent from `DEFAULT_CONFIG`, so `config set` rejected it as unknown — while still
being the single most necessary key for a local endpoint. Optional keys are declared
in `OPTIONAL_KEYS` and shown as unset in `config list`.

**L6. `pnpm -s` swallows compiler diagnostics.** The install wrapper hid the errors
at exactly the moment the user needed them. Buffer build output and print it on
failure instead of silencing it.

**L7. Validate before doing expensive or destructive work.** `ppr voice` used to
record audio and *then* discover there was no transcriber, throwing the recording
away. Check preconditions first.

**L8. Editing a temp copy silently discards frontmatter edits.** `ppr edit` used to
copy the body out, open it, and patch it back — so a tag the user fixed in
frontmatter vanished. Entries are edited in place, which is also what "it's just
markdown" has to mean.

**L9. A flag name can only mean one thing.** `--vault <dir>` (global) collided with
`config set --vault` (scope), and the global hoister silently ate it. The scope flag
became `--local`.

**L10. Piped answers to sequential prompts get dropped.** readline emits every
line the moment a pipe delivers them; a line nobody is awaiting at that instant
is gone. Creating a fresh interface per question made it worse — closing one ends
the stream, so the second question never resolved and the process died with an
unsettled promise. One shared reader that queues lines fixes both, and makes
`ppr ai setup < answers.txt` work.

**L11. Only one consumer may read stdin.** A readline interface left attached
while `Keyboard` is in raw mode delivers every keystroke twice — once as a line,
once as a keypress — so a confirm and the picker after it both consumed the same
answer. `Keyboard.start()` now detaches line input, and queued lines survive the
handover.

**L12. Preflight the whole chain, not the first link.** `ppr voice` checked that
a transcription provider was configured, then recorded, then discovered the
model file was missing — and the recording died with the error. Check everything
the operation needs before the expensive or irreversible part, and if it fails
afterwards anyway, tell the user where their data is.

**L13. A confirmed action must not second-guess the user.** Repairs guarded
themselves with "already configured, nothing to do" — so answering *yes* to
"Change it?" printed "already have it" and changed nothing. By the time a repair
runs, consent has been given; the guard belongs in whether to *offer* the step,
never in whether to honour it.

**L14. Whisper hallucinates on silence rather than failing.** A recording of
nothing transcribes as "you" or "Thank you." and gets filed as a note. Measuring
the signal (`analyzeWav`) is deterministic where guessing from the transcript is
not.

**L15. Audio device index 0 is not the microphone.** `record()` used
avfoundation `:0`, and on any Mac with Zoom installed index 0 is
`ZoomAudioDevice` — a virtual input that records flawless silence. Record from
`default`, which follows the system setting, and flag virtual devices when the
user picks one. The lesson generalises: an enumerated index is whatever sorted
first that day, not the thing you meant.

**L16. Diagnose before you blame.** The silent recordings looked like a
permission problem and were reported as one; permission was granted the whole
time. Two failures with one symptom need a check that distinguishes them —
`micPermission()` asks the system rather than guessing, so the hint names the
cause that actually applies.

**L17. Ambiguity between data and commands must be resolved by the user, not
guessed.** Any unrecognised word used to fall through to capture, so
`ppr serach redis` filed a note saying "serach redis". No heuristic can separate
a mistyped command from a short note — the information is not in the text. The
fix was to find a signal the user already sends: quoting. One argument is a
note, several are an attempted command, `+` is the explicit unquoted path, and
a bare invocation reports rather than writes. When a guess would sometimes
destroy intent, make the intent explicit instead of improving the guess.

**L18. Two ways to do one thing will drift.** `ppr "text"` and `ppr + text` are
the same act, but the entry point had its own copy of the capture logic, so only
one of them asked follow-up questions. Both now call `quickLog`. When adding a
shortcut for an existing command, route it through that command rather than
reimplementing the short version.

**L20. A second-resolution timestamp cannot order a high-water mark.**
`created` is stored to the second so it reads well, so two entries written in
the same second are indistinguishable — and an incremental learner keyed on
time skipped the second one forever. Ids are time-prefixed and monotonic (L2),
so compare those instead. Anything that means "everything after X" wants an id.

**L21. A failed model looks exactly like an empty answer.**
`extractFacts` returning no facts meant both "nothing durable in these entries"
and "the reply was mangled". Treating them alike advanced the mark past entries
no model had ever successfully read, and they never came back. Every task that
can both legitimately return nothing *and* fail must say which happened — hence
`FactBatch.ok`.

**L22. An enumerated environment is not your shell.** The scheduled jobs ran
`dist/index.js` and trusted its `#!/usr/bin/env node` shebang, which works in
every terminal and in none of the places a scheduler starts a process: launchd
gives a job `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, cron gives it about as much,
and a Homebrew, nvm, or volta node is on neither. Every 3am run died with
"env: node: No such file or directory" in a log nobody reads. Anything handed
to launchd, cron, or another program's environment names its interpreter and
its script by absolute path — and for the same reason `--vault` is written out
rather than inherited from a cwd that will not exist. Related: the uid fallback
that guessed `501` is gone; `gui/501` is the first account on most Macs and
somebody else's on the rest, and a wrong guess is worse than a clear failure.

**L23. A window is not the backlog.** `ppr memory learn <ref>` and
`--since` read entries that can start *after* the high-water mark, and both
then advanced it to the newest thing they had read — declaring everything in
the gap done. Nothing offers those entries to a model again, because `learn`
is incremental by default, so they were gone silently and permanently. The
mark is a claim about *everything before* a point, and only a run that read
from the mark (or `--all`) is entitled to make it. This is L21 with a
different trigger, and the same asymmetry decides it: a mark left behind
costs a re-scan that reconciliation absorbs, a mark moved wrongly costs words.

**L19. An invisible exit is not an exit.** `ppr write` ended only on Ctrl-D,
announced once in dim text that scrolled away, with no marker showing you were
inside a prompt at all — so people could not tell ppr's input from their
shell's, and could not get out. Interactive input needs a visible boundary on
every line, more than one way to finish, and its instructions kept on screen.

---

## 10. Workflow

```bash
pnpm install
pnpm build                 # both packages
pnpm dev                   # watch mode
./scripts/install.sh       # put `ppr` on PATH, running from this repo
```

The installed `ppr` is a wrapper that rebuilds when sources are newer than the last
build, so editing the source is all it takes to update the command. If the build
fails it prints the diagnostics and runs the previous build, because a half-finished
refactor should not stop the user writing a note.

**Commits.** Explain why, not what. Body wrapped at 80. Mention which invariant a
change protects or relaxes. Do not commit unless asked.

**Before you say you are done:** `pnpm build && pnpm typecheck && pnpm test`, and
actually run the command you changed. Report what you verified and what you did not.

---

## 11. What not to do

- Do not add a database, an index server, or a sync daemon. Git is the sync story.
- Do not add embeddings or a vector store to search. Lexical search needs no setup,
  works offline, and is instant on a personal vault. `ppr ask` is where semantics live.
- Do not make AI required for any command that has a sensible offline behaviour.
- Do not add a config option to avoid making a decision.
- Do not let the CLI accumulate logic that belongs in core — if a future mobile app
  would need it, it is core's job.
- Do not build a text editor. `ppr write` hands you `$EDITOR`, where you already
  know how to move around; cursor movement, wrapping, and undo are solved and
  reimplementing them badly is worse than not having them.
- Do not add mouse support to the terminal UI without a strong reason: capturing
  mouse events breaks native text selection, which matters more in a note tool than
  click-to-focus does.
- Do not reformat, rename, or "tidy" code you were not asked to change.
