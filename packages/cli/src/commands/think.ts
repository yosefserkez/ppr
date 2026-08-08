import { Command } from 'commander';
import {
  formatDay,
  heuristicBrief,
  parseWhen,
  PprError,
  relativeAge,
  toFact,
  truncate,
  type Entry,
  type Fact,
  type LearnResult,
  type UpcomingFact,
  type VaultContext,
} from '@ppr/core';
import { filterFlags, globals, toQuery, withVault, type FilterFlags } from '../context.js';
import { hasStdin, readStdin, resolveText } from '../input.js';
import { select } from '../ui/select.js';
import { color, entryJson, json, out, errline, shortenCitations, shortId } from '../render.js';

type RecapStyle = 'standup' | 'weekly' | 'narrative';

/** `ppr recap` — what happened, in the shape you need it. */
export function recapCommand(): Command {
  const cmd = new Command('recap')
    .description('summarise a period from your entries')
    .option('--style <style>', 'standup | weekly | narrative', 'standup')
    .option('--save', 'save the recap as an entry');

  filterFlags(cmd).action(
    async (flags: FilterFlags & { style?: RecapStyle; save?: boolean }, self: Command) =>
      withVault(self, async (vault) => {
        const now = vault.now();
        const query = toQuery({ ...flags, since: flags.since ?? '7d', all: true }, 0, now);
        const entries = vault.list(query);
        const g = globals(self);

        if (!entries.length) {
          if (g.json) return json({ text: '', entries: 0, ai: false });
          return void out(color.dim('Nothing in that window.'));
        }
        if (!vault.hasAI && !g.json) errline(color.dim('No AI configured — listing entries instead.'));

        const result = await vault.recap(entries, { style: flags.style ?? 'standup' });
        if (g.json) return json({ ...result, entries: entries.length, ids: entries.map((e) => e.id) });

        out(result.text);
        if (flags.save) {
          const entry = await vault.add({
            body: result.text,
            kind: 'note',
            title: `Recap — ${flags.style ?? 'standup'}`,
            tags: ['recap'],
          });
          errline(`\n${color.green('✓')} saved as ${color.dim(shortId(entry.id))}`);
        }
      }),
  );
  return cmd;
}

/**
 * `ppr brief` — what is about to come round.
 *
 * `recap` looks backward at what happened; this looks forward at what is true
 * and nearly due. Which facts qualify is arithmetic over their dates, so this
 * works with no model at all — the model only writes the sentence.
 */
export function briefCommand(): Command {
  return new Command('brief')
    .description('what is coming up, from the facts ppr holds')
    .option('--within <days>', 'how far ahead to look', '30')
    .option('--plain', 'skip the model and print the dates')
    .action(async (flags: { within?: string; plain?: boolean }, self: Command) =>
      withVault(self, async (vault) => {
        const withinDays = Number(flags.within ?? 30);
        if (!Number.isFinite(withinDays)) throw new PprError('EINVALID', '--within must be a number');
        const g = globals(self);

        if (flags.plain || g.json) {
          const items = vault.upcoming({ withinDays });
          if (g.json) {
            return json(
              items.map((item) => ({
                id: item.fact.id,
                text: item.fact.text,
                date: item.date.toISOString().slice(0, 10),
                days: item.days,
                ...(item.ordinal ? { ordinal: item.ordinal } : {}),
                recurs: item.fact.recurs ?? null,
                mentions: item.mentions.map(entryJson),
              })),
            );
          }
          if (!items.length) return void out(color.dim('Nothing coming up.'));
          return void out(heuristicBrief(items.map(briefItem)));
        }

        const result = await vault.brief({ withinDays });
        if (!result.items.length) return void out(color.dim('Nothing coming up.'));
        out(result.text);
        if (!g.quiet && !result.ai && vault.hasAI) {
          errline(color.dim('The model returned nothing usable — these are the dates themselves.'));
        }
      }),
    );
}

const briefItem = (item: UpcomingFact) => ({
  text: item.fact.text,
  days: item.days,
  when: formatDay(item.date),
  mentions: item.mentions.map((e) => e.title),
});

