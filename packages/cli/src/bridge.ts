/**
 * What ppr hands to macOS, and when.
 *
 * `@ppr/core/node` owns *how* — the AppleScript, the escaping, the errors.
 * This owns the policy: which of a brief's items survives a notification, and
 * whether a reminder is allowed out of the vault at all. Same shape as
 * `schedule.ts`: the decisions are pure functions, the executors around them
 * are three lines each, and nothing here needs a Mac to be tested.
 *
 * The line the bridge holds: everything is one-way and fire-and-forget, and
 * the vault write always happens first. A failure costs a banner, never an
 * entry.
 */

import { countdown, formatDay, truncate, type Entry, type Upcoming } from '@ppr/core';
import { notify, pushReminder } from '@ppr/core/node';
import { color, errline, shortId } from './render.js';

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
  const result = await notify(banner.title, banner.body);
  if (!result.ok) errline(color.dim(`No notification — ${result.hint}`));
}

/** Why a reminder was or was not handed over. */
export type PushDecision =
  | { push: true }
  | { push: false; reason: 'refused' | 'off' | 'undated' | 'unsupported' };

/**
 * Whether this reminder goes to Reminders.app.
 *
 * Pure, and the only place that decides — so `ppr remind` and the quoted
 * `ppr "remind me …"` form cannot answer differently (L18): both reach it
 * through one call in `remind()`.
 *
 * The order is what the reasons mean. `--no-push` is an instruction and wins
 * outright. A line with no readable day is never pushed however loudly it was
 * asked for, because the entry became an ordinary log and there is nothing for
 * Reminders to ring about. Only then does the platform matter, which is what
 * keeps `--push` on Linux an explanation rather than a silence.
 */
export function pushDecision(opts: {
  /** `remind.push` in config. */
  configured: boolean;
  /** `--push` / `--no-push`, undefined when neither was typed. */
  asked?: boolean;
  /** Whether a day was found, so the entry is a reminder and not a log. */
  dated: boolean;
  platform?: string;
}): PushDecision {
  if (opts.asked === false) return { push: false, reason: 'refused' };
  if (!opts.asked && !opts.configured) return { push: false, reason: 'off' };
  if (!opts.dated) return { push: false, reason: 'undated' };
  if ((opts.platform ?? process.platform) !== 'darwin') return { push: false, reason: 'unsupported' };
  return { push: true };
}

/**
 * Hands a saved reminder to Reminders.app.
 *
 * Called *after* the write, and it cannot undo one: whatever happens here, the
 * markdown is on disk and the entry stands. One dim line either way, because a
 * copy that went somewhere else is worth a word and a bridge that failed is
 * worth a hint — and neither is worth an exit code.
 */
export async function handToReminders(
  entry: Entry,
  date: string | undefined,
  decision: PushDecision,
): Promise<void> {
  if (!decision.push || !date) {
    // The other reasons are already obvious from what the user typed; this one
    // is not, and an explicit `--push` deserves an answer.
    if (!decision.push && decision.reason === 'unsupported') {
      errline(color.dim('  Reminders.app is macOS only — the entry is in your vault.'));
    }
    return;
  }
  const result = await pushReminder({
    title: entry.body,
    date,
    // The short id is the whole of the trace back. It is the only thing ppr
    // writes into someone else's app, and it is what lets `ppr show 6jc6ad`
    // answer "where did this come from".
    note: `ppr ${shortId(entry.id)}`,
  });
  errline(
    result.ok
      ? color.dim('  → Reminders.app')
      : color.dim(`  → Reminders.app declined — ${result.hint}`),
  );
}
