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
ppr context "redis" | claude -p "what should we try next?"
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
git clone https://github.com/yosefserkez/ppr && cd ppr
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
The three programs in `plugins/` go on `PATH` beside it, because `--notify`,
`--push`, and `ppr contact` look them up by name. One of yours already sitting
under those names is left alone — that is how you replace one.

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
./scripts/install.sh --no-plugins # skip ppr-notify and ppr-reminders-push
./scripts/install.sh --uninstall  # remove the command
```

Rebuild chatter goes to stderr, so `ppr ls --json | jq` stays clean.

## Capture


| Command                    | What it does                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `ppr "text"`               | Quick log. The fastest path from thought to file.                 |
| `ppr + text`               | The same, without quoting.                                        |
| `ppr write`                | A longer entry, composed in `$EDITOR`. Asks a follow-up question. |
| `ppr`                      | What you wrote today. Writes nothing.                             |
| `ppr dump [text]`          | Brain dump in, clean entry out. Reads stdin.                      |
| `ppr clip <url>`           | Fetches a page, extracts the content, saves what it says.         |
| `ppr voice [file]`         | Records, transcribes, distills.                                   |
| `ppr append <ref>`         | Keeps a thread going.                                             |
| `ppr remind <when> <text>` | Something to be reminded of, on a day.                            |
| `ppr todo <text>`          | Something to do, with no day on it.                               |
| `ppr todos`                | Everything open, overdue first.                                   |
| `ppr done <ref>`           | That reminder or todo is dealt with.                              |


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

### Reminders and todos

```bash
ppr remind tomorrow call the dentist
ppr remind "next friday" review the roadmap
ppr remind every year on 20 october call mum
ppr remind pay the rent --at "in 3 days"
ppr remind tomorrow call the dentist --push    # a copy in Reminders.app too
ppr "remind me to call the dentist tomorrow"   # the same thing, quoted
ppr todo buy milk                              # no day on it
ppr "todo: buy milk"                           # the same thing, quoted
ppr todos                                      # everything open
ppr done 6jc6ad                                # dealt with
```

A reminder is an ordinary entry with `date:` in its frontmatter, kept in the
timeline where you wrote it — `ppr ls` shows it like anything else, and
`ppr brief` counts down to it. The day is read out of your words; a model is
only asked when no rule can find one, and never gets to overrule a date that is
plainly there.

**A line with no readable date is kept as a todo, and says so.** A todo is a
reminder with the day left out — same kind, same file, same `ppr done` — so
nothing is demoted to a note about an intention just because the words held no
date. It waits in `ppr todos` instead of `ppr brief`, because there is nothing
to count down to.

```
$ ppr todos
! 6jc6ad  9 days overdue  file the expenses
  qzvmqr  in 3 days       water the plants
  78q6m2                  buy milk
```

Overdue first, most overdue at the top; then dated, soonest first; then the
undated ones, oldest first. `--all` shows what you have finished too. It runs no
model and reads nothing but frontmatter, so it is instant and the same list
twice.

`ppr done` writes `status: done` and changes nothing else; the file stays.
An unfinished *dated* reminder shows up in `ppr brief` as overdue for a week
after its day, then stops asking — a brief that never forgets is a guilt list
rather than a heads-up. `ppr todos` is the other half of that: a list you can
finish, so nothing ages off it.

### Letting something else do the ringing

**Delivery is somebody else's job.** ppr is not going to grow a daemon, a
notification centre, or a calendar; your machine has all three and they already
reach your watch. So ppr hands things over the same way it hands editing to
`$EDITOR` and scheduling to `launchd`, and then gets out of the way.

```bash
ppr brief --notify                # post it as a notification
ppr remind tomorrow call the dentist --push
ppr config set remind.push true   # every reminder, quoted ones included
```

The flag names what you want; a program outside ppr decides how it happens.
`--notify` runs `ppr-notify` and `--push` runs `ppr-reminders-push` — both
installed alongside ppr, both about forty lines, and both replaceable. Put your
own `ppr-reminders-push` earlier on `PATH` and `--push` means Todoist, with
nothing to configure and no ppr release involved.

That is the default, and it stays the cheap case because it needs no config at
all. The one sentence a name cannot say is "`--notify` means `/opt/my-notifier
--urgent`": a name takes no arguments, so the only way to add one is a wrapper
script called exactly `ppr-notify` that also wins `PATH` order — a lot of
ceremony for one extra word. So a line in your own config says it instead:

```jsonc
// ~/.config/ppr/config.json
{ "porcelain": { "notify": "/opt/my-notifier --urgent",
                 "reminders-push": "todoist-add --project Inbox" } }
