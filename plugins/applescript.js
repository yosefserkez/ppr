/**
 * Talking to macOS, for the two plugins that do.
 *
 * This used to be `core/src/node/macos.ts`, back when ppr itself knew what a
 * notification was. It does not any more: everything outside the vault is a
 * third-party tool, the operating system included (I13), so the AppleScript
 * lives out here with the programs that run it. There is exactly one copy of
 * it — the escaping and the date assembly below were each a real bug, and two
 * copies would drift apart at the worst possible moment.
 *
 * Nothing here runs anything. The builders are pure so they can be tested on a
 * machine that is not a Mac, and so a test run never posts a notification or
 * leaves a reminder in somebody's list.
 *
 * Plain CommonJS with no dependencies: a plugin has to run under whatever node
 * happens to be on the box, from whatever directory it was installed into.
 */

'use strict';

const AS_ESCAPES = {
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
const applescriptString = (value) => `"${String(value).replace(/[\\"\n\r\t]/g, (ch) => AS_ESCAPES[ch])}"`;

/** A banner. `title` is the line people read; `body` is the two under it. */
const notifyScript = (title, body) =>
  `display notification ${applescriptString(body)} with title ${applescriptString(title)}`;

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
function reminderScript(reminder) {
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
 * The app macOS holds responsible for a terminal process.
 *
 * The same table `core/src/node/microphone.ts` keeps for the microphone
 * prompt, and the same fact about macOS underneath both: permission is
 * attributed to the terminal, not to the program running inside it.
 */
function responsibleApp(env = process.env) {
  const program = env.TERM_PROGRAM || '';
  const known = {
    Apple_Terminal: 'Terminal',
    iTerm: 'iTerm',
    'iTerm.app': 'iTerm',
    ghostty: 'Ghostty',
    WarpTerminal: 'Warp',
    vscode: 'Visual Studio Code',
    Hyper: 'Hyper',
    WezTerm: 'WezTerm',
    kitty: 'kitty',
    alacritty: 'Alacritty',
  };
  return known[program] || program || 'your terminal';
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
function osascriptHint(stderr, env = process.env) {
  if (String(stderr).includes('-1743')) {
    return `Allow ${responsibleApp(env)} in System Settings › Privacy & Security › Automation`;
  }
  return String(stderr).trim().split('\n')[0]?.trim() || 'osascript failed without saying why';
}

module.exports = {
  applescriptString,
  notifyScript,
  osascriptHint,
  reminderScript,
  responsibleApp,
};
