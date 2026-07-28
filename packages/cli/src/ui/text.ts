/**
 * Width-safe line building.
 *
 * Lines are composed from styled *segments* rather than pre-coloured strings, so
 * width is always measured on the visible text. Slicing a string that already
 * contains escape codes is how a terminal UI ends up with a stuck highlight.
 */
export type Style = (s: string) => string;
export type Segment = [text: string, style?: Style];

/** Clips segments to `width`, styles each piece after clipping, pads the rest. */
export function row(segments: Segment[], width: number): string {
  let used = 0;
  let out = '';
  for (const [text, style] of segments) {
    if (used >= width) break;
    const clipped = text.length > width - used ? text.slice(0, width - used) : text;
    out += style ? style(clipped) : clipped;
    used += clipped.length;
  }
  return out + ' '.repeat(Math.max(0, width - used));
}

export const plain = (text: string, width: number): string => row([[text]], width);

/** Word-wraps to a width, preserving the blank lines between paragraphs. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      out.push('');
      continue;
    }
    let current = '';
    for (const word of line.split(/\s+/)) {
      if (!current) current = word;
      else if (current.length + 1 + word.length <= width) current += ` ${word}`;
      else {
        out.push(current);
        current = word;
      }
      while (current.length > width) {
        out.push(current.slice(0, width));
        current = current.slice(width);
      }
    }
    if (current) out.push(current);
  }
  return out;
}
