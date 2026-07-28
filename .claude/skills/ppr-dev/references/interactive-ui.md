# Adding or changing an interactive terminal view

## The shape, and why it is not negotiable

```
ui/state.ts     pure reducer: (state, key, deps) -> { state, effect }
ui/layout.ts    pure rendering: (state, size, now) -> string[]
ui/screen.ts    the only file that touches the TTY
ui/browser.ts   the shell: owns the loop, executes effects against the vault
```

The reducer returns an `Effect` describing what it wants done — `edit`, `delete`,
`append`, `create`, `yank`, `reload`, `quit` — and the shell performs it. Nothing
in the reducer imports the vault, the clock, or Node.

This is what makes the interesting behaviour testable: `cli/test/state.test.js`
covers cursor clamping, scroll windowing, the view stack, filter mode, the confirm
flow, and ctrl-c from every mode, in milliseconds and with no pseudo-terminal.

**If logic cannot be tested without a terminal, it is in the wrong file.**

## Non-negotiables for any interactive surface

**Gate on a TTY, both ends.** `Screen.usable()` requires stdin *and* stdout to be
a terminal. `canBrowse()` additionally refuses when `--json`, `--quiet`, or
`--plain` is set. The non-interactive path must produce exactly what it produced
before the view existed (invariant I4) — `cli/test/cli.test.js` asserts no
alt-screen sequence ever reaches a pipe.

**Restore the terminal on every exit.** Raw mode, the alternate screen, and the
cursor are undone in `Screen.close()`, which is wired to `exit`, `SIGINT`, and
`SIGTERM`. Anything that spawns a subprocess taking over the screen goes through
`screen.suspend()`, which leaves and re-enters cleanly (invariant I5).

**Never truncate a string containing ANSI codes.** Build rows from styled segments
and measure width on the visible text:

```ts
type Segment = [text: string, style?: (s: string) => string];
row([['▌ ', color.cyan], [entry.title, color.bold], [tags, color.dim]], width);
```

`row()` clips on plain length and applies colour after. Slicing a pre-coloured
string is how a terminal ends up with a stuck highlight (lesson L3).

**One write per frame.** Build the whole frame, then write it with cursor-home and
erase-to-end-of-line per row. Clearing the screen first flickers.

## Adding a mode

Modes are a discriminated union on `state.mode`. To add one:

1. Add its variant to `Mode` in `state.ts`.
2. Add a `reduceYourMode()` and dispatch to it from `reduce()`.
3. Handle `escape` (back out one layer) and `ctrl-c` (quit) — every mode must
   honour both. There is a test asserting ctrl-c works from all of them.
4. Add rendering in `layout.ts` and a footer hint in `HINTS`.
5. Test the reducer.

Watch the interaction between typed text and single-key commands: in filter and
prompt modes, letters must reach the buffer, not trigger `q`/`d`/`x`. That
distinction lives entirely in the mode's reducer.

## Verifying real rendering

The reducer tests cover logic; to see actual frames, drive the built binary
through a pseudo-terminal. `script` needs a controlling terminal and will fail in
a sandbox — Python's `pty` module does not:

```python
primary, secondary = pty.openpty()
fcntl.ioctl(secondary, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
proc = subprocess.Popen(["node", BIN, "ls"], stdin=secondary,
                        stdout=secondary, stderr=secondary, close_fds=True)
os.close(secondary)
# write keys with ~0.4s pauses so each frame renders, collecting output
```

Then split the captured output on cursor-home (`ESC[H`), take the last chunk, and
strip escape codes to read the final frame. Check both layouts — the split view
appears at 96 columns and up, stacked below that — and the empty-vault case.

## Prompts versus full-screen views

A full-screen view (the browser) owns the alternate screen. A prompt (picking a
provider, confirming a delete) should render inline, below the cursor, and leave
the transcript intact when it finishes — the user's scrollback is theirs.

Both need raw keypress input, so share that plumbing rather than duplicating it.
Both need a non-TTY fallback that reads a line from stdin, so a script piping an
answer keeps working.

## Deliberately absent: mouse support

Capturing mouse events breaks native text selection in most terminals. In a tool
whose whole point is text you want to copy out, that trade is not worth
click-to-focus. Do not add it without a strong reason.
