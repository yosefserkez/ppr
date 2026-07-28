/** Crockford base32, minus I/L/O/U so ids stay unambiguous when read aloud. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function encodeTime(ms: number, len: number): string {
  let out = '';
  let n = ms;
  for (let i = 0; i < len; i++) {
    out = ALPHABET[n % 32]! + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?<T extends Uint8Array>(a: T): T } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(buf);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

const TAIL_LENGTH = 6;
let lastTime = -1;
let lastTail: number[] = [];

/**
 * The random tail, made monotonic within a millisecond.
 *
 * Two entries written in the same millisecond would otherwise get ids whose
 * order is pure chance, and `ppr show ^2` would pick between them at random.
 * Incrementing instead of re-rolling keeps ids strictly increasing.
 */
function nextTail(time: number): string {
  if (time === lastTime && lastTail.length === TAIL_LENGTH) {
    for (let i = TAIL_LENGTH - 1; i >= 0; i--) {
      if (++lastTail[i]! <= 31) break;
      lastTail[i] = 0;
    }
  } else {
    lastTime = time;
    lastTail = [...randomBytes(TAIL_LENGTH)].map((b) => b % 32);
  }
  return lastTail.map((v) => ALPHABET[v]).join('');
}

/**
 * A ULID-style id: 10 chars of millisecond timestamp then 6 random.
 * Lexicographically sortable, filename-safe, and short enough to type.
 */
export function createId(date: Date = new Date()): string {
  const time = date.getTime();
  return encodeTime(time, 10) + nextTail(time);
}

/**
 * The handle shown to humans: the tail of the id, not the head. The head is a
 * timestamp, so two entries written in the same second would look identical.
 * `Catalog.resolve` accepts this form, so anything printed can be typed back.
 */
export const shortId = (id: string): string => id.slice(-6);

export function isId(value: string): boolean {
  return /^[0-9a-hjkmnp-tv-z]{16}$/.test(value);
}

/** Recovers the creation time embedded in an id. Useful for sorting without a read. */
export function timeFromId(id: string): Date | null {
  if (id.length < 10) return null;
  let n = 0;
  for (const ch of id.slice(0, 10)) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * 32 + v;
  }
  return new Date(n);
}
