import { join } from 'node:path';
import { Command } from 'commander';
import { formatDay, plainText, PprError, relativeAge, truncate } from '@ppr/core';
import { filterFlags, globals, toQuery, withVault, type FilterFlags } from '../context.js';
import { ago, color, entryDetail, entryJson, entryList, json, out, searchList, table, shortId } from '../render.js';
import { spawnEditorOn } from '../input.js';
import { browse, canBrowse } from '../ui/browser.js';
import { Screen } from '../ui/screen.js';

/** `ppr ls` — the default view of the vault. */
export function listCommand(): Command {
  const cmd = new Command('ls')
    .alias('list')
    .description('list entries, newest first')
    .option('-o, --oneline', 'one entry per line, no day headings')
    .option('--ids', 'print ids only (pipe-friendly)')
    .option('-p, --plain', 'print the list instead of opening the browser');

  filterFlags(cmd).action(
    async (flags: FilterFlags & { oneline?: boolean; ids?: boolean; plain?: boolean }, self: Command) =>
      withVault(self, async (vault) => {
        const now = vault.now();
        // `--all` in the browser is implied: scrolling is free, so an arbitrary
        // cut-off would only hide entries the user came to look for.
        const interactive = canBrowse({ ...globals(self), ...flags }, vault.config.display.interactive);
        const entries = vault.list(toQuery(interactive ? { ...flags, all: !flags.limit } : flags, vault.config.display.listLimit, now));
        const g = globals(self);

        if (g.json) return json(entries.map(entryJson));
        if (flags.ids || g.quiet) return out(entries.map((e) => e.id).join('\n'));
        if (flags.oneline) {
          return out(entries.map((e) => `${shortId(e.id)}  ${truncate(e.title, 70)}`).join('\n'));
        }
        if (interactive) return browse(vault, describe(flags) ?? 'all entries', entries);
        out(entryList(entries, now));
      }),
  );
  return cmd;
}

/** A short breadcrumb describing the active filters. */
function describe(flags: FilterFlags): string | null {
  const parts: string[] = [];
  if (flags.kind?.length) parts.push(flags.kind.join('/'));
  if (flags.tag?.length) parts.push(flags.tag.map((t) => `#${t}`).join(' '));
  if (flags.since) parts.push(`since ${flags.since}`);
  if (flags.pinned) parts.push('pinned');
  return parts.length ? parts.join('  ') : null;
}

/** `ppr today` / `ppr week` — the two windows anyone actually asks for. */
export function windowCommands(): Command[] {
  const build = (name: string, since: string, description: string) =>
    new Command(name)
      .description(description)
      .option('--ids', 'print ids only')
      .option('-p, --plain', 'print the list instead of opening the browser')
      .action(async (flags: { ids?: boolean; plain?: boolean }, self: Command) =>
        withVault(self, async (vault) => {
          const now = vault.now();
          const entries = vault.list({ ...toQuery({ since, all: true }, 0, now), order: 'asc' });
          const g = globals(self);
          if (g.json) return json(entries.map(entryJson));
          if (flags.ids || g.quiet) return out(entries.map((e) => e.id).join('\n'));
          if (canBrowse({ ...g, ...flags }, vault.config.display.interactive)) {
            return browse(vault, name, entries);
          }
          out(entryList(entries, now));
        }),
      );

  return [
    build('today', 'today', "everything logged today"),
    build('week', 'this week', 'everything logged this week'),
  ];
}

/** `ppr search` — lexical, instant, offline. */
export function searchCommand(): Command {
  const cmd = new Command('search')
    .alias('find')
    .description('search titles, bodies, and tags')
    .argument('<query...>', 'what to look for')
    .option('-p, --plain', 'print the results instead of opening the browser');

  filterFlags(cmd).action(async (query: string[], flags: FilterFlags & { plain?: boolean }, self: Command) =>
    withVault(self, async (vault) => {
      const now = vault.now();
      const { limit, ...rest } = toQuery(flags, 20, now);
      const text = query.join(' ');
      const hits = vault.search(text, { ...rest, ...(limit ? { limit } : {}) });
      const g = globals(self);

      if (g.json) return json(hits.map((h) => ({ ...entryJson(h.entry), score: h.score, excerpt: h.excerpt })));
      if (g.quiet) return out(hits.map((h) => h.entry.id).join('\n'));
      if (canBrowse({ ...g, ...flags }, vault.config.display.interactive) && hits.length) {
        return browse(vault, `search: ${text}`, hits.map((h) => h.entry));
      }
      out(searchList(hits, now));
    }),
  );
  return cmd;
}

