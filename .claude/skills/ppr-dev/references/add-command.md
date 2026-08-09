# Adding or changing a command

## Where it goes

| File | Holds |
| --- | --- |
| `commands/capture.ts` | Anything that creates entries: write, dump, clip, voice, append, remind, todo, done, rm |
| `commands/browse.ts` | Anything that reads them: ls, todos, search, show, edit, tags, links, path, stats, export |
| `commands/think.ts` | What ppr does with entries: recap, thread, brief, ask, context, memory |
| `commands/schedule.ts` | Putting a ppr command on the OS scheduler |
| `commands/settings.ts` | init, config, ai, doctor, reindex |
| `commands/hooks.ts` | Registering an event → command, in the user config layer |
| `commands/plugins.ts` | Reporting what is wired to ppr: hooks, intents, `ppr-*`, settings |

A genuinely new category earns a new file. Five commands in the wrong file is
worse than one more file.

## The shape

```ts
export function thingCommand(): Command {
  const cmd = new Command('thing')
    .alias('t')
    .description('lowercase, no trailing period, says what it does')
    .argument('[ref]', 'entry id, `latest`, or a title fragment', 'latest')
    .option('--flag', 'what it changes');

  // filterFlags(cmd) if it lists entries — one definition, shared by every list command
  cmd.action(async (ref: string, flags: { flag?: boolean }, self: Command) =>
    withVault(self, async (vault) => {
      const g = globals(self);           // never cmd.optsWithGlobals()
      const entry = vault.get(ref);      // throws a good error for bad refs

      if (g.json) return json(entryJson(entry));
      if (g.quiet) return out(entry.id);
      out(entryDetail(entry, vault.now()));
    }),
  );
  return cmd;
}
```

Register it in `cli/src/index.ts` next to its siblings.

## Rules that are easy to miss

**`globals()`, not `optsWithGlobals()`.** Global flags are hoisted out of argv
before commander parses, so `ppr ls --json` and `ppr --json ls` behave the same.
Commander's own view of them is empty by design.

**`withVault()` always.** It applies `--vault` and `--no-ai`, sets up colour, and
flushes the parse cache on the way out. A command that opens a vault itself will
quietly ignore those flags.

**Handle `--json` and `-q` first.** Before any human-readable output, before any
progress message. `-q` means ids only, one per line, for piping.

**Progress goes to stderr.** `errline()`, not `out()`. `ppr clip <url>` prints
"Fetching…" to stderr precisely so `--json` stays parseable.

**Adding a global flag** means two edits: `hoistGlobals()` in `context.ts` so it
works in any position, and `program.option()` in `index.ts` so it appears in
`--help`. Check the name does not already mean something to a subcommand — see
lesson L9 in AGENTS.md.

**If your command writes anything outside `Storage`, handle `--dry-run`.**
Everything that goes through the vault is covered for free: `withVault` wraps
the Storage port in a recorder, and `runChild` records instead of spawning. The
exceptions are the commands that write a config file, a plist, or a directory —
`init`, `config set`, `hooks add/rm`, `schedule add/rm`. Each calls `would(…)`
from `dryrun.ts` with the *artifact* it would have produced (the config delta,
the plist path and its calendar entry) and then returns without writing.

A command that downloads or installs calls `refuseDryRun()` instead: there is no
honest preview of an install. `ppr doctor` is the dry run for `ppr setup`. So
does `ppr edit`, from the other direction — its editor opens the entry itself
(L8), so saving *is* the write and there is no seam left to hold it back.

Three things a dry run must never fake, because faking them makes the preview
worthless: the model still runs, `$EDITOR` still opens, and an error is still an
error with its exit code. The second is why `ppr edit` refuses rather than
previewing: composing is not an effect and saving is, and there they are the
same act.

## Errors

```ts
throw new PprError('EINVALID', `Not a URL: ${url}`);
throw new PprError('ENOAI', 'Extracting facts needs a model', 'Run `ppr ai setup`.');
```

Codes map to exit codes in `index.ts`: `EINVALID` 2, `ENOTFOUND`/`EAMBIGUOUS` 3,
`ENOVAULT`/`ENOAI`/`ECONFIG` 4, `EAI`/`ENETWORK` 5, `EEXTERNAL` 6.

## Test it

In `packages/cli/test/cli.test.js`, using the `ppr(dir, args)` harness — it spawns
the real binary against a temp vault with `PPR_NO_AI=1` and a redirected
`XDG_CONFIG_HOME`, so tests can never touch the developer's own setup.

```js
test('thing does the thing', async () => {
  await withVault(async (dir) => {
    await ppr(dir, ['some entry']);
    const { code, stdout } = await ppr(dir, ['thing', '--json']);
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).length, 1);
  });
});
```

Pass `{ input: '…' }` to send stdin, `{ editor: '/path/to/script' }` to stand in
for `$EDITOR`. Assert exit codes for failure paths — they are part of the contract.

The harness sets `PPR_NO_AI=1`, so what a CLI test exercises is the offline path.
If your command only makes sense with a model, the model-shaped half belongs in
`core/test/ai.test.js` against a scripted provider.

**A numeric flag that is not `filterFlags()`' own parses itself, and must refuse
what it cannot read.** `Number('abc')` is NaN, and NaN is a silent "no limit" to
a slice and "no window" to a filter — a typo made `ppr memory ls --limit abc`
report an empty fact store.