/**
 * `ppr context` — what ppr knows, shaped for another tool's prompt.
 *
 * ppr is the layer things go into; the useful thing it does with them is hand
 * a grounded context to whatever agent you already run, rather than trying to
 * become one. No model runs here, so the output is instant and identical every
 * time — which is what makes it safe to staple onto someone else's prompt.
 *
 *   ppr context "gift for emily" | claude -p "help me pick something"
 */
export function contextCommand(): Command {
  return new Command('context')
    .description('everything ppr knows about something, for piping into another tool')
    .argument('[query...]', 'what it is about; omit for everything')
    .option('-n, --limit <n>', 'entries to include', '12')
    .option('--within <days>', 'how far ahead to look for dated facts', '30')
    .option('--bodies', 'include full entry text, not just titles')
    .action(async (query: string[], flags: { limit?: string; within?: string; bodies?: boolean }, self: Command) =>
      withVault(self, async (vault) => {
        const result = vault.context(query.join(' '), {
          limit: Number(flags.limit ?? 12),
          withinDays: Number(flags.within ?? 30),
        });
        if (globals(self).json) {
          return json({
            ...(result.query ? { query: result.query } : {}),
            now: vault.now().toISOString(),
            facts: result.facts.map(factJson),
            upcoming: result.upcoming.map((u) => ({
              id: u.fact.id,
              text: u.fact.text,
              date: u.date.toISOString().slice(0, 10),
              days: u.days,
            })),
            entries: result.entries.map(entryJson),
          });
        }
        out(renderContext(result, vault.now(), Boolean(flags.bodies)));
      }),
    );
}

/** Markdown, because that is what every model reads best and every human can check. */
function renderContext(result: VaultContext, now: Date, bodies: boolean): string {
  const lines: string[] = [];

  if (result.facts.length) {
    lines.push('## What is known', '');
    for (const fact of result.facts) lines.push(`- ${fact.text}`);
    lines.push('');
  }
  if (result.upcoming.length) {
    lines.push('## Coming up', '');
    for (const item of result.upcoming) {
      const when = item.days === 0 ? 'today' : item.days === 1 ? 'tomorrow' : `in ${item.days} days`;
      lines.push(`- ${item.fact.text} — ${formatDay(item.date)}, ${when}`);
    }
    lines.push('');
  }
  if (result.entries.length) {
    lines.push('## Entries', '');
    for (const entry of result.entries) {
      const age = relativeAge(new Date(entry.created), now);
      lines.push(`### ${entry.title}`, `${shortId(entry.id)} · ${entry.kind} · ${age} ago`, '');
      if (bodies) lines.push(entry.body, '');
    }
  }
  return lines.join('\n').trim() || 'Nothing known yet.';
}

/** `ppr ask` — retrieval always, generation when a model is configured. */
export function askCommand(): Command {
  const cmd = new Command('ask')
    .description('ask a question and get an answer grounded in your entries')
    .argument('<question...>', 'what you want to know')
    .option('--sources', 'list the entries that were used');

  filterFlags(cmd).action(
    async (question: string[], flags: FilterFlags & { sources?: boolean }, self: Command) =>
      withVault(self, async (vault) => {
        const now = vault.now();
        const { limit, ...rest } = toQuery(flags, 12, now);
        const result = await vault.ask(question.join(' '), { ...rest, limit: limit ?? 12 });
        const g = globals(self);

        if (g.json) {
          return json({ ...result, used: result.used.map(entryJson), facts: result.facts.map(entryJson) });
        }

        out(shortenCitations(result.text));
        // With no model the answer *is* the source list, so printing it again
        // underneath would just say everything twice.
        if (flags.sources) {
          out(`\n${color.bold('Sources')}`);
          // Facts first: they are current, and an entry may have been
          // superseded by one of them.
          for (const fact of result.facts.slice(0, 10)) {
            out(`  ${color.dim(shortId(fact.id))}  ${color.yellow('fact')}  ${truncate(firstLine(fact), 60)}`);
          }
          for (const entry of result.used.slice(0, 10)) {
            out(
              `  ${color.dim(shortId(entry.id))}  ${color.dim(entry.kind.padEnd(4).slice(0, 4))}  ${truncate(entry.title, 50)}  ${color.dim(relativeAge(new Date(entry.created), now))}`,
            );
          }
        }
      }),
  );
  return cmd;
}

