/**
 * Core domain types. Everything here is plain data so it can cross any
 * boundary — Node, React Native, a browser worker, or a JSON wire format.
 */

/** Well-known entry kinds. Any string is allowed; these are the ones ppr ships with. */
export const KINDS = ['log', 'note', 'dump', 'clip', 'voice', 'memory'] as const;
export type Kind = (typeof KINDS)[number] | (string & {});

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
