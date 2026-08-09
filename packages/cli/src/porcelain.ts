/**
 * The friendly flags, and the conventional names they resolve to.
 *
 * `ppr brief --notify` and `ppr remind --push` are still here, still spelled
 * the same, and still on by a single boolean in config. What has gone is any
 * idea inside ppr of *how* a notification happens. A flag names an **intent**;
 * a conventional program name on PATH resolves the **tool**:
 *
 *   --notify  ->  ppr-notify              (stdin: the text to show)
 *   --push    ->  ppr-reminders-push      (stdin: the entry.created event)
 *
 * That indirection is the whole feature. Replace `ppr-reminders-push` with a
 * script that talks to Todoist and `--push` means Todoist, with no ppr change,
 * no config schema, and no plugin registry. It is the same trick as `$EDITOR`,
 * `$PAGER`, and `git foo` -> `git-foo`, and ppr ships both programs so the
 * flags work the minute you install it (I13).
 *
 * The hard rules survive the move unchanged, because they were never about
 * macOS:
 *
 * - The vault write happens first and always stands. Everything here runs
 *   after it and cannot undo it — a plugin that is missing, slow, or broken
 *   costs one dim line on stderr and never an exit code (I2's shape).
 * - One-way. Nothing is read back from wherever the copy went, so nothing over
 *   there can write in here, so the markdown stays the only owner of the row
 *   (I1).
 * - Pure decisions, thin executors. What a banner says and whether a reminder
 *   is allowed out of the vault are functions with unit tests; the code around
 *   them is three lines and goes through `runChild`, which is the one way ppr
 *   runs anybody else's program.
 */

import { countdown, formatDay, truncate, vaultEvent, eventJson, type Entry, type Upcoming, type Vault } from '@ppr/core';
import { runChild } from './child.js';
import { findOnPath } from './external.js';
import { color, errline } from './render.js';

/** The read composer: text in, wherever you like it, out. */
export const NOTIFY_PLUGIN = 'ppr-notify';

/** The write consumer: one ppr event in, a copy somewhere else out. */
export const PUSH_PLUGIN = 'ppr-reminders-push';

export interface Notification {
  title: string;
  body: string;
}

/**
 * How much of a title survives a banner.
 *
 * Notifications truncate hard and without ceremony — a title runs to roughly
 * one line and a body to two, at a width nobody controls. So the notification
 * is built from the *items*, not from the brief's prose: a model writing three
 * sentences about a birthday produces something that reads well in a terminal
 * and turns into "Emily's birthday is on 20 Octo…" in a banner.
 */
const TITLE_WIDTH = 54;

/** The `ppr` mark, so a banner attributed to Script Editor is still legible. */
const MARK = 'ppr · ';

/**
 * The soonest thing, and a count of the rest.
 *
 * One item in the title is the whole design. A banner is read in the half
 * second it slides past, and a list of five squeezed into two lines is read as
 * none of them — whereas "call the dentist" plus "3 days overdue" is a thing
 * you act on. The count is there so the notification is not a lie about how
 * much is waiting, and `ppr brief` in a terminal is where the rest lives.
 *
 * Null when nothing is upcoming: see `announceBrief`.
 */
export function briefNotification(items: Upcoming[]): Notification | null {
  const [first, ...rest] = items;
  if (!first) return null;
  return {
    title: MARK + truncate(first.item.text, TITLE_WIDTH - MARK.length),
    body:
      `${formatDay(first.date)} — ${countdown(first.days)}` +
      (rest.length ? ` · ${rest.length} more` : ''),
  };
}

/**
 * Posts the brief, or explains why it did not.
 *
 * Nothing upcoming posts nothing. A daily "Nothing coming up" ping is how a
 * notification channel stops being read, and once it is ignored the one that
 * mattered is ignored with it — so silence is the feature, and stderr says so
 * for anyone reading a scheduled job's log.
 */
