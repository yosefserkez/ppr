import type { Vault } from '@ppr/core';
import { countdown, formatTime, MEMORY_KIND, truncate } from '@ppr/core';
import { color, out, table } from './render.js';

/**
 * What a bare `ppr` shows.
 *
 * It used to open a capture prompt, which meant the most likely way to run ppr
 * by accident was also a way to create an entry by accident. A read-only
 * summary is the safer default and answers a better question — what have I
 * written today — while naming the commands that do something.
 *
 * It also answers "what does ppr know", but only once there is something to
 * know: a vault with no facts says nothing about them. An overview is a report
 * on your vault, not a place to advertise features you are not using. Nothing
 * here calls a model or leaves the disk, so it stays instant.
 */
export function overview(vault: Vault): void {
  const now = vault.now();
  const stats = vault.stats();
  const today = vault.list({ since: startOfToday(now), all: true, order: 'asc' } as never);
  const facts = vault.facts().length;
  // `stats.entries` counts every file, facts included. The header is about the
  // journal, and a count that silently folds in the fact store would not add
  // up against the number printed next to it.
  const written = stats.entries - (stats.byKind[MEMORY_KIND] ?? 0);
  // Not gated on there being facts: a reminder is upcoming too, and a vault
  // can hold one without a fact store at all.
  const soonest = vault.upcoming({ withinDays: 30 })[0];
  // The undated ones only. A dated todo is already what `soonest` is about,
  // and counting it in both places would make the two lines disagree about
  // how much is waiting.
  const todos = vault.todos().filter((todo) => todo.days === undefined).length;

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
      color.dim(
        `  ${vault.root}  ·  ${written} ${written === 1 ? 'entry' : 'entries'}  ·  ${today.length} today` +
          (facts ? `  ·  ${facts} ${facts === 1 ? 'fact' : 'facts'}` : '') +
          (todos ? `  ·  ${todos} ${todos === 1 ? 'todo' : 'todos'}` : ''),
      ),
  );

  if (today.length) {
    out('');
    for (const entry of today.slice(-6)) {
      out(`  ${color.dim(formatTime(new Date(entry.created)))}  ${truncate(entry.title, 66)}`);
    }
  }

  // One line, and only the soonest: this is a summary, not a calendar. `ppr
  // brief` is the command that lists them, and it is named below when there
  // is a reason to run it.
  if (soonest) {
    out('');
    out(`  ${truncate(soonest.item.text, 58)} ${color.dim(`— ${countdown(soonest.days)}`)}`);
  }

  out('');
  out(
    table([
      ['ppr "text"', color.dim('log something')],
      ['ppr ls', color.dim('browse your entries')],
      // A count in the header with no command underneath is a dead end, so
      // the third row follows whatever the header just mentioned.
      soonest
        ? ['ppr brief', color.dim('what is coming up')]
        : todos
          ? ['ppr todos', color.dim('what you said you would do')]
          : ['ppr dump', color.dim('brain dump, cleaned up')],
      ['ppr --help', color.dim('everything else')],
    ]),
  );
}

const startOfToday = (now: Date): Date =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate());
