# ppr

Local-first notes, logs, and brain dumps. Plain markdown on your disk, a CLI that
composes with everything else you use, and AI that is optional, pluggable, and
can run entirely on your own machine.

```bash
ppr "deploy failed again, rolled back to 4.2 #infra"
cat scratch.txt | ppr dump
ppr clip https://example.com/post
ppr search deploy --since 30d
ppr ask "why did we drop redis?"
vim $(ppr path latest)
```

## What it is

A file per entry, under `~/ppr/entries/2026/07/`. YAML frontmatter, markdown body,
`#tags` and `[[wikilinks]]` in the text. Every command works on those files and
nothing else — no database, no lock-in, no account. Delete `ppr` tomorrow and your
notes are exactly as readable as they are today.

**Local by default.** Writing, reading, searching, and linking never touch the
network. AI is off until you turn it on, and even then you can point it at a model
running on your own hardware.

**Composable.** Every command speaks `--json` and `-q` (ids only), reads stdin,
and returns meaningful exit codes. `ppr` is meant to sit in a pipeline.

**Degrades honestly.** With no model configured, `dump` still strips filler,
`recap` still lists your week, `ask` still finds the right entries. Nothing hard-fails
because a model was unavailable, and nothing silently discards your words.

## Install

```bash
git clone https://github.com/yourname/ppr && cd ppr
./scripts/install.sh
ppr setup
```

`ppr setup` walks you through it: creates the vault, picks a model backend,
stores a key or downloads a local model, sets up voice, and installs what is
missing — with your say-so at every step, and showing the plain command for
everything it does. `ppr init` on its own still works if you would rather do it
by hand.

Requires Node 20.11+ and pnpm.

The installer builds the project and puts a small `ppr` wrapper on your `PATH`
(it picks `$PNPM_HOME`, `~/.local/bin`, or `/usr/local/bin` — whichever is
already there). The wrapper runs the code in this repo rather than a copy of it.

**Updating is just editing.** Change the source, run `ppr`, and it rebuilds
itself first — no reinstall, nothing to remember after a `git pull`. A clean run
costs about 100 ms; the first run after an edit takes a couple of seconds while
it compiles.

If a build fails, ppr prints the compiler errors and then runs your last working
build anyway. A half-finished refactor should never stop you writing a note.

```bash
pnpm dev                          # watch mode: rebuilds on save, no pause on first run
PPR_NO_AUTOBUILD=1 ppr ls         # skip the freshness check for this run
./scripts/install.sh --dir ~/bin  # install somewhere specific
./scripts/install.sh --uninstall  # remove the command
```

Rebuild chatter goes to stderr, so `ppr ls --json | jq` stays clean.

## Capture


| Command            | What it does                                                      |
| ------------------ | ----------------------------------------------------------------- |
| `ppr "text"`       | Quick log. The fastest path from thought to file.                 |
| `ppr + text`       | The same, without quoting.                                        |
| `ppr write`        | A longer entry, composed in `$EDITOR`. Asks a follow-up question. |
| `ppr`              | What you wrote today. Writes nothing.                             |
| `ppr dump [text]`  | Brain dump in, clean entry out. Reads stdin.                      |
| `ppr clip <url>`   | Fetches a page, extracts the content, saves what it says.         |
| `ppr voice [file]` | Records, transcribes, distills.                                   |
| `ppr append <ref>` | Keeps a thread going.                                             |


`ppr dump` is the one to reach for when thoughts arrive faster than sentences. It
cuts filler and repetition, keeps every fact, and never invents anything.   
  
A bare URL is treated as a clip, because remembering which command you wanted is not a good use of anyone's attention.

### A note is a sentence; a command is a word

`ppr "shipped the migration"` logs it. `ppr shipped the migration` does not, and
neither does `ppr sync` — both report an unknown command.

The rule exists because no amount of cleverness can separate `ppr serach redis`
(a typo) from `ppr lunch with sam` (a note) by reading the words. So ppr uses
the shape of the invocation instead: **one quoted phrase is text; a bare word is
a command you got wrong**, however much English it happens to be. `sync`, `add`,
`log`, and `note` are all things people reasonably expect a note tool to do, and
none of them should quietly become an entry.