/** `ppr memory` — the facts worth carrying forward. */
export function memoryCommand(): Command {
  const cmd = new Command('memory')
    .alias('mem')
    .description('standing facts, distilled out of your entries');

  cmd
    .command('ls', { isDefault: true })
    .description('list what ppr knows')
    .option('-n, --limit <n>', 'maximum facts')
    .option('-a, --all', 'include facts that have been superseded')
    .action(async (flags: { limit?: string; all?: boolean }, self: Command) =>
      withVault(self, async (vault) => {
        const found = vault.facts(flags.all ? { includeRetired: true } : {});
        const facts = flags.limit ? found.slice(0, Number(flags.limit)) : found;
        const g = globals(self);

        if (g.json) return json(facts.map(factJson));
        if (g.quiet) return void out(facts.map((f) => f.id).join('\n'));
        if (!facts.length) {
          return void out(color.dim('Nothing known yet. Try `ppr memory learn`.'));
        }
        for (const fact of facts) out(factLine(fact));
        const conflicted = facts.filter((f) => f.conflicts.length).length;
        if (conflicted) {
          errline(color.dim(`\n${conflicted} disagree with something. \`ppr memory review\` to settle them.`));
        }
      }),
    );

  cmd
    .command('add')
    .description('record a fact directly — learn will never overwrite it')
    .argument('[text...]', 'the fact to remember')
    .action(async (text: string[], _flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const body = await resolveText(text);
        if (!body) throw new PprError('EINVALID', 'Nothing to remember');
        const entry = await vault.addFact(body);
        if (globals(self).json) json(entryJson(entry));
        else errline(`${color.green('✓')} ${color.dim(shortId(entry.id))} ${entry.title}`);
      }),
    );

  cmd
    .command('learn')
    .description('read new entries and fold what they say into the fact store')
    .argument('[ref...]', 'specific entries; omit to read everything new')
    .option('-s, --since <when>', 'read entries after this point (7d, today, 2026-07-01)')
    .option('-a, --all', 're-read the whole journal, ignoring where it left off')
    .action(async (refs: string[], flags: { since?: string; all?: boolean }, self: Command) =>
      withVault(self, async (vault) => {
        if (!vault.hasAI) {
          throw new PprError(
            'ENOAI',
            'Extracting facts needs a model',
            'Run `ppr ai setup`, or add them by hand with `ppr memory add`.',
          );
        }
        const g = globals(self);
        const piped = hasStdin() ? (await readStdin()).trim() : '';
        const result = await vault.learn({
          ...(piped ? { text: piped } : {}),
          ...(refs.length || piped ? { entries: refs.map((r) => vault.get(r)) } : {}),
          ...(flags.since ? { since: parseSince(flags.since, vault.now()) } : {}),
          ...(flags.all ? { all: true } : {}),
        });

        if (g.json) {
          return json({
            scanned: result.scanned,
            duplicates: result.duplicates,
            learned: result.learned.map(entryJson),
            refined: result.refined.map(entryJson),
            conflicts: result.conflicts.map((c) => ({ fact: entryJson(c.fact), with: entryJson(c.with) })),
          });
        }

        for (const entry of result.learned) out(`${color.green('+')} ${firstLine(entry)}`);
        for (const entry of result.refined) out(`${color.cyan('~')} ${firstLine(entry)}`);
        for (const { fact, with: other } of result.conflicts) {
          out(`${color.yellow('!')} ${firstLine(fact)}`);
          out(`  ${color.dim(`disagrees with ${shortId(other.id)}: ${firstLine(other)}`)}`);
        }
        if (g.quiet) return;
        errline(color.dim(summarise(result)));
      }),
    );

  cmd
    .command('review')
    .description('settle facts that disagree with each other')
    .action(async (_flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const pairs = vault.conflicts();
        const g = globals(self);

        if (g.json) {
          return json(pairs.map(([a, b]) => ({ a: factJson(a), b: factJson(b) })));
        }
        if (!pairs.length) return void out(color.dim('Nothing to settle.'));

        let settled = 0;
        for (const [a, b] of pairs) {
          // Re-read: settling one pair can retire a fact that appears in the next.
          const current = vault.conflicts().find(([x, y]) => x.id === a.id && y.id === b.id);
          if (!current) continue;

          const choice = await select<Resolution>({
            title: `${color.yellow('!')} These disagree:`,
            choices: [
              { label: truncate(a.text, 60), value: { keep: a.id, drop: b.id } },
              { label: truncate(b.text, 60), value: { keep: b.id, drop: a.id } },
              { label: 'both are true', value: 'both', hint: 'unlink them and keep each' },
              { label: 'decide later', value: 'skip', hint: 'leave the pair flagged' },
            ],
          }).catch(() => null);

          if (!choice || choice.value === 'skip') continue;
          if (choice.value === 'both') {
            await vault.keepBoth(a.id, b.id);
          } else {
            const { kept, retired } = await vault.keepFact(choice.value.keep, choice.value.drop);
            errline(color.dim(`  kept ${shortId(kept.id)}, retired ${shortId(retired.id)}`));
          }
          settled++;
        }
        errline(
          settled
            ? `${color.green('✓')} settled ${settled} of ${pairs.length}`
            : color.dim('Nothing settled.'),
        );
      }),
    );

  cmd
    .command('why')
    .description('show the entries a fact came from')
    .argument('<ref>', 'fact id or a fragment of it')
    .action(async (ref: string, _flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const entry = vault.get(ref);
        if (entry.kind !== 'memory') {
          throw new PprError('EINVALID', `${shortId(entry.id)} is a ${entry.kind}, not a fact`);
        }
        const fact = toFact(entry);
        const sources = vault.sourcesOf(fact);
        const g = globals(self);

        if (g.json) return json({ ...factJson(fact), sources: sources.map(entryJson) });

        out(color.bold(fact.text));
        if (fact.origin === 'manual') return void out(color.dim('\nYou wrote this one yourself.'));
        if (!sources.length) {
          return void out(color.dim('\nNo sources recorded — the entries may have been deleted.'));
        }
        out('');
        const now = vault.now();
        for (const source of sources) {
          out(
            `  ${color.dim(shortId(source.id))}  ${truncate(source.title, 56)}  ${color.dim(relativeAge(new Date(source.created), now))}`,
          );
        }
      }),
    );

  return cmd;
}

