# ppr plugins

Two small programs that ppr ships and does not depend on.

They are here because **everything outside the vault is a third-party tool, the
operating system included** (I13 in [AGENTS.md](../AGENTS.md)). ppr writes
markdown and says what it did; posting a banner, filing a reminder, ringing a
bell, and lighting a lamp are all somebody else's job. These two are the
reference somebody, and the reason `ppr brief --notify` and `ppr remind --push`
work the minute you install ppr.

Nothing in ppr imports them. They are found by name on `PATH`.

```
ppr-notify              text on stdin  ->  a macOS notification
ppr-reminders-push      a ppr event on stdin  ->  a reminder in Reminders.app
```

## The two shapes of consumer

**Reads compose with pipes.** `ppr-notify` is the read composer. It takes text
on stdin and shows it; it has never heard of ppr and would work just as well on
the output of `date`.

```sh
ppr brief --plain | ppr-notify
ppr brief --plain | ppr-notify --title "this morning"
```

**Writes emit events.** `ppr-reminders-push` is the write consumer. It reads one
event as JSON on stdin, decides for itself whether that event is any of its
business, and acts. Wire it to a hook:

```jsonc
// ~/.config/ppr/config.json — the user layer, and only the user layer
{
  "hooks": {
    "entry.created": ["ppr-reminders-push"]
  }
}
```

Or let the porcelain do it: `ppr remind --push`, or `ppr config set
remind.push true`, sends the same `entry.created` event to the same program.
The flag names the intent; this file name resolves the tool.

`ppr hooks add entry.created ppr-reminders-push` writes that same block for
you, and `ppr plugins` shows what is currently wired.

## The deep link is the file

A pushed reminder's note is three lines: what it was about, a `file://` URL,
and `ppr show <shortid>`.

```
call the dentist
file:///Users/me/My%20Notes/entries/2026/08/2026-08-10-0900-call-the-dentist-6ad.md
ppr show 6jc6ad
```

Reminders.app renders that URL as a clickable link, and clicking it opens the
markdown. There is no `ppr://` scheme and there is not going to be one: that
needs a registered app bundle and an installer, to arrive at a link to a file
that already has a perfectly good URL. **The file is the link.**

Every consumer can do this. An event carries `vault` (absolute) and
`entry.path` (vault-relative) exactly so you never have to call back into ppr
for it — join them, percent-encode each path segment, done. Encode per
segment rather than the whole string: `~/My Notes` is an ordinary vault, and
`encodeURI` would leave a `#` in a filename to truncate the link.

## Swapping one out

That indirection is the whole point. Put your own `ppr-reminders-push` earlier
on `PATH` and `--push` means Todoist, or Things, or a text message. ppr does not
change, its config does not grow a key, and there is no registry to be listed
in. It is `$EDITOR`, and `git foo` → `git-foo`, applied to delivery.

## Writing your own, in any language

A consumer needs to read stdin and exit. That is the entire interface.

```sh
#!/bin/sh
# ppr-say — a hook on entry.created that reads new notes out loud.
jq -r 'select(.entry.kind == "log") | .entry.body' | xargs -0 -r say
```

```python
#!/usr/bin/env python3
# ppr-standup — a subcommand: `ppr standup` runs this.
import json, os, subprocess
ctx = subprocess.run(["ppr", "context", "--json"], capture_output=True, text=True)
print(json.loads(ctx.stdout)["upcoming"])
```

What you are handed:

| | |
| --- | --- |
| stdin | the event as JSON (hooks), or ppr's output (pipes) |
| `PPR_EVENT` | the event name, e.g. `entry.created` |
| `PPR_VAULT` | absolute path of the vault it happened in |
| `ppr … --json` | anything else you want to know |
| `ppr config get plugins.<you>.<key>` | your own settings |

The rules that make a consumer well-behaved, all of them learned from ppr
holding to them itself:

- **Print nothing on stdout.** Your chatter must not end up inside someone's
  `ppr ls --json`. One line on stderr is the budget.
- **Exit 0 when the event was not yours.** A hook on `entry.created` is handed
  every log, note, and clip. Filtering is your job, silently.
- **Exit 0 where you cannot work.** `ppr-notify` on Linux prints one line and
  exits 0, because a courier that cannot deliver must not turn somebody's
  capture red. Exit non-zero only when you were asked to do something you
  could have done and failed.
- **Be quick, or detach.** ppr waits about two seconds at the end of a command
  and then stops waiting. It will not kill you; it will just stop caring.
- **Never write back into the vault.** One-way is what keeps the markdown the
  only owner of a row (I1). If you want to record something, that is
  `ppr write`, as a person would.

## What is in here

| | |
| --- | --- |
| `applescript.js` | pure builders: escaping, date assembly, error hints |
| `osascript.js` | the three lines that shell out, plus stdin reading |
| `ppr-notify` | the read composer |
| `ppr-reminders-push` | the write consumer |
| `test/` | the builders and the event filter, run by `pnpm test` |

Plain CommonJS with no dependencies and no build step, so a plugin runs under
whatever node is on the machine, from wherever it was installed. The
AppleScript escaping and the component-by-component date assembly each fixed a
real bug and each have the comment explaining why; there is exactly one copy of
them, here, and ppr keeps none.

Nothing in `test/` runs `osascript`. A test suite that posts notifications or
files reminders leaves litter in a real person's list.

## Installing

`./scripts/install.sh` puts these on `PATH` next to `ppr` itself. To skip them:
`./scripts/install.sh --no-plugins`.
