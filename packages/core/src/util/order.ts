/**
 * One answer to "which of these two came first".
 *
 * `created` is stored to the second because it is written to be read, so two
 * entries made in the same second are indistinguishable by it and a sort that
 * stops there orders them however the engine felt like that run (L2). The id
 * carries milliseconds and is monotonic within one, so it is the tiebreak —
 * and this is the only copy of that rule, because seven hand-rolled versions
 * of it is how `ppr thread` and `ppr ls` start disagreeing about the same two
 * entries.
 */

/** Everything an ordering needs. `Entry` satisfies it; so does a fact. */
export interface Created {
  id: string;
  created: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Newest first — a list is read from the top. */
export const byCreatedDesc = (a: Created, b: Created): number =>
  a.created === b.created ? cmp(b.id, a.id) : cmp(b.created, a.created);

/** Oldest first — a thread is read forwards. */
export const byCreatedAsc = (a: Created, b: Created): number => byCreatedDesc(b, a);