/** What `ppr memory review` can do with a disagreeing pair. */
type Resolution = { keep: string; drop: string } | 'both' | 'skip';

const firstLine = (entry: Entry): string => entry.body.split('\n')[0] ?? '';

/** Stable projection of a fact, so scripts can depend on the shape. */
const factJson = (fact: Fact) => ({
  ...entryJson(fact.entry),
  text: fact.text,
  from: fact.from,
  origin: fact.origin,
  status: fact.status,
  ...(fact.conflicts.length ? { conflicts: fact.conflicts } : {}),
  ...(fact.supersededBy ? { supersededBy: fact.supersededBy } : {}),
});

function factLine(fact: Fact): string {
  const mark = fact.status === 'retired' ? color.dim('·') : fact.conflicts.length ? color.yellow('!') : ' ';
  const hand = fact.origin === 'manual' ? color.dim(' (yours)') : '';
  const text = fact.status === 'retired' ? color.dim(fact.text) : fact.text;
  return `${mark} ${color.dim(shortId(fact.id))}  ${text}${hand}`;
}

/** Says what happened even when nothing did — silence reads as a failure. */
function summarise(result: LearnResult): string {
  if (!result.scanned && !result.learned.length) return 'Nothing new to read.';
  const parts = [`read ${result.scanned} ${result.scanned === 1 ? 'entry' : 'entries'}`];
  if (result.learned.length) parts.push(`${result.learned.length} new`);
  if (result.refined.length) parts.push(`${result.refined.length} refined`);
  if (result.conflicts.length) parts.push(`${result.conflicts.length} to settle`);
  if (result.duplicates) parts.push(`${result.duplicates} already known`);
  if (parts.length === 1) parts.push('nothing durable in them');
  const summary = parts.join(' · ');
  if (!result.unreadable) return summary;
  // Not an error: those entries are still queued, and saying so is the
  // difference between "there was nothing there" and "ask me again".
  return `${summary}\n${result.unreadable} the model could not read — they stay queued for the next run.`;
}

function parseSince(when: string, now: Date): Date {
  const since = parseWhen(when, now);
  if (!since) {
    throw new PprError('EINVALID', `Could not understand --since "${when}"`, 'Try: 7d, today, 2026-07-01');
  }
  return since;
}
