# Adding a check

Anything that can be wrong with a user's setup belongs in
`cli/src/setup/checks.ts`. One registry, three renderings:

- `ppr doctor` — the report
- `ppr doctor --fix` / `ppr setup` — the guided repair
- `--json` — the same list as data, with the command that fixes each item

A wizard that knew things the doctor did not would drift within a month, so
resist adding setup logic anywhere else.

## The shape

```ts
const thingCheck: Check = {
  id: 'voice.model',            // dotted, groups with its siblings
  label: 'Speech model',
  guided: true,                 // part of the main walkthrough even when fine
  applies: (ctx) => ctx.config.transcribe.provider === 'whisper-cpp',
  async inspect(ctx) {
    return exists ? ok(detail) : missing(detail, 'ppr config set transcribe.model <path>');
  },
  async repair(ctx) {
    // Prompt, download, install — then persist and report the plain command.
    await writeSetting(ctx.root, 'transcribe.model', path);
    out(color.dim(`  → ppr config set transcribe.model ${path}`));
    await ctx.reload();
    return true;               // true = something changed
  },
};
```

Register it in `CHECKS`, in the order a person would meet it.

## Rules

**Every failure carries its fix command.** `missing()` and `warn()` take a
second argument for a reason: it is what an agent reads out of `--json`, and
what a user copies. A check that can fail without one is unfinished.

**`applies` beats reporting a pass.** A whisper model check has no business
appearing when the backend is `openai`. Irrelevant checks are skipped entirely,
which is also how the walkthrough grows as choices unlock steps.

**Repairs print the plain command.** Every `→ ppr config set …` line teaches the
scriptable path. The guided flow is a convenience, never the only way in.

**A repair runs only after consent — so honour it.** Do not guard a repair with
"already configured, nothing to do". Answering *yes* to "Change it?" and being
told "already have it" is the bug that guard causes. Decide whether to *offer*
the step in `inspect`; once `repair` is called, do the thing. Return `false`
only when the user backed out inside the repair itself.

**Preselect the current value.** A picker reopened to change a setting should
start on what is already chosen, not on the global default.

**Ask before installing or downloading.** Show the exact command or the size in
megabytes first. `offerInstall()` refuses when the tool itself is missing and
prints the install line instead of failing.

**Call `ctx.reload()` after writing config**, so later checks see the new state.
If a repair moves the vault, call `ctx.useRoot()` — everything downstream reads
config from there.

## Writing settings

Never write config files directly. `writeSetting(root, key, value, { local })`
validates, coerces types, and persists only the delta — the same path
`ppr config set` takes, so a guided change and a typed one cannot diverge.
