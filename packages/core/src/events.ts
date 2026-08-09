/**
 * What ppr says out loud when something changes.
 *
 * This is one half of ppr's whole outward surface. The other half is `--json`,
 * which answers a question somebody asked; this is the half that speaks first,
 * so a thing built on ppr does not have to poll it. A host decides what
 * listening means — the CLI spawns hooks, a mobile app would redraw a view,
 * a test records — which is why this is a port and not a subprocess (I8).
 *
 * Three rules hold the shape:
 *
 * **Writes emit; reads do not.** `ppr ls`, `ppr brief`, `ppr ask`, and
 * `ppr context` are silent, because a read already composes with a pipe:
 * `ppr brief --plain | ppr-notify` needs no event to exist. An event is for
 * the thing nobody was standing there to see.
 *
 * **The names are coarse, and they are forever.** There is no
 * `reminder.created`: that is `entry.created` plus a one-line filter on
 * `kind` in the consumer. A vocabulary that grows a name per kind is a
 * vocabulary that has to be versioned every time a kind is added.
 *
 * **A payload is complete.** Every event carries the whole entry, and both
 * sides of anything that changed, so a consumer never has to call back into
 * ppr to find out what it was just told about. `v` is on every event for the
 * day that stops being true.
 *
 * Two layers are deliberately both present. `entry.*` says what happened to a
 * file; `fact.*` / `conflict.*` / `learn.*` say what it *meant*. Learning a
 * fact emits `entry.created` and `fact.learned`, because "a file appeared" and
 * "the model decided this was durable" are different subscriptions, and only
 * the second knows why.
 */

import { entryJson } from './entry.js';
import type { Entry } from './types.js';

/** Every event name ppr will ever emit at this version. */
export const EVENT_NAMES = [
  'entry.created',
  'entry.updated',
  'entry.removed',
  'entry.completed',
  'fact.learned',
  'fact.refined',
  'conflict.found',
  'learn.finished',
] as const;

export type VaultEventName = (typeof EVENT_NAMES)[number];

export const isEventName = (name: string): name is VaultEventName =>
  (EVENT_NAMES as readonly string[]).includes(name);

/** What every event carries, whatever it is about. */
interface EventBase {
  /** Payload version. Bumped only if a field's meaning changes, never for a new one. */
  v: 1;
  event: VaultEventName;
  /** When, from the vault's clock — ISO-8601 with offset. */
  at: string;
  /** Absolute vault root, so a consumer watching two vaults can tell them apart. */
  vault: string;
}

export interface EntryCreated extends EventBase {
  event: 'entry.created';
  entry: Entry;
}

export interface EntryUpdated extends EventBase {
  event: 'entry.updated';
  entry: Entry;
  /** The entry as it was. A consumer diffing needs both sides, not one. */
  previous: Entry;
}

export interface EntryRemoved extends EventBase {
  event: 'entry.removed';
  /** The entry as it last was on disk. It is gone; this is all there will be. */
  entry: Entry;
}

export interface EntryCompleted extends EventBase {
  event: 'entry.completed';
  entry: Entry;
  previous: Entry;
}

export interface FactLearned extends EventBase {
  event: 'fact.learned';
  entry: Entry;
}

export interface FactRefined extends EventBase {
  event: 'fact.refined';
  entry: Entry;
  previous: Entry;
}

export interface ConflictFound extends EventBase {
  event: 'conflict.found';
  entry: Entry;
  /** The fact it disagrees with. Neither side is settled — that is `ppr memory review`. */
  with: Entry;
}

export interface LearnFinished extends EventBase {
  event: 'learn.finished';
  scanned: number;
  learned: Entry[];
  refined: Entry[];
  conflicts: Array<{ fact: Entry; with: Entry }>;
  duplicates: number;
  /** Entries the model returned nothing usable for. They stay in the window (L21). */
  unreadable: number;
}

export type VaultEvent =
  | EntryCreated
  | EntryUpdated
  | EntryRemoved
  | EntryCompleted
  | FactLearned
  | FactRefined
  | ConflictFound
  | LearnFinished;

/** Where an event came from. Supplied by `Vault`; never guessed by a consumer. */
export interface EventContext {
  vault: string;
  now: Date;
}

/**
 * An event as an emitter states it: everything but the fields the vault knows
 * for itself. A discriminated union, so `{ event: 'entry.updated' }` without a
 * `previous` does not compile.
 */
export type EventInput<E extends VaultEvent = VaultEvent> = E extends VaultEvent
  ? Omit<E, 'v' | 'at' | 'vault'>
  : never;

/**
 * Stamps an event with when and where. One function, so no emitter can forget
 * a field and no two of them can disagree about the version.
 */
export const vaultEvent = (input: EventInput, ctx: EventContext): VaultEvent =>
  ({ v: 1, at: ctx.now.toISOString(), vault: ctx.vault, ...input }) as VaultEvent;

/**
 * An event on the wire.
 *
 * The one serializer, so a hook's stdin and `ppr ls --json` describe an entry
 * the same way. Everything a consumer gets is plain JSON — no dates, no
 * classes, nothing that needs ppr installed to read.
 */
export function eventJson(event: VaultEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { ...event };
  if ('entry' in event) out.entry = entryJson(event.entry);
  if ('previous' in event) out.previous = entryJson(event.previous);
  if ('with' in event) out.with = entryJson(event.with);
  if (event.event === 'learn.finished') {
    out.learned = event.learned.map(entryJson);
    out.refined = event.refined.map(entryJson);
    out.conflicts = event.conflicts.map((pair) => ({
      fact: entryJson(pair.fact),
      with: entryJson(pair.with),
    }));
  }
  return out;
}