```

Reach for a binding when you want arguments, or an absolute path, without
writing a wrapper and winning `PATH` order; otherwise a name is less to keep
track of. It is read from that file and never from a vault's, for the same
reason hooks are — a vault is a repo people clone, and this names a program to
run. What is bound is a command line and not a shell line: arguments and quoted
words work, a `|` is just an argument, and a pipeline means writing a script and
binding that — which is what `$EDITOR` has always asked for too, where
`EDITOR="code --wait"` works. `ppr plugins` says which of the two is answering
right now.

A pushed reminder's note carries a `file://` link to the markdown itself, so
tapping it in Reminders opens the entry. The file is the link; there is no
`ppr://` scheme to install.

Both are **one-way and fire-and-forget**. Nothing is read back, nothing syncs,
and completing the copy over there does not reach in here — the markdown stays
the only source of truth. The vault write happens first and always survives: if
the plugin fails, or is not installed, or you are not on the platform it needs,
you get one line on stderr and the entry is exactly where it would have been.

`--notify` posts the soonest item and a count of the rest, because banners
truncate hard and five things squeezed into two lines are read as none of them.
Nothing coming up posts nothing at all — a daily "nothing coming up" ping is
how a notification channel stops being read. Without the flag, a pipe does the
same job: `ppr brief --plain | ppr-notify`.

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


| Command                | What it does                                           |
| ---------------------- | ------------------------------------------------------ |
| `ppr recap --since 7d` | Standup, weekly review, or narrative.                  |
| `ppr thread <query>`   | Pick up a line of thought where you left it.           |
| `ppr ask <question>`   | An answer grounded in your entries, with citations.    |
| `ppr brief`            | What is coming up, from the dates ppr already holds.   |
| `ppr context [query]`  | Everything ppr knows, for another tool to reason with. |




### Threads

`recap` is a window and `search` is a list of matches. Neither answers *where
had I got to* — which is the only question you have when a business idea comes
back after eight months, or a concept turns up for the fourth time in three
years.

```
$ ppr thread coffee subscription
Mon 06 Oct 2025  log     dw2hn2  Coffee subscription idea                   matched
Wed 08 Oct 2025  log     teewq6  What the beans actually cost               matched
Tue 21 Oct 2025  note    6ry46j  Talked to a roaster                        matched
Tue 04 Nov 2025  note    4btg09  Unit economics, roughly                    linked
Wed 19 Nov 2025  log     3gs5tj  Shelving the coffee idea                   linked

                 ·  6 months later

Thu 14 May 2026  log     h52a51  Back to the coffee idea                    linked
Thu 21 May 2026  note    mvz1k3  Subscription versus one-off boxes          matched
Tue 26 May 2026  remind  qbz9q4  email the roaster about wholesale pricing  linked
Tue 02 Jun 2026  note    da7pvk  Where the coffee idea stands               matched

What you concluded
  2zrjt1  The coffee idea only works above 200 subscribers.
```

Nothing here is stored and no model decides what belongs. A thread is a walk
over the graph you already wrote: an id, `latest`, or `^2` names one entry and
anything else is searched for, and from those seeds ppr follows `[[wikilinks]]`
a long way and shared tags and titles exactly one step. A link is something you
did on purpose; a tag two entries have in common is a coincidence, and a thread
built out of coincidences would be the whole vault by Thursday.

The silences are arithmetic — six times the thread's own rhythm, never under a
fortnight, always over two months — so the offline view tells you it was put
down in November and picked up in May. With a model configured, the story comes
first and the timeline sits under it, because a summary you cannot check
against the entries is not worth much:

```
$ ppr thread coffee subscription
This thread is about whether a coffee subscription for small studios can work.
…
It sat untouched from 19 Nov 2025 until 14 May 2026, when two studios asked
where I got the beans. [h52a51] … The open question is still whether referrals
get me to 200 without paid acquisition; the last direction was checking the
roaster's smallest white-label run.

— then the timeline
…
```

`--no-summary` keeps the timeline alone, `--plain` also keeps the browser shut,
and `--json` gives `{ query, seededBy, entries, facts, gaps }`. With no model at
all you get the timeline and lose nothing but the prose.