/** `ppr show` — read one entry, with its neighbourhood. */
export function showCommand(): Command {
  return new Command('show')
    .alias('cat')
    .description('show a single entry')
    .argument('[ref]', 'entry id, `latest`, `^2`, or a title fragment', 'latest')
    .option('--raw', 'print the markdown file exactly as stored')
    .option('--body', 'print only the body')
    .option('--related', 'also show related entries and backlinks')
    .action(
      async (ref: string, flags: { raw?: boolean; body?: boolean; related?: boolean }, self: Command) =>
        withVault(self, async (vault) => {
          const entry = vault.get(ref);
          const g = globals(self);

          if (g.json) return json(entryJson(entry));
          if (flags.body) return out(entry.body);
          if (flags.raw) {
            const { readFile } = await import('node:fs/promises');
            return out((await readFile(join(vault.root, entry.path), 'utf8')).trimEnd());
          }

          out(entryDetail(entry, vault.now()));
          if (flags.related) {
            const back = vault.backlinks(entry);
            const near = vault.related(entry, 5);
            if (back.length) {
              out(`\n${color.bold('Linked from')}`);
              for (const e of back) out(`  ${color.dim(shortId(e.id))}  ${e.title}`);
            }
            if (near.length) {
              out(`\n${color.bold('Related')}`);
              for (const r of near) {
                out(`  ${color.dim(shortId(r.entry.id))}  ${truncate(r.entry.title, 50)}  ${color.dim(r.reasons[0] ?? '')}`);
              }
            }
          }
        }),
    );
}

/** `ppr edit` — the escape hatch back to plain files. */
export function editCommand(): Command {
  return new Command('edit')
    .description('open an entry in $EDITOR')
    .argument('[ref]', 'entry id, `latest`, or a title fragment', 'latest')
    .action(async (ref: string, _flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const entry = vault.get(ref);
        const file = join(vault.root, entry.path);
        const { readFile } = await import('node:fs/promises');
        const before = await readFile(file, 'utf8');

        const code = await spawnEditorOn(file);
        if (code !== 0) throw new PprError('EEXTERNAL', `Editor exited with code ${code}`);

        await vault.refresh();
        const next = vault.find(entry.id) ?? entry;
        const g = globals(self);
        if (g.json) return json(entryJson(next));
        const after = await readFile(file, 'utf8');
        out(
          after === before
            ? color.dim('No changes.')
            : `${color.green('✓')} ${color.dim(shortId(next.id))} ${next.title}`,
        );
      }),
    );
}

/** `ppr path` — the composability primitive: `vim $(ppr path latest)`. */
export function pathCommand(): Command {
  return new Command('path')
    .description('print the filesystem path of an entry, or of the vault')
    .argument('[ref]', 'entry id, `latest`, or a title fragment')
    .action(async (ref: string | undefined, _flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        out(ref ? join(vault.root, vault.get(ref).path) : vault.root);
      }),
    );
}

/** `ppr tags` — what the vault is actually about. */
export function tagsCommand(): Command {
  return new Command('tags')
    .description('list tags by frequency')
    .option('-n, --limit <n>', 'maximum tags to show')
    .action(async (flags: { limit?: string }, self: Command) =>
      withVault(self, async (vault) => {
        const all = vault.tags();
        const tags = flags.limit ? all.slice(0, Number(flags.limit)) : all;
        const g = globals(self);
        if (g.json) return json(tags);
        if (g.quiet) return out(tags.map((t) => t.tag).join('\n'));
        if (!tags.length) return out(color.dim('No tags yet.'));
        out(
          table(
            tags.map((t) => [
              color.cyan(`#${t.tag}`),
              `${String(t.count).padStart(4)}  ${color.dim(relativeAge(new Date(t.lastUsed), vault.now()))}`,
            ]),
          ),
        );
      }),
    );
}

