# Extending ppr: events, hooks, plugins

The rule everything here follows is **I13**: everything outside the vault is a
third-party tool, the operating system included. ppr must be buildable-upon
without ppr knowing the builder exists. Its whole outward surface is three
things — **events out** (push), **`--json` answers** (pull), **markdown files**
(truth).

The corollary that decides most questions:

> **Writes emit events. Reads compose with pipes.**

`ppr brief` needs no event, because `ppr brief --plain | ppr-notify` already
works. `ppr remind` does, because nobody was standing there.

## Pick the narrowest seam

Adding to ppr is the last resort, not the first.

| You want | Use |
| --- | --- |
| A new subcommand | `ppr-<name>` on PATH. Nothing to register. |
| To react to a write | A hook on an event: `ppr hooks add <event> <command>`. |
| To see what is currently wired | `ppr plugins` — hooks, intents, `ppr-*`, settings. |
| To check what something would do | `--dry-run` on any command. |
| To rebind `--notify` / `--push` | Your own `ppr-notify` / `ppr-reminders-push` earlier on PATH. |
| Somewhere to keep settings | `plugins.<name>.<key>` in config. |
| A field on an entry ppr must not eat | `Entry.extra` — round-trips (I3). |
| A new sort of entry | A new `kind`. It is any string. |
| A whole new host (mobile, web) | The ports in `core/src/ports.ts`. |

## The event vocabulary

```
entry.created   entry.updated   entry.removed   entry.completed
fact.learned    fact.refined    conflict.found  learn.finished
```

Eight names, and they are API forever. Three rules fix the shape:

- **Coarse.** There is no `reminder.created`: that is `entry.created` plus a
  check on `kind` in the consumer. A vocabulary that grows a name per kind has
  to be versioned every time a kind is added.
- **Complete.** Every payload carries the whole entry, both sides of anything
  that changed, and `v: 1`. A consumer that has to call back into ppr is a
  consumer racing the next write.
- **Two layers, both emitted.** A learned fact is `entry.created` (a file
  appeared) *and* `fact.learned` (a model decided it was durable). Different
  subscriptions; only the second knows why. Same for `ppr done`:
  `entry.updated` then `entry.completed`.

Reads emit nothing — not `ls`, `search`, `ask`, `brief`, `context`, `upcoming`.

## Adding an event

Do not, unless it is a genuinely new *act*. If it is:

