import type { Vault } from '@ppr/core';
import { formatTime, truncate } from '@ppr/core';
import { color, out, table } from './render.js';

/**
 * What a bare `ppr` shows.
 *
 * It used to open a capture prompt, which meant the most likely way to run ppr
 * by accident was also a way to create an entry by accident. A read-only
 * summary is the safer default and answers a better question — what have I
 * written today — while naming the commands that do something.
 */
export function overview(vault: Vault): void {
  const now = vault.now();
  const stats = vault.stats();
  const today = vault.list({ since: startOfToday(now), all: true, order: 'asc' } as never);

  if (!stats.entries) {
    out(color.bold('ppr') + color.dim(`  ${vault.root}`));
    out('');
    out(color.dim('Nothing written yet.'));
    out('');
    out(
      table([
        ['ppr "first note"', color.dim('log something')],
        ['ppr write', color.dim('a longer entry, with follow-up questions')],
        ['ppr setup', color.dim('configure AI and voice')],
      ]),
    );
    return;
  }

  out(
    color.bold('ppr') +
      color.dim(`  ${vault.root}  ·  ${stats.entries} entries  ·  ${today.length} today`),
  );

  if (today.length) {
    out('');
    for (const entry of today.slice(-6)) {
      out(`  ${color.dim(formatTime(new Date(entry.created)))}  ${truncate(entry.title, 66)}`);
    }
  }

  out('');
  out(
    table([
      ['ppr "text"', color.dim('log something')],
      ['ppr ls', color.dim('browse your entries')],
      ['ppr dump', color.dim('brain dump, cleaned up')],
      ['ppr --help', color.dim('everything else')],
    ]),
  );
}

const startOfToday = (now: Date): Date =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate());