/** `ppr links` — the graph around one entry. */
export function linksCommand(): Command {
  return new Command('links')
    .description('show what an entry links to, what links back, and what is related')
    .argument('[ref]', 'entry id, `latest`, or a title fragment', 'latest')
    .action(async (ref: string, _flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const entry = vault.get(ref);
        const forward = vault.forwardLinks(entry);
        const back = vault.backlinks(entry);
        const near = vault.related(entry, 8);

        if (globals(self).json) {
          return json({
            entry: entryJson(entry),
            links: forward.resolved.map(entryJson),
            missing: forward.missing,
            backlinks: back.map(entryJson),
            related: near.map((r) => ({ ...entryJson(r.entry), score: r.score, reasons: r.reasons })),
          });
        }

        out(color.bold(entry.title));
        const section = (label: string, lines: string[]) => {
          out(`\n${color.bold(label)}`);
          out(lines.length ? lines.join('\n') : color.dim('  —'));
        };
        section('Links to', forward.resolved.map((e) => `  ${color.dim(shortId(e.id))}  ${e.title}`));
        if (forward.missing.length) {
          section('Unresolved', forward.missing.map((m) => `  ${color.yellow(`[[${m}]]`)}`));
        }
        section('Linked from', back.map((e) => `  ${color.dim(shortId(e.id))}  ${e.title}`));
        section(
          'Related',
          near.map((r) => `  ${color.dim(shortId(r.entry.id))}  ${truncate(r.entry.title, 48)}  ${color.dim(r.reasons.join(' · '))}`),
        );
      }),
    );
}

/** `ppr stats` — a vault at a glance. */
export function statsCommand(): Command {
  return new Command('stats').description('vault summary').action(async (_flags: unknown, self: Command) =>
    withVault(self, async (vault) => {
      const stats = vault.stats();
      if (globals(self).json) return json({ ...stats, root: vault.root });

      const rows: Array<[string, string]> = [
        ['vault', vault.root],
        ['entries', String(stats.entries)],
        ['words', stats.words.toLocaleString('en-US')],
        ['tags', String(stats.tags)],
        ['links', String(stats.links)],
      ];
      for (const [kind, count] of Object.entries(stats.byKind).sort((a, b) => b[1] - a[1])) {
        rows.push([`  ${kind}`, String(count)]);
      }
      if (stats.firstEntry) rows.push(['first', formatDay(new Date(stats.firstEntry))]);
      if (stats.lastEntry) {
        rows.push(['latest', `${formatDay(new Date(stats.lastEntry))} (${ago(new Date(stats.lastEntry), vault.now())})`]);
      }
      out(table(rows));
    }),
  );
}

/** `ppr export` — leaving is a feature. */
export function exportCommand(): Command {
  const cmd = new Command('export')
    .description('export entries as json, jsonl, or a single markdown file')
    .option('-f, --format <format>', 'json | jsonl | md', 'json');

  filterFlags(cmd).action(async (flags: FilterFlags & { format?: string }, self: Command) =>
    withVault(self, async (vault) => {
      const entries = vault.list(toQuery({ ...flags, all: flags.limit ? false : true }, 0, vault.now()));
      switch (flags.format) {
        case 'jsonl':
          for (const entry of entries) out(JSON.stringify(entryJson(entry)));
          return;
        case 'md':
          out(
            entries
              .map((e) => `# ${e.title}\n\n_${formatDay(new Date(e.created))} · ${e.kind}_\n\n${e.body}`)
              .join('\n\n---\n\n'),
          );
          return;
        default:
          json(entries.map(entryJson));
      }
    }),
  );
  return cmd;
}

/** Body text for piping into other tools. */
export function textCommand(): Command {
  return new Command('text')
    .description('print entry bodies as plain text (for grep, wc, or a model)')
    .argument('[ref...]', 'entry refs; omit for everything matching the filters')
    .action(async (refs: string[], _flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const entries = refs.length ? refs.map((r) => vault.get(r)) : vault.list({ limit: 50 });
        out(entries.map((e) => plainText(e.body)).join('\n\n'));
      }),
    );
}

/** `ppr browse` — the browser on its own, for when list defaults are off. */
export function browseCommand(): Command {
  const cmd = new Command('browse')
    .alias('b')
    .description('open the keyboard browser over your entries');

  filterFlags(cmd).action(async (flags: FilterFlags, self: Command) =>
    withVault(self, async (vault) => {
      const entries = vault.list(toQuery({ ...flags, all: !flags.limit }, 0, vault.now()));
      if (!Screen.usable()) {
        return out(entryList(entries, vault.now()));
      }
      await browse(vault, describe(flags) ?? 'all entries', entries);
    }),
  );
  return cmd;
}
