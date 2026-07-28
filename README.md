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
ppr init
```

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

| Command | What it does |
| --- | --- |
| `ppr "text"` | Quick log. The fastest path from thought to file. |
| `ppr` | Opens a prompt, then asks a follow-up question or two. |
| `ppr dump [text]` | Brain dump in, clean entry out. Reads stdin. |
| `ppr clip <url>` | Fetches a page, extracts the content, saves what it says. |
| `ppr voice [file]` | Records, transcribes, distills. |
| `ppr append <ref>` | Keeps a thread going. |

`ppr dump` is the one to reach for when thoughts arrive faster than sentences. It
cuts filler and repetition, keeps every fact, and never invents anything. A bare
URL is treated as a clip, because remembering which command you wanted is not a
good use of anyone's attention.

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

| Key | Does |
| --- | --- |
| `↑ ↓` `j k` | Move. `g`/`G` jump to the ends, `ctrl-d`/`ctrl-u` page. |
| `⏎` `e` | Open the entry in `$EDITOR`. Saves, reloads, back to the list. |
| `o` `→` | Read the whole entry, scrollable. |
| `d` `tab` | **Dive** — jump to backlinks, related entries, a tag, or that day. |
| `b` `←` | Back, up the trail you dove down. |
| `/` | Filter this list as you type. |
| `a` | Append a line to the focused entry. |
| `n` | New entry, without leaving. |
| `x` | Delete, with a confirmation. |
| `y` | Copy the file path to the clipboard. |
| `r` | Reload from disk. |
| `?` | Every key. |
| `q` `esc` | Out. Escape steps back one layer at a time first. |

Dive is the part worth knowing about. Sitting on an entry, `d` offers only the
routes that actually lead somewhere — if nothing links to it and it shares no
tags, it says so rather than opening an empty menu.

Nothing about this affects scripting. Piped, `--json`, `--quiet`, and `--plain`
all print exactly what they printed before; the browser only appears when both
stdin and stdout are a terminal. Turn it off for good with
`ppr config set display.interactive false`, and `ppr browse` still opens it on demand.

## Find

| Command | What it does |
| --- | --- |
| `ppr ls` | Recent entries — the browser on a terminal, a list when piped. |
| `ppr today` / `ppr week` | The two windows you actually ask for. |
| `ppr search <query>` | Lexical search over titles, bodies, tags. |
| `ppr browse` | The keyboard browser, on demand. |
| `ppr show [ref] --related` | One entry, plus its neighbourhood. |
| `ppr links [ref]` | Backlinks, forward links, unresolved links. |
| `ppr tags` | What the vault is actually about. |
| `ppr path [ref]` | The file path — for `vim`, `bat`, `rg`, anything. |
| `ppr export -f jsonl` | Leaving is a feature. |

Refs are forgiving: `latest`, `^2` (second newest), any part of an id, or a title
fragment.

## Think

| Command | What it does |
| --- | --- |
| `ppr recap --since 7d` | Standup, weekly review, or narrative. |
| `ppr ask <question>` | An answer grounded in your entries, with citations. |
| `ppr memory learn` | Pulls durable facts out and keeps them. |

## AI, on your terms

```bash
ppr ai setup     # interactive
ppr ai test      # one prompt, end to end
ppr ai status
```

| Provider | Key needed | Runs where |
| --- | --- | --- |
| `none` (default) | — | Offline heuristics |
| `apple` | — | On-device, macOS 26+ with Apple Intelligence |
| `ollama` | — | Your machine |
| `command` | — | Any program that reads a prompt on stdin |
| `anthropic` | yes | Claude API |
| `openai` | yes | OpenAI, or any OpenAI-compatible endpoint |

`command` is the escape hatch: if you can run your model from a shell, ppr can use it.

```bash
ppr config set ai.provider command
ppr config set ai.command "llm -m mistral-7b"
```

API keys are read from the environment first, then from `~/.config/ppr/credentials.json`
(mode 0600). They are never written into the vault, which is likely to end up in git.

Add `--no-ai` to any command to force the offline path for that run.

### Voice

```bash
ppr config set transcribe.provider whisper-cpp
ppr config set transcribe.model ~/models/ggml-base.en.bin
ppr voice
```

`whisper-cpp` keeps transcription on your machine. `openai` and `command` backends
are also available. `ppr doctor` tells you exactly what is missing.

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

- **`@ppr/core`** — the engine. Entries, search, links, capture pipelines, AI tasks.
  Imports no platform API. Everything it touches is a port: `Storage`, `Clock`,
  `AIProvider`, `Transcriber`, `Fetcher`.
- **`ppr`** — the CLI. Commander, colour, prompts. Parses arguments, calls core,
  renders the result.

The browser repeats that split one level down: `ui/state.ts` is a pure reducer
(keys in, new state plus an effect out) with no terminal or vault access, and
`ui/screen.ts` is the only file that touches the TTY. That is why the navigation
logic — cursor maths, the view stack, filtering, the confirm flow — is covered by
ordinary unit tests with no pseudo-terminal in sight.

A mobile, desktop, or web client implements the same handful of ports and gets the
identical behaviour. That is not aspirational: the test suite already runs the whole
engine against an in-memory store with no filesystem involved. See
[`packages/core/README.md`](packages/core/README.md).

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