```
$ ppr serach redis
error Unknown command: serach
  Did you mean `ppr search`?
  To log it as a note:  ppr "serach redis"
  Or write it directly: ppr + serach redis
```

Every refusal names the likely command and shows how to capture the text anyway,
so the rule is learned from the error rather than from this page. Three things
always capture, no guessing involved:

```bash
ppr "any quoted phrase"     # the fast path
ppr + one or more words     # unquoted; `add` and `new` work too
echo text | ppr             # a pipe is already deliberate
```

All three are the same code path, so they behave identically — including *not*
asking you anything. A one-liner saves and gets out of the way.

Follow-up questions belong to `ppr write`, where you opened a prompt and are
already in a writing session. Add `--ask` to invite one onto a one-liner, or
`--no-follow` to refuse it anywhere.

### Composing with `ppr write`

`ppr write` opens `$EDITOR` on an empty markdown buffer. Save and quit to keep
the entry; quit without saving to discard it. ppr asks its follow-up question
after you come back.

Moving around and editing text is a solved problem, and the solution is already
open on your machine — a note tool has no business shipping a worse version of
your editor. The buffer has no commented instructions in it, because `#` starts
a tag here and a git-style comment block would either eat your tags or teach you
the wrong thing.

For a couple of quick lines without leaving the terminal:

```
$ ppr write -i
What's on your mind?
empty line or ctrl-d to save · ctrl-c to discard
│ rolled back the deploy
│ the leak was in the cache
│
? What made you choose this over the alternative?
  the tests kept flaking
✓ zhameb rolled back the deploy
```

The `│` gutter marks ppr's own input, so it is never confused with your shell's
prompt. Make inline the default with `ppr config set capture.compose inline`.

If no editor will start, ppr says so and drops to the inline prompt rather than
losing what you came to write.

A bare `ppr` shows today's entries instead of capturing, so running it by
accident costs nothing.

## Browse

`ppr ls` on a terminal opens a keyboard browser: a list on the left, a live
preview of whatever is focused on the right. So does `ppr search`, `ppr today`,
and `ppr week` — same commands, same filters, just a renderer that lets you move.

```
ppr  all entries                                                      2/48
──────────────────────────────────────────────────────────────────────────
  log   2h  read a good post on durable execution  │ standup: blocked on
▌ log   3h  standup: blocked on the auth review    │ the auth review
  log   5h  decided to keep memcached for now      │ cb1pms · log · Mon 27
  clip  1d  Durable execution, explained           │ #team
                                                   │
                                                   │ standup: blocked on
                                                   │ the auth review #team
──────────────────────────────────────────────────────────────────────────
↑↓ move   ⏎ edit   o read   d dive   / filter   b back   ? keys   q quit
```


| Key         | Does                                                               |
| ----------- | ------------------------------------------------------------------ |
| `↑ ↓` `j k` | Move. `g`/`G` jump to the ends, `ctrl-d`/`ctrl-u` page.            |
| `⏎` `e`     | Open the entry in `$EDITOR`. Saves, reloads, back to the list.     |
| `o` `→`     | Read the whole entry, scrollable.                                  |
| `d` `tab`   | **Dive** — jump to backlinks, related entries, a tag, or that day. |
| `b` `←`     | Back, up the trail you dove down.                                  |
| `/`         | Filter this list as you type.                                      |
| `a`         | Append a line to the focused entry.                                |
| `n`         | New entry, without leaving.                                        |
| `x`         | Delete, with a confirmation.                                       |
| `y`         | Copy the file path to the clipboard.                               |
| `r`         | Reload from disk.                                                  |
| `?`         | Every key.                                                         |
| `q` `esc`   | Out. Escape steps back one layer at a time first.                  |


Dive is the part worth knowing about. Sitting on an entry, `d` offers only the
routes that actually lead somewhere — if nothing links to it and it shares no
tags, it says so rather than opening an empty menu.

Nothing about this affects scripting. Piped, `--json`, `--quiet`, and `--plain`
all print exactly what they printed before; the browser only appears when both
stdin and stdout are a terminal. Turn it off for good with
`ppr config set display.interactive false`, and `ppr browse` still opens it on demand.

## Find