And because the moment worth knowing a thought has come back is the moment you
write it down, the third entry on something says so — once, on stderr, and only
for a link it actually resolved:

```
$ ppr "asked the roaster what their smallest white-label run really is"
✓ 285kys asked the roaster what their smallest white-label run really is
  ↳ continues a thread (9 entries) — ppr thread 285kys
```



## Memory

`recap` looks backwards at what happened. Memory holds what is *true*: one-line
facts, kept apart from the journal because "Emily's birthday is 20 October" did
not happen on the afternoon it was written down.

```bash
ppr memory learn        # read what is new and fold it in
ppr memory ls           # everything ppr thinks it knows
ppr memory why <ref>    # the entries a fact came from
ppr memory review       # settle facts that disagree
ppr memory add "..."    # a fact by hand — learn never overwrites it
ppr memory add "Emily's birthday is 20 October" --date 2002-10-20 --recurs yearly
```

`--date` is what puts a fact into `ppr brief`. It is never read out of the
sentence for you: `source: manual` is a promise that a fact is your words, and a
command that quietly decided which part of them was the date would break it in
the one place the layer asks to be trusted. When a fact looks dated, ppr names
the flag and leaves the choice to you.

`learn` is incremental and safe on a timer: it keeps a high-water mark, so a
nightly run reads only what was written since the last one. It never settles a
contradiction. Two facts that disagree are both kept and flagged, and
`ppr memory review` is where you choose — a model deciding which of your facts
is true is not a feature.

Facts are markdown files in `memory/`, one per fact, editable in vim like
everything else. The store is a projection rather than a second place your data
lives: **delete** `memory/` **and** `ppr memory learn --all` **rebuilds it.**

Facts stay out of `ppr ls`, `recap`, and `search`, because state does not belong
in a timeline. `ppr search emily -k memory` looks in them, and a search that
would have matched a fact says so.

### What is coming up

`ppr brief` is the forward-looking half: **anything carrying a date**, counted
down. A birthday ppr learned, a reminder you set, and a note you typed
`date: 2027-03-01` into by hand all arrive the same way.

```
$ ppr brief
Emily's birthday is on 20 October, 12 days away — nothing about a present yet.
Call the dentist — 3 days overdue.
```

That last one is not an accident of the design, it *is* the design: `date:` in
frontmatter is the whole interface, so a file written in vim reaches the brief
with no ppr command involved. Which items are due is arithmetic, so
`ppr brief --plain` works with no model configured at all. The model only writes
the sentence.

```bash
ppr brief --json | jq '.[] | select(.overdue)'
ppr brief --notify                            # and as a notification
```



### Handing it to something else

`ppr context` is the point of the whole layer. ppr is where notes go *in*; what
it does with them is hand another tool a grounded snapshot. No model runs, so it
is instant and identical every time — which is what makes it safe to staple onto
someone else's prompt.

```bash
ppr context "gift for emily" | claude -p "help me pick something"
ppr context --json | jq .facts
```



### On a timer

```bash
ppr schedule add learn --at 03:00                     # launchd or cron
ppr schedule add brief --at 08:00 --notify            # arrives as a banner
ppr schedule add brief --pipe "mail -s brief me@example.com"
ppr schedule ls
```

ppr does not run in the background and will not start; `schedule` writes the
config for the scheduler your machine already has, and prints the crontab line
if it cannot install one.

A scheduled `brief` with nowhere to go writes into a log nobody reads, so the
useful half is delivery. `--notify` on a scheduled `brief` is not a pipe: what
gets installed is `ppr brief --plain --notify`, so the job announces itself and
the `notify` intent is resolved at 8am by the ppr that runs — rebind
`porcelain.notify` tomorrow and tomorrow's banner follows, with no job to add
again. That also keeps a binding out of the scheduler's shell, which is the
point: a `|` in one is an argument everywhere or a pipe nowhere.

`memory learn` has no `--notify` of its own, so there `--notify` still means
`--pipe ppr-notify` — the conventional name, looked up at 3am, never a binding.
And `--pipe` takes anything you can type on a command line, because ppr does not
need to know what is on the other end of it.

Only `learn` needs a model. `ppr ai test` sends one prompt end to end and says
whether yours answers — and whether it answers in JSON, which is what every ppr
task actually asks for. Everything else on this page works offline.

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
ppr ai test      # one prompt end to end: does it answer, and answer in JSON
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

