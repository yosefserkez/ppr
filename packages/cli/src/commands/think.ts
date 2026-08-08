import { Command } from 'commander';
import { PprError, relativeAge, truncate } from '@ppr/core';
import { filterFlags, globals, toQuery, withVault, type FilterFlags } from '../context.js';
import { hasStdin, readStdin, resolveText } from '../input.js';
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

        if (g.json) return json({ ...result, used: result.used.map(entryJson) });

        out(shortenCitations(result.text));
        if (flags.sources || !result.ai) {
          out(`\n${color.bold('Sources')}`);
          for (const entry of result.used.slice(0, 10)) {
            out(
              `  ${color.dim(shortId(entry.id))}  ${truncate(entry.title, 56)}  ${color.dim(relativeAge(new Date(entry.created), now))}`,
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
    .description('durable facts distilled out of your entries');

  cmd
    .command('ls', { isDefault: true })
    .description('list memories')
    .option('-n, --limit <n>', 'maximum memories')
    .action(async (flags: { limit?: string }, self: Command) =>
      withVault(self, async (vault) => {
        const memories = vault.list({
          kind: 'memory',
          ...(flags.limit ? { limit: Number(flags.limit) } : {}),
        });
        const g = globals(self);
        if (g.json) return json(memories.map(entryJson));
        if (!memories.length) {
          return void out(color.dim('No memories yet. Try `ppr memory learn latest`.'));
        }
        for (const entry of memories) {
          out(`${color.dim(shortId(entry.id))}  ${entry.body.split('\n')[0]}`);
        }
      }),
    );

  cmd
    .command('add')
    .description('record a memory directly')
    .argument('[text...]', 'the fact to remember')
    .action(async (text: string[], _flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        const body = await resolveText(text);
        if (!body) throw new PprError('EINVALID', 'Nothing to remember');
        const entry = await vault.add({ body, kind: 'memory', title: truncate(body, 70) });
        if (globals(self).json) json(entryJson(entry));
        else errline(`${color.green('✓')} ${color.dim(shortId(entry.id))} ${entry.title}`);
      }),
    );

  cmd
    .command('learn')
    .description('extract durable facts from an entry (or piped text) and store them')
    .argument('[ref...]', 'entry refs; defaults to the latest entry')
    .action(async (refs: string[], _flags: unknown, self: Command) =>
      withVault(self, async (vault) => {
        if (!vault.hasAI) {
          throw new PprError(
            'ENOAI',
            'Extracting memories needs a model',
            'Run `ppr ai setup`, or add them by hand with `ppr memory add`.',
          );
        }
        const piped = hasStdin() ? (await readStdin()).trim() : '';
        // Learning from a memory would only ever re-derive the fact it already
        // is. `latest` no longer resolves to one, but an explicit ref still can.
        const sources = piped ? [] : (refs.length ? refs : ['latest']).map((r) => vault.get(r));
        const usable = sources.filter((e) => e.kind !== 'memory');
        if (sources.length && !usable.length) {
          throw new PprError(
            'EINVALID',
            'That is already a memory',
            'Point `learn` at an entry you wrote — or edit the fact directly with `ppr edit`.',
          );
        }
        const created = await vault.remember(piped || usable.map((e) => e.body).join('\n\n'));
        const g = globals(self);
        if (g.json) return json(created.map(entryJson));
        if (!created.length) return void out(color.dim('Nothing durable in there.'));
        for (const entry of created) out(`${color.green('+')} ${entry.body.split('\n')[0]}`);
      }),
    );

  return cmd;
}
