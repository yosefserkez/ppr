# ppr

The command line for [ppr](https://github.com/yosefserkez/ppr): notes, logs, and
brain dumps kept as plain markdown files on disk, one file per entry, with
search, linking, and optional AI on top. Every command speaks `--json`, reads
stdin, and returns a meaningful exit code, so it sits inside a pipeline rather
than at the end of one. Delete ppr tomorrow and your notes are exactly as
readable as they are today.

This package is the terminal front-end; the engine it drives is
[`@ppr/core`](https://github.com/yosefserkez/ppr/tree/main/packages/core).
Install it, what it can do, and how to build on it are all in the
[repository README](https://github.com/yosefserkez/ppr#readme).

```bash
npm install -g ppr
ppr setup
```