1. `EVENT_NAMES` and the union in `core/src/events.ts`.
2. Emit at the true state change in `vault.ts`, through `this.emit` — never by
   calling the listener directly, or a throwing consumer takes the write with
   it (I2's shape).
3. Give the payload everything a consumer could want.
4. A case in `core/test/events.test.js`.

`v` bumps when a field's *meaning* changes, never when one is added.

## The hook security rule

**Hooks are honoured from `~/.config/ppr/config.json` and nowhere else.** Never
from `<vault>/.ppr/config.json`.

Config merges three layers and the vault layer wins — right for
`display.listLimit`, catastrophic for a list of shell commands. A vault is a
git repo we tell people to clone, so a vault-declared hook means
`git clone && ppr ls` runs a stranger's shell. Git reached the same conclusion:
hooks live in `.git/hooks` and do not clone.

Enforced structurally, not by a check:

- `hooks` is not a field on `Config`.
- `validateConfig` deletes any that a merge produced.
- The only reader is `readConfigLayer(globalConfigPath())` in `cli/src/hooks.ts`.
- `ppr config set hooks.…` refuses and names the file.

If you touch config merging, keep all four. The test is
"a hook declared by a vault is never run, however the vault got there".

`ppr hooks add/rm/ls` is a **pen over that file**, not a second mechanism: it
writes the same block in the same user layer, validates the event name against
`EVENT_NAMES`, warns (never errors) when the command is not on PATH yet, and
`saveHooks` is the only function in ppr that writes a hook. Hand-editing stays
exactly as supported. Never route registration through `config set` — that path
allows `--local`, and `--local` is the vault.

## Running somebody else's program

`cli/src/child.ts` is the **one** way, and both hooks and the plugin-backed
flags go through it:

- stdout discarded — a consumer must not get inside `ppr ls --json` (I10);
- failures are one stderr line, never an exit code, never the write;
- spawned immediately, so a ten-minute browse session does not deliver forty
  notifications at the end of it;
- `drainChildren()` waits two seconds at the end of a command, then unrefs and
  lets the child finish. Not a kill: a courier stopped halfway through is a
  copy that exists nowhere.

## The porcelain: friendly flags, conventional names

`ppr brief --notify` and `ppr remind --push` still exist and still default off.
What they no longer contain is any idea of *how*:

```
--notify  ->  ppr-notify            stdin: the text to show
--push    ->  ppr-reminders-push    stdin: the entry.created event
```

A flag names an **intent**; a conventional program name on PATH resolves the
**tool**. Replace the executable and the flag means something else, with no ppr
change. `$EDITOR`, `$PAGER`, and `git foo` → `git-foo`, applied to delivery.

It is not a second mechanism: `--push` sends the same event, through the same
`eventJson`, to the same program a hook on `entry.created` would run, using the
same `runChild`. `cli/src/porcelain.ts` holds the decisions
(`pushDecision`, `briefNotification`) and they are pure and unit-tested.

`pushDecision` asks "is there a program on PATH that does this", not "is this a
Mac". Keep it that way — that is the whole point.

`ppr plugins` is where a user sees what all of this currently resolves to. It
stores nothing and scans PATH through the same `findOnPath` the dispatcher uses,
so it cannot disagree with what actually runs. If you add a resolution rule, add
it there too — one definition.

## An upstream that names an entry links to it

A copy of a note in somebody else's app is a dead end unless it says where it
came from, and "type `ppr show 6jc6ad`" is not a link. Every payload carries
`vault` (absolute) and `entry.path` (vault-relative) exactly so a consumer can
build a `file://` URL without calling back in — a piped or replayed event stands
alone. Encode **per path segment**: `~/My Notes` is an ordinary vault, and
`encodeURI` leaves a `#` in a filename to truncate the link at a fragment.

No `ppr://` scheme. It needs an app bundle and an installer to reach a file that
already has a URL. `plugins/ppr-reminders-push`'s `fileUrl`/`reminderNote` are
the worked example, pure and tested.

## Where things go

| If it is... | It goes in... |
| --- | --- |
| What ppr announces when it writes | `core/src/events.ts` |
| Running anybody else's program | `cli/src/child.ts`, nowhere else |
| Wiring an event to a configured command | `cli/src/hooks.ts` |
| `ppr foo` → `ppr-foo`, and the env a plugin gets | `cli/src/external.ts` |
| What `--notify` / `--push` resolve to, and when | `cli/src/porcelain.ts` |
| AppleScript, its escaping, an osascript hint | `plugins/` — **not** ppr |

## The plugins

`plugins/` is neither package. Three programs ppr ships, `install.sh` puts on
PATH, and finds by name. Nothing in `packages/` imports them; nothing in them
imports ppr. Plain CommonJS, no dependencies, no build.

```
applescript.js        pure builders: escaping, date assembly, hints
osascript.js          the three lines that shell out, plus stdin reading
ppr-notify            the read composer
ppr-reminders-push    the write consumer
ppr-contact           the pull consumer
test/                 builders, extraction, event filters; run by `pnpm test`
```

This is the **single copy** of the AppleScript. Core keeps none: two copies of
escaping and component-by-component date assembly drift, and this is the code
where drift files somebody's reminder in the wrong month.

**No test may run osascript.** A suite that posts banners or files reminders
leaves litter in a real person's list. Test the builders; the executors are
three lines each for exactly that reason.

Two traps are paid for and commented in place: an AppleScript string literal
cannot span lines and takes exactly five escapes, and an AppleScript *date
literal* is parsed in the user's locale — so a date is assembled from
components, with `set day of d to 1` first so assigning a month never rolls the
date into the next one.

## A pull plugin, in any language

> **Call `ppr … --json`, transform, act.**

That is the whole pattern, and `plugins/ppr-contact` is the worked example: it
reads a person's facts out of `ppr context "<name>" --json`, picks out a phone
number, an email, and a birthday with plain patterns, and writes a card. Four
inputs and no more — its argv, an event on stdin, `PPR_VAULT`, and `ppr`
itself.

Three things it had to get right, and a new one will too:

- **The query does not filter for you.** `ppr context` returns the *whole* fact
  store while it is small — that is what one-line facts are for — so the
  neighbour's phone number arrives in the answer. Filter on your side.
- **A failure is not an empty answer** (L21's shape, out here). `spawnSync`
  failing means "could not ask"; an empty array means "asked, nothing there".
  Only one of them deserves a line on stderr.
- **Extraction is deterministic or it is a liability.** A model already decided
  the sentence was worth keeping. A second one deciding what a phone number
  looks like would rewrite somebody's card differently on every run.

A subcommand and a hook can be the same file. When they are, the event says
*who* and the pull says *what* — a record built from one event carries whichever
field that event mentioned and overwrites everything else you knew.

## Writing a consumer

```sh
#!/bin/sh
# ppr-say — reads new logs out loud.
jq -r 'select(.entry.kind == "log") | .entry.body' | xargs -0 -r say
```

Wire it: `"hooks": {"entry.created": ["ppr-say"]}`.

It is handed the event JSON on stdin, `PPR_EVENT`, and `PPR_VAULT`. An external
subcommand also gets `PPR_JSON`, `PPR_QUIET`, `NO_COLOR`, and `PPR_NO_AI`,
because the globals were hoisted out of argv before the word was read (L4).

A well-behaved consumer prints nothing on stdout, exits 0 when the event was
not its business, exits 0 where it cannot work at all (a courier must not turn
a Linux user's capture red), is quick or detaches, and never writes back into
the vault — one-way is what keeps the markdown the only owner of a row (I1).

`plugins/README.md` is the user-facing version of this page. Keep them agreeing.