`--dry-run` goes on any command. It does everything except write: the model
still runs, `$EDITOR` still opens, an error is still an error — and then a plan
on stderr says what would have been written and which of your hooks would have
been told about it.

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
  memory/emilys-birthday-is-20-october-k4p9.md
  .ppr/config.json
  .ppr/state.json  # where `memory learn` left off
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

## Build on ppr

**Everything outside the vault is a third-party tool — the operating system
included.** ppr's whole outward surface is three things: markdown files (the
truth), `--json` answers (ask it something), and events (it tells you when
something changed). There is no plugin API to version, no manifest, and nothing
to register.

Writes emit events; reads compose with pipes.

```bash
ppr brief --plain | ppr-notify     # a read composes; no event needed
```

**A hook** runs your command when ppr writes something. The event arrives as
JSON on stdin, with `PPR_EVENT` and `PPR_VAULT` in the environment:

```bash
ppr hooks add entry.created ppr-reminders-push
ppr hooks add learn.finished "jq '.learned | length' | logger -t ppr"
ppr hooks                          # what is wired to what
```

That writes the `hooks` half of a file you can equally well edit by hand — there
is nothing else to it, and nothing gets registered anywhere:

```jsonc
// ~/.config/ppr/config.json — and only here, never <vault>/.ppr/config.json,
// because a vault is a repo people clone and everything in these two blocks
// names a program ppr will run.
{
  "hooks": {
    "entry.created": ["ppr-reminders-push"],
    "learn.finished": ["jq '.learned | length' | logger -t ppr"]
  },
  "porcelain": {
    "notify": "/opt/my-notifier --urgent"
  }
}
```

A hook may write to a vault, and its write happens — but it announces nothing,
so ppr fans out once, from the command you ran. Otherwise a hook that logs a
copy somewhere is a new process per entry, forever. If yours wants a second
thing to happen, it runs it itself.

**A binding** is the other half of that file: one command line per intent, for
when `--notify` or `--push` should mean something a bare name on `PATH` cannot
say — `/opt/my-notifier --urgent`, arguments and all. Nothing writes it for you;
`ppr config set porcelain.…` refuses at every scope and names the file, because
hand-editing it is the whole interface.

**A** `ppr-foo` **on your** `PATH` is a subcommand, the way `git-foo` is:

```sh
#!/bin/sh
# ~/.local/bin/ppr-standup  ->  ppr standup
ppr recap --since 1d --style standup | pbcopy
```

`ppr plugins` shows the whole wiring diagram: which commands are listening
to which events, what `--push` and `--notify` currently resolve to and whether a
binding or `PATH` answered, every `ppr-*` you have installed, and which
`plugins.<name>` settings are set. Nothing is stored — it is computed from your
machine each time, so it cannot drift from the truth.

`--dry-run` is how you check a wiring change without triggering it:

```bash
ppr --dry-run "shipped it"                # the entry, and the hook it would fire
ppr config set ai.model llama3 --dry-run  # the delta, not the file
ppr schedule add brief --at 08:00 --dry-run
```

Models still run and `$EDITOR` still opens, because composing is not an effect
— saving is. The two commands where they are the same act, `ppr edit` and
`ppr setup`, say so and refuse rather than previewing half of themselves.

Events: `entry.created`, `entry.updated`, `entry.removed`, `entry.completed`,
`fact.learned`, `fact.refined`, `conflict.found`, `learn.finished`. Coarse on
purpose — a reminder is `entry.created` plus a check on `kind`, and the payload
carries the whole entry so you never have to ask a second question — including
`vault` and `path`, so a consumer can link straight to the markdown file. Your
settings live under `plugins.<you>.<key>`; read them with `ppr config get`.

`plugins/README.md` has the long version, with the three programs ppr ships as
worked examples — two that are pushed to, and one that pulls.

## Architecture

Two packages, one boundary:

- `@ppr/core` — the engine. Entries, search, links, capture pipelines, AI tasks.
Imports no platform API. Everything it touches is a port: `Storage`, `Clock`,
`AIProvider`, `Transcriber`, `Fetcher`.
- `ppr` — the CLI. Commander, colour, prompts. Parses arguments, calls core,
renders the result.

Plus `plugins/`, which is neither: three ordinary programs that ppr ships, puts
on your `PATH`, and finds by name. Nothing in `packages/` imports them.

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
pnpm test        # the whole suite, plugins included, no network required
pnpm eval        # scores the memory pipeline against a real model (costs money)
pnpm typecheck
```

