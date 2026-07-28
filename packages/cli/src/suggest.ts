/**
 * Optimal string alignment distance — Levenshtein plus transposition.
 *
 * Transposition matters more than it sounds. Real typos are overwhelmingly two
 * adjacent letters swapped: `lsit`, `serach`, `setpu`. Plain Levenshtein scores
 * those as 2, the same as genuinely different words like `redis` and `edit`, so
 * any threshold loose enough to catch the typos also catches ordinary English.
 * Counting a swap as one edit separates them cleanly.
 */
function distance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      }
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

/** Anything shorter is too small to tell a typo from a word. */
const MIN_LENGTH = 3;

/**
 * The command a mistyped word was probably meant to be, or nothing.
 *
 * Deliberately reluctant: a wrong suggestion turns a legitimate note into an
 * error, so it only fires on one edit for short words and two for long ones.
 * "redis", "lunch", and "had" are all left alone.
 */
export function suggest(input: string, candidates: string[]): string | undefined {
  const word = input.toLowerCase();
  if (word.length < MIN_LENGTH) return undefined;

  let best: { name: string; score: number } | undefined;
  for (const candidate of candidates) {
    const name = candidate.toLowerCase();
    const limit = Math.max(word.length, name.length) >= 6 ? 2 : 1;
    const score = distance(word, name);
    if (score <= limit && (!best || score < best.score)) best = { name: candidate, score };
  }
  return best?.name;
}
