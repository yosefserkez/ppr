/**
 * The keyboard vocabulary every interactive surface speaks.
 *
 * Node's keypress events are translated here, once, so reducers never see a
 * Node type and can be tested by handing them plain objects.
 */
export interface Key {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  /** The literal character, when the key produced one. */
  char?: string;
}

export interface NodeReadlineKey {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  sequence?: string;
}

export function normalizeKey(str: string | undefined, key: NodeReadlineKey | undefined): Key {
  const name = key?.name ?? '';
  const sequence = key?.sequence ?? str ?? '';
  const printable = str && str.length === 1 && str >= ' ' && str !== '\x7f' ? str : undefined;

  const out: Key = { name: name || printable || sequence };
  if (key?.ctrl) out.ctrl = true;
  if (key?.shift) out.shift = true;
  if (key?.meta) out.meta = true;
  if (printable) out.char = printable;

  // readline reports uppercase letters as shift+lowercase; reducers want the
  // lowercase name plus the shift flag, so `G` and `g` can differ.
  if (printable && /[A-Z]/.test(printable)) {
    out.name = printable.toLowerCase();
    out.shift = true;
  }
  return out;
}