export async function announceBrief(items: Upcoming[]): Promise<void> {
  const banner = briefNotification(items);
  if (!banner) return errline(color.dim('Nothing coming up — no notification sent.'));

  const bin = findOnPath(NOTIFY_PLUGIN);
  if (!bin) return errline(color.dim(missing(NOTIFY_PLUGIN)));

  const result = await runChild(bin, { args: ['--title', banner.title], input: banner.body });
  // A plugin that succeeded but had something to say — "not on this platform",
  // most often — has to be heard, or the user is told a banner was posted that
  // never was.
  if (result.said) errline(color.dim(result.said));
  else if (!result.ok) errline(color.dim(`No notification — ${result.hint}`));
}

/** Why a reminder was or was not handed over. */
export type PushDecision =
  | { push: true }
  | { push: false; reason: 'refused' | 'off' | 'undated' | 'unavailable' };

/**
 * Whether this reminder leaves the vault.
 *
 * Pure, and the only place that decides — so `ppr remind` and the quoted
 * `ppr "remind me …"` form cannot answer differently (L18): both reach it
 * through one call in `remind()`.
 *
 * The order is what the reasons mean. `--no-push` is an instruction and wins
 * outright. A line with no readable day is never pushed however loudly it was
 * asked for, because the entry became an ordinary log and there is nothing to
 * ring about. Only then does it matter whether the tool exists — which is what
 * keeps `--push` with no plugin installed an explanation rather than a
 * silence. That last check used to be `platform === 'darwin'`; it is now "is
 * there a program on PATH that does this", which is the same question asked
 * without ppr having to know the answer for every operating system there is.
 */
export function pushDecision(opts: {
  /** `remind.push` in config. */
  configured: boolean;
  /** `--push` / `--no-push`, undefined when neither was typed. */
  asked?: boolean;
  /** Whether a day was found, so the entry is a reminder and not a log. */
  dated: boolean;
  /** Whether the conventional plugin is on PATH. */
  available: boolean;
}): PushDecision {
  if (opts.asked === false) return { push: false, reason: 'refused' };
  if (!opts.asked && !opts.configured) return { push: false, reason: 'off' };
  if (!opts.dated) return { push: false, reason: 'undated' };
  if (!opts.available) return { push: false, reason: 'unavailable' };
  return { push: true };
}

/** Whether `ppr remind --push` has anything to push with. */
export const canPush = (): boolean => findOnPath(PUSH_PLUGIN) !== null;

/**
 * Hands a saved reminder to whatever `ppr-reminders-push` is.
 *
 * Called *after* the write, and it cannot undo one: whatever happens here, the
 * markdown is on disk and the entry stands. What goes down the pipe is the
 * `entry.created` event, in exactly the shape a hook on `entry.created` would
 * receive — so the flag and the hook are two doors into one program, and there
 * is one serializer behind both.
 */
export async function handToReminders(
  vault: Vault,
  entry: Entry,
  decision: PushDecision,
): Promise<void> {
  if (!decision.push) {
    // The other reasons are already obvious from what the user typed; this one
    // is not, and an explicit `--push` deserves an answer.
    if (decision.reason === 'unavailable') {
      errline(color.dim(`  ${missing(PUSH_PLUGIN)} The entry is in your vault.`));
    }
    return;
  }
  const bin = findOnPath(PUSH_PLUGIN);
  if (!bin) return;

  const event = vaultEvent({ event: 'entry.created', entry }, { vault: vault.root, now: vault.now() });
  const result = await runChild(bin, {
    input: `${JSON.stringify(eventJson(event))}\n`,
    env: { PPR_EVENT: event.event, PPR_VAULT: event.vault },
  });
  // Whatever the plugin said, it said with its own name on the front, so it
  // stands on its own — that is the line the user needs when the copy did not
  // happen and the exit code was 0 anyway.
  if (result.said) return errline(color.dim(`  ${result.said}`));
  errline(
    result.ok
      ? color.dim(`  → ${PUSH_PLUGIN}`)
      : color.dim(`  → ${PUSH_PLUGIN} declined — ${result.hint}`),
  );
}

/**
 * What to say when the convention resolves to nothing.
 *
 * Naming the program rather than the platform, because that is the thing the
 * user can act on: write one, install ppr's, or point the name at something
 * else entirely.
 */
export const missing = (plugin: string): string =>
  `Nothing called ${plugin} on your PATH — ppr ships one, or write your own.`;