| Command                    | What it does                                                   |
| -------------------------- | -------------------------------------------------------------- |
| `ppr ls`                   | Recent entries — the browser on a terminal, a list when piped. |
| `ppr today` / `ppr week`   | The two windows you actually ask for.                          |
| `ppr search <query>`       | Lexical search over titles, bodies, tags.                      |
| `ppr browse`               | The keyboard browser, on demand.                               |
| `ppr show [ref] --related` | One entry, plus its neighbourhood.                             |
| `ppr links [ref]`          | Backlinks, forward links, unresolved links.                    |
| `ppr tags`                 | What the vault is actually about.                              |
| `ppr path [ref]`           | The file path — for `vim`, `bat`, `rg`, anything.              |
| `ppr export -f jsonl`      | Leaving is a feature.                                          |


Refs are forgiving: `latest`, `^2` (second newest), any part of an id, or a title
fragment.

## Think


| Command                | What it does                                        |
| ---------------------- | --------------------------------------------------- |
| `ppr recap --since 7d` | Standup, weekly review, or narrative.               |
| `ppr ask <question>`   | An answer grounded in your entries, with citations. |
| `ppr memory learn`     | Pulls durable facts out and keeps them.             |




## Setup and diagnosis

```bash
ppr setup                  # guided: configure, install, download
ppr setup voice            # just the voice steps
ppr setup voice.model      # just that one — swap models without the whole tour
ppr setup --list           # every step id
ppr doctor                 # what is wrong, and the command that fixes it
ppr doctor --fix           # offer to fix each one
ppr doctor voice --json    # the same list as data, scoped
```

Steps are dotted ids, so a prefix selects a family: `voice` covers
`voice.binary`, `voice.model`, and `voice.recorder`. Naming a step runs it even
when it would not otherwise apply.

Both read one registry of checks, so a wizard cannot drift from the diagnosis.
Every check that can fail carries the exact non-interactive command that fixes
it, which is what `--json` gives an agent:

```json
{ "id": "voice.model", "status": "missing", "detail": "no model file set",
  "fix": "ppr config set transcribe.model <path>", "repairable": true }
```

Checks follow your configuration: choose whisper and the binary and model checks
appear; choose a hosted backend and an API-key check appears.

## AI, on your terms

```bash
ppr ai setup     # pick a backend, keyboard or typed
ppr ai test      # one prompt, end to end
ppr ai status
ppr ai list      # every backend, model and transcription
```

The picker takes whichever input you reach for: arrows to move, or type to
filter, or type the number — Enter takes whatever is highlighted either way. It
collapses to a single line once you choose, so your scrollback keeps a record.
With no terminal it prints the numbered list and reads one line per question, so
`printf 'ollama\nqwen3\n\n' | ppr ai setup` configures a machine unattended.


| Provider         | Key needed | Runs where                                   |
| ---------------- | ---------- | -------------------------------------------- |
| `none` (default) | —          | Offline heuristics                           |
| `apple`          | —          | On-device, macOS 26+ with Apple Intelligence |
| `ollama`         | —          | Your machine                                 |
| `command`        | —          | Any program that reads a prompt on stdin     |
| `anthropic`      | yes        | Claude API                                   |
| `openai`         | yes        | OpenAI, or any OpenAI-compatible endpoint    |


`command` is the escape hatch: if you can run your model from a shell, ppr can use it.

```bash
ppr config set ai.provider command
ppr config set ai.command "llm -m mistral-7b"
```

### Where the API key goes

```bash
ppr ai key            # asks for it, and works out which variable it belongs in
ppr ai key sk-or-v1-… # same, without the prompt
```

That is the whole answer. The key is written to `~/.config/ppr/credentials.json`
at mode 0600 — never into your config file, and never into the vault, which is
likely to end up in git. Exporting the variable in your shell works too and
takes precedence; `ppr ai status` tells you which of the two it is reading.

What lives in config is the *name* of that variable, never the key:

```jsonc
// ~/.config/ppr/config.json
{ "ai": { "provider": "openai",
          "baseUrl": "https://openrouter.ai/api/v1",
          "model": "anthropic/claude-sonnet-5",
          "apiKeyEnv": "OPENROUTER_API_KEY" } }   // a name — ppr sets this for you
```

