import type { Entry } from '@ppr/core';
import { formatDay, formatTime, plainText, relativeAge, shortId, truncate } from '@ppr/core';
import { color } from '../render.js';
import { currentView, focused, visibleEntries, type BrowserState } from './state.js';
import { plain, row, wrap, type Segment, type Style } from './text.js';
import type { Size } from './screen.js';

/**
 * Frame composition for the full-screen browser. Pure: state in, lines out.
 * Width-safe row building is shared with the inline prompts — see `ui/text.ts`.
 */
const PREVIEW_MIN = 40;
const SIDE_BY_SIDE_AT = 96;
/** The list gets the larger share: titles are what you scan. */
const LIST_SHARE = 0.55;

const KIND_STYLE: Record<string, Style> = {
  log: color.green,
  note: color.cyan,
  dump: color.magenta,
  clip: color.yellow,
  voice: color.magenta,
  memory: color.yellow,
  reminder: color.yellow,
};

/**
 * One row: kind, age, title, tags. No id — in the browser you act on the
 * focused row directly, so the id is only shown in the preview where it is
 * something to copy rather than something to read past.
 */
function entryRow(entry: Entry, width: number, selected: boolean, now: Date): string {
  const segments: Segment[] = [
    [selected ? '▌ ' : '  ', selected ? color.cyan : undefined],
    [entry.kind.padEnd(6).slice(0, 6), KIND_STYLE[entry.kind] ?? color.dim],
    ['  ', undefined],
    [relativeAge(new Date(entry.created), now).padStart(4), color.dim],
    ['  ', undefined],
    [entry.title, selected ? color.bold : undefined],
  ];
  if (entry.tags.length) segments.push([`  ${entry.tags.map((t) => `#${t}`).join(' ')}`, color.dim]);
  return row(segments, width);
}

/** The right-hand (or lower) pane: the focused entry, fitted to the space. */
function previewLines(entry: Entry | undefined, width: number, height: number, now: Date): string[] {
  if (!entry) return [plain('', width)];
  const date = new Date(entry.created);
  const lines: string[] = [];

  for (const line of wrap(entry.title, width)) lines.push(row([[line, color.bold]], width));
  lines.push(
    row(
      [
        [`${shortId(entry.id)}  ·  ${entry.kind}  ·  ${formatDay(date)} ${formatTime(date)}`, color.dim],
      ],
      width,
    ),
  );
  if (entry.tags.length) {
    lines.push(row([[entry.tags.map((t) => `#${t}`).join(' '), color.cyan]], width));
  }
  if (entry.source) lines.push(row([[truncate(entry.source, width), color.dim]], width));
  lines.push(plain('', width));

  for (const line of wrap(entry.body, width)) {
    if (lines.length >= height) break;
    lines.push(plain(line, width));
  }
  // Overflow is intentional: the preview is a glance, `o` opens the full text.
  return lines.slice(0, height);
}

export interface Frame {
  lines: string[];
}

export function render(state: BrowserState, size: Size, now: Date): string[] {
  const { columns, rows } = size;
  const view = currentView(state);
  const entries = visibleEntries(view);
  const entry = focused(state);

  const header = renderHeader(state, columns);
  const footer = renderFooter(state, columns);
  const bodyHeight = Math.max(3, rows - header.length - footer.length);

  if (state.mode.kind === 'reader' && entry) {
    return [...header, ...renderReader(entry, columns, bodyHeight, state.mode.scroll), ...footer];
  }

  const sideBySide = columns >= SIDE_BY_SIDE_AT;
  const listWidth = sideBySide ? Math.max(38, Math.floor(columns * LIST_SHARE)) : columns;
  const listHeight = sideBySide ? bodyHeight : Math.max(3, Math.ceil(bodyHeight * 0.55));

  const listLines: string[] = [];
  const window = entries.slice(view.offset, view.offset + listHeight);
  for (const [i, item] of window.entries()) {
    listLines.push(entryRow(item, listWidth, view.offset + i === view.cursor, now));
  }
  if (!entries.length) {
    listLines.push(row([['  nothing here', color.dim]], listWidth));
  }
  while (listLines.length < listHeight) listLines.push(plain('', listWidth));

  let body: string[];
  if (sideBySide) {
    const previewWidth = columns - listWidth - 3;
    const preview = previewLines(entry, Math.max(PREVIEW_MIN - 4, previewWidth), bodyHeight, now);
    body = [];
    for (let i = 0; i < bodyHeight; i++) {
      body.push(`${listLines[i] ?? plain('', listWidth)} ${color.dim('│')} ${preview[i] ?? ''}`);
    }
  } else {
    const previewHeight = bodyHeight - listHeight - 1;
    body = [
      ...listLines,
      color.dim('─'.repeat(columns)),
      ...previewLines(entry, columns, Math.max(1, previewHeight), now),
    ];
  }

  const overlay = renderOverlay(state, columns, bodyHeight);
  if (overlay) body = mergeOverlay(body, overlay, columns);

  return [...header, ...body.slice(0, bodyHeight), ...footer];
}

function renderHeader(state: BrowserState, width: number): string[] {
  const view = currentView(state);
  const total = visibleEntries(view).length;
  const crumbs = state.stack.map((v) => v.label).join(color.dim(' › '));
  const position = total ? `${view.cursor + 1}/${total}` : '0';

  const left: Segment[] = [['ppr ', color.dim], [crumbs]];
  if (view.filter) left.push([`  /${view.filter}`, color.yellow]);
  const line = row(left, Math.max(0, width - position.length - 1));
  return [`${line} ${color.dim(position)}`, color.dim('─'.repeat(width))];
}

const HINTS: Record<string, string> = {
  list: '↑↓ move   ⏎ edit   o read   d dive   / filter   b back   ? keys   q quit',
  filter: 'type to filter   ⏎ accept   esc clear',
  reader: '↑↓ scroll   ⏎ edit   q back',
  dive: '↑↓ pick   ⏎ open   esc cancel',
  confirm: 'y confirm   any other key cancels',
  prompt: '⏎ save   esc cancel',
  help: 'any key to close',
};

function renderFooter(state: BrowserState, width: number): string[] {
  const hint = HINTS[state.mode.kind] ?? HINTS.list!;
  if (state.mode.kind === 'prompt') {
    return [
      color.dim('─'.repeat(width)),
      row([[`${state.mode.prompt}> `, color.cyan], [state.mode.value], ['▌', color.cyan]], width),
    ];
  }
  if (state.mode.kind === 'confirm') {
    return [color.dim('─'.repeat(width)), row([[`${state.mode.prompt} `, color.yellow], ['(y/n)', color.dim]], width)];
  }
  const status = state.status ? row([[state.status, color.green]], width) : row([[hint, color.dim]], width);
  return [color.dim('─'.repeat(width)), status];
}

function renderReader(entry: Entry, width: number, height: number, scroll: number): string[] {
  const inner = Math.min(width - 2, 100);
  const lines = [
    ...wrap(entry.title, inner).map((l) => row([[l, color.bold]], width)),
    row([[`${shortId(entry.id)}  ·  ${entry.kind}  ·  ${formatDay(new Date(entry.created))}`, color.dim]], width),
    ...(entry.tags.length ? [row([[entry.tags.map((t) => `#${t}`).join(' '), color.cyan]], width)] : []),
    '',
    ...wrap(entry.body, inner).map((l) => plain(l, width)),
  ];
  const maxScroll = Math.max(0, lines.length - height);
  const from = Math.min(scroll, maxScroll);
  const page = lines.slice(from, from + height);
  while (page.length < height) page.push(plain('', width));
  return page;
}

/** Modal panels are drawn over the body rather than replacing the layout. */
function renderOverlay(state: BrowserState, width: number, height: number): string[] | null {
  if (state.mode.kind === 'dive') {
    const { options, cursor } = state.mode;
    const lines = options.map((option, i) =>
      row(
        [
          [i === cursor ? '▌ ' : '  ', i === cursor ? color.cyan : undefined],
          [`${i + 1}  `, color.dim],
          [option.label, i === cursor ? color.bold : undefined],
          [`  ${option.entries.length}`, color.dim],
        ],
        Math.min(56, width - 8) - 2,
      ),
    );
    return panel('dive in', lines, Math.min(56, width - 8), height);
  }

  if (state.mode.kind === 'help') {
    const keys: Array<[string, string]> = [
      ['↑ ↓ j k', 'move'],
      ['g G', 'first / last'],
      ['ctrl-d ctrl-u', 'page'],
      ['⏎ e', 'edit in $EDITOR'],
      ['o →', 'read full entry'],
      ['d tab', 'backlinks, related, tag, day'],
      ['b ←', 'back'],
      ['/', 'filter this list'],
      ['a', 'append a line'],
      ['n', 'new entry'],
      ['x', 'delete'],
      ['y', 'copy path'],
      ['r', 'reload from disk'],
      ['q esc', 'quit'],
    ];
    const inner = Math.min(52, width - 8);
    const lines = keys.map(([k, v]) => row([['  ', undefined], [k.padEnd(15), color.cyan], [v]], inner - 2));
    return panel('keys', lines, inner, height);
  }
  return null;
}

function panel(title: string, lines: string[], width: number, height: number): string[] {
  const rule = (left: string, right: string) =>
    color.dim(left + '─'.repeat(Math.max(0, width - 2)) + right);
  const top = color.dim(`┌ ${title} `) + color.dim('─'.repeat(Math.max(0, width - title.length - 4)) + '┐');
  const body = lines
    .slice(0, Math.max(1, height - 4))
    .map((line) => `${color.dim('│')}${line}${color.dim('│')}`);
  return [top, ...body, rule('└', '┘')];
}

/** Draws a panel over the body, top-left, leaving the rest visible. */
function mergeOverlay(body: string[], overlay: string[], width: number): string[] {
  const out = [...body];
  for (const [i, line] of overlay.entries()) {
    if (i + 1 >= out.length) break;
    out[i + 1] = row([[' ']], 1) + line;
  }
  void width;
  return out;
}
