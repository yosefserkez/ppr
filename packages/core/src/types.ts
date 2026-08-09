/**
 * Core domain types. Everything here is plain data so it can cross any
 * boundary — Node, React Native, a browser worker, or a JSON wire format.
 */

/** Well-known entry kinds. Any string is allowed; these are the ones ppr ships with. */
export const KINDS = ['log', 'note', 'dump', 'clip', 'voice', 'memory', 'reminder'] as const;
export type Kind = (typeof KINDS)[number] | (string & {});

/**
 * The one kind that is not a thing that happened.
 *
 * Every other kind is an event: it belongs to the day it was written, and it
 * never changes afterwards. A memory is *state* — "Emily's birthday is 20
 * October" was not true only on the afternoon it was extracted — so it is
 * mutable, undated, and deliberately outside the timeline. Keeping the two in
 * one stream is what made `latest` resolve to a memory and `ppr memory learn`
 * re-read its own output until every run said "nothing durable in there".
 */
export const MEMORY_KIND = 'memory';

/**
 * A future intention, and the one kind that *completes*.
 *
 * The opposite of a memory in every way that matters: you did say "remind me
 * to call the dentist" at the moment you said it, so a reminder belongs to its
 * day and stays in the timeline — `ppr ls` and `ppr today` show it like any
 * other entry, and I12 is untouched. What makes it a reminder is that it
 * carries `extra.date`, so `ppr brief` counts down to it, and `extra.status:
 * done` once it is dealt with. Nothing about it is state: a memory is true
 * until it stops being, a reminder is pending until it is done.
 */
export const REMINDER_KIND = 'reminder';

/** A single markdown file in the vault, parsed. */
export interface Entry {
  /** Sortable, time-prefixed unique id. Also the stable handle used by the CLI. */
  id: string;
  kind: Kind;
  title: string;
  /** ISO-8601 with offset. */
  created: string;
  updated: string;
  tags: string[];
  /** Wikilink targets found in the body, normalized. */
  links: string[];
  /** Where this came from: a URL, a file path, an app name. */
  source?: string;
  pinned?: boolean;
  /** Any frontmatter key ppr does not own, preserved verbatim on write. */
  extra: Record<string, unknown>;
  /** Markdown body, frontmatter stripped, trimmed. */
  body: string;
  /** Vault-relative POSIX path. Derived from id + created; never user-supplied. */
  path: string;
}

/** Fields accepted when creating an entry. Everything optional but the body. */
export interface EntryInput {
  body: string;
  kind?: Kind;
  title?: string;
  tags?: string[];
  source?: string;
  pinned?: boolean;
  created?: Date | string;
  extra?: Record<string, unknown>;
}

/** Fields accepted when updating. Absent keys are left untouched. */
export interface EntryPatch {
  body?: string;
  kind?: Kind;
  title?: string;
  tags?: string[];
  source?: string;
  pinned?: boolean;
  extra?: Record<string, unknown>;
}

export interface ListQuery {
  kind?: Kind | Kind[];
  tag?: string | string[];
  /** Inclusive lower bound on `created`. */
  since?: Date;
  /** Exclusive upper bound on `created`. */
  until?: Date;
  pinned?: boolean;
  limit?: number;
  offset?: number;
  /** Newest first by default. */
  order?: 'asc' | 'desc';
}

export interface SearchHit {
  entry: Entry;
  score: number;
  /** Body excerpt around the strongest match, with no markup. */
  excerpt: string;
}

export interface VaultStats {
  entries: number;
  byKind: Record<string, number>;
  tags: number;
  links: number;
  words: number;
  firstEntry?: string;
  lastEntry?: string;
}