ppr names the variable after the endpoint, so an OpenAI-compatible host reads as
itself: OpenRouter gets `OPENROUTER_API_KEY`, Groq gets `GROQ_API_KEY`. Paste a
key where the name goes and every path refuses it and points you back at
`ppr ai key` — `ppr config set`, `ppr doctor`, and the error you get mid-command.
`ppr doctor --fix` will move an already-pasted key out of the file for you.

Add `--no-ai` to any command to force the offline path for that run.

### Voice

```bash
ppr config set transcribe.provider whisper-cpp
ppr config set transcribe.model ~/models/ggml-base.en.bin
ppr voice
```

`whisper-cpp` keeps transcription on your machine — `ppr setup` will download a
model for you (74 MB to 465 MB, your pick) and point the config at it. `openai`
and `command` backends are also available.

`ppr voice` checks the whole chain before the microphone opens, and if
transcription fails afterwards it tells you where your audio is rather than
discarding it.

**If transcription keeps returning a single stray word like "you", nothing was
recorded.** Whisper hallucinates on silence rather than failing, so ppr measures
the signal first and refuses instead of filing the result as a note.

Two things cause it, and ppr can tell them apart:

- **The wrong input device**, which is the common one. macOS lists virtual
inputs — Zoom, Loopback, BlackHole — beside real microphones, and they often
sort first. Recording from one produces perfect, permanent silence. ppr
records from the *system default* and flags a virtual device if you pick one.
- **Permission**, where only the system can answer. `ppr setup voice.permission`
asks macOS directly: if the decision is still open it triggers the prompt, and
if it was denied it opens the right Settings pane, since nothing else can undo that.

```bash
ppr setup voice.recorder    # pick an input, then record 3s and measure it
ppr setup voice.permission  # ask macOS for access
ppr config set transcribe.device 1   # or name it yourself
```

`--no-ai` skips model *generation*, not transcription — `ppr --no-ai voice` still
records and transcribes, it just stores your words as they came out.

## Config

Two layers: `~/.config/ppr/config.json` for everything, `<vault>/.ppr/config.json`
for one vault. Vault wins.

```bash
ppr config list
ppr config set capture.distill false
ppr config set display.listLimit 40 --local
```

Multiple vaults work the way you would hope: `$PPR_DIR`, `--vault <dir>`, or the
nearest `.ppr` directory walking up from the cwd — so a project can carry its own
journal.

## The vault is yours

```
~/ppr/
  entries/2026/07/2026-07-27-1432-rolled-back-the-deploy-x7k2.md
  .ppr/config.json
  .ppr/cache/      # disposable, gitignored
```

```markdown
---
id: 01kyjxrs4m2nb8q3
kind: log
title: Rolled back the deploy
created: 2026-07-27T14:32:05-07:00
updated: 2026-07-27T14:32:05-07:00
tags:
  - infra
---

Rolled back to 4.2 after the memory leak showed up in prod. See [[redis migration]].
```

Edit them in any editor. Sync them with git, Syncthing, or a shared drive. ppr
notices changes on the next command — the markdown is the source of truth, and the
index is only a cache.

## Architecture

Two packages, one boundary:

- `@ppr/core` — the engine. Entries, search, links, capture pipelines, AI tasks.
Imports no platform API. Everything it touches is a port: `Storage`, `Clock`,
`AIProvider`, `Transcriber`, `Fetcher`.
- `ppr` — the CLI. Commander, colour, prompts. Parses arguments, calls core,
renders the result.

The browser repeats that split one level down: `ui/state.ts` is a pure reducer
(keys in, new state plus an effect out) with no terminal or vault access, and
`ui/screen.ts` is the only file that touches the TTY. That is why the navigation
logic — cursor maths, the view stack, filtering, the confirm flow — is covered by
ordinary unit tests with no pseudo-terminal in sight.

A mobile, desktop, or web client implements the same handful of ports and gets the
identical behaviour. That is not aspirational: the test suite already runs the whole
engine against an in-memory store with no filesystem involved. See
`[packages/core/README.md](packages/core/README.md)`.

## Development

```bash
pnpm build       # both packages
pnpm test        # 61 tests, no network required
pnpm typecheck
```



## Prior art

Inspired by [paper](https://paper.rewrlution.com/), which makes the case that your
tools remember what shipped but not why. ppr takes that further: everything local,
everything scriptable, and the AI features are the free part.

## License

MIT