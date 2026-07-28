import type { Entry } from './types.js';
import { backlinks, forwardLinks, related } from './links.js';
import { dayKey } from './util/time.js';

/**
 * A named way to move from one entry to a set of others.
 *
 * "Where can I go from here" is a question about the graph, not about the UI,
 * so it lives in core: the CLI's dive menu, `ppr links`, and any future app all
 * ask the same question and get the same answer.
 */
export interface Lens {
  id: string;
  label: string;
  entries: Entry[];
}

const MAX_TAG_LENSES = 5;

/** Only the lenses that lead somewhere — an empty one is a dead end, not a choice. */
export function lenses(all: Entry[], entry: Entry): Lens[] {
  const out: Lens[] = [];
  const add = (id: string, label: string, entries: Entry[]) => {
    if (entries.length) out.push({ id, label, entries });
  };

  add('backlinks', 'Linked from', backlinks(all, entry));
  add('links', 'Links to', forwardLinks(all, entry).resolved);
  add(
    'related',
    'Related',
    related(all, entry, 20).map((r) => r.entry),
  );

  for (const tag of entry.tags.slice(0, MAX_TAG_LENSES)) {
    add(
      `tag:${tag}`,
      `#${tag}`,
      all.filter((e) => e.id !== entry.id && e.tags.includes(tag)),
    );
  }

  const day = dayKey(new Date(entry.created));
  add(
    'day',
    'Same day',
    all.filter((e) => e.id !== entry.id && dayKey(new Date(e.created)) === day),
  );

  return out;
}
