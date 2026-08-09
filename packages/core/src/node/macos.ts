/**
 * The one-way bridge to macOS.
 *
 * ppr hands things to the operating system; it never becomes one of its apps.
 * Delivery is delegated here exactly the way editing is delegated to $EDITOR
 * and scheduling to launchd: a notification is posted, a reminder is created,
 * and that is the end of the conversation. Nothing is read back, nothing is
 * synced, and the vault is never the place a change from Reminders.app lands.
 * The markdown files stay the source of truth (I1), which they could not be if
 * two systems both owned the same row.
 *
 * That stance is what makes failure cheap. Every caller writes the entry
 * first; a bridge that cannot reach osascript costs a notification and nothing
 * else, so these functions report rather than throw (I2's shape).
 *
 * The split is the one `schedule.ts` uses: the script builders are pure and
 * exhaustively testable, and the executors around them are three lines each.
 * No test in this repo runs osascript.
 */

import { run } from './exec.js';
import { responsibleApp } from './microphone.js';

/** What a bridge call did. A failure is a hint, never an exception. */
export interface BridgeResult {
  ok: boolean;
  /** The next thing the user could do about it. Never a stack trace. */
  hint?: string;
}

const AS_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/**
 * An AppleScript string literal.
 *
 * AppleScript's escaping is its own small language and it is not the shell's:
 * a literal cannot span lines, so a brief full of newlines has to arrive as
 * `\n` rather than as a raw break, and a backslash in someone's note becomes a
 * line continuation if it is left alone. Five characters is the whole of it —
 * anything more elaborate here would be inventing rules AppleScript does not
 * have.
 */
export const applescriptString = (value: string): string =>
  `"${value.replace(/[\\"\n\r\t]/g, (ch) => AS_ESCAPES[ch]!)}"`;

/** A banner. `title` is the line people read; `body` is the two under it. */
export const notifyScript = (title: string, body: string): string =>
  `display notification ${applescriptString(body)} with title ${applescriptString(title)}`;

export interface ReminderPush {
  /** What the reminder says. Becomes the reminder's name. */
  title: string;
  /** `YYYY-MM-DD`. Anything else is ignored — see `reminderScript`. */
  date?: string;
  /** Free text on the reminder. ppr puts the short id here so it traces back. */
  note?: string;
}

/**
 * The hour a pushed reminder alerts at.
 *
 * ppr only ever knows a *day* — `date:` in frontmatter has no time in it, on
 * purpose — but Reminders needs a moment to ring at. Nine in the morning is the
 * one choice that behaves like the thing ppr already does: `ppr brief` is a
 * morning command, and a reminder that fires at midnight has told you about
 * tomorrow while you were asleep. It is deliberately not configurable.
 */
const REMIND_HOUR = 9;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A reminder in the default list.
 *
 * The date is assembled component by component rather than written as a date
 * literal, because an AppleScript date string is parsed in the *user's* locale:
 * `date "10/08/2026"` is August in one region and October in another, and the
 * script that works on the machine it was written on quietly files things a
 * season away on someone else's. Components have no such ambiguity.
 *
 * `set day of d to 1` comes first for the same class of reason: assigning a
 * month to a date currently sitting on the 31st rolls it forward into the next
 * one. Flattening the day makes the order of the remaining assignments stop
 * mattering.
 *
 * No list is chosen. The default list is where a reminder created by hand goes,
 * and a config knob for picking another one is a setting nobody has asked for.
 *
 * A date that is not `YYYY-MM-DD` is dropped rather than guessed at: an undated
 * reminder still sits in the list where its owner will see it, which is more
 * than a mis-parsed one would do.
 */
export function reminderScript(reminder: ReminderPush): string {
  const day = reminder.date ? ISO_DAY.exec(reminder.date) : null;
  const properties = [
    `name:${applescriptString(reminder.title)}`,
    ...(reminder.note ? [`body:${applescriptString(reminder.note)}`] : []),
    ...(day ? ['remind me date:d'] : []),
  ];
  const date = day
    ? [
        '  set d to current date',
        '  set day of d to 1',
        `  set year of d to ${Number(day[1])}`,
        `  set month of d to ${Number(day[2])}`,
        `  set day of d to ${Number(day[3])}`,
        `  set time of d to ${REMIND_HOUR * 3600}`,
      ]
    : [];

  return [
    'tell application "Reminders"',
    ...date,
    `  make new reminder with properties {${properties.join(', ')}}`,
    'end tell',
  ].join('\n');
}

/**
 * What to say when osascript refused.
 *
 * -1743 is macOS declining to let this process drive another app. It arrives
 * as an ordinary script error whose text ("Not authorized to send Apple
 * events") names neither the switch that fixes it nor the app the switch is
 * filed under — and the app is the terminal, not ppr, which is the part nobody
 * guesses. Everything else is passed through as the one line it was.
 */
export function osascriptHint(stderr: string): string {
  if (stderr.includes('-1743')) {
    return `Allow ${responsibleApp()} in System Settings › Privacy & Security › Automation`;
  }
  return stderr.trim().split('\n')[0]?.trim() || 'osascript failed without saying why';
}

async function osascript(script: string, unsupported: string, timeoutMs: number): Promise<BridgeResult> {
  if (process.platform !== 'darwin') return { ok: false, hint: unsupported };
  try {
    const { code, stderr } = await run('osascript', ['-e', script], { timeoutMs });
    return code === 0 ? { ok: true } : { ok: false, hint: osascriptHint(stderr) };
  } catch (err) {
    // A machine with no osascript at all is the same class of outcome as one
    // that refused: the entry is already on disk either way.
    return { ok: false, hint: (err as Error).message };
  }
}

/** Posts a banner. Instant, or it has already failed. */
export const notify = (title: string, body: string): Promise<BridgeResult> =>
  osascript(notifyScript(title, body), 'Notifications are macOS only', 10_000);

/**
 * Creates a reminder in the default list, and forgets about it.
 *
 * The longer timeout is Reminders.app: the first push of a session launches it
 * cold and may wait on iCloud before it answers.
 */
export const pushReminder = (reminder: ReminderPush): Promise<BridgeResult> =>
  osascript(reminderScript(reminder), 'Reminders.app is macOS only', 20_000);
