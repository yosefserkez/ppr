/**
 * Talking to macOS, for the plugins that do.
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
 * The label ppr writes its fields under.
 *
 * Contacts allows several phones and emails per card, each with a label, and
 * that is what makes this safe to run again: the fields ppr wrote are found by
 * this label and replaced, so a hook firing on every learned fact converges on
 * one card instead of stacking up thirty numbers. A number somebody typed in
 * themselves has a different label and is never touched — the whole point of
 * one-way is that the other app keeps what is its.
 */
const CONTACT_LABEL = 'ppr';

/**
 * Contacts' own year for "a birthday with no birth year".
 *
 * ppr writes `0000` for an unknown year; Contacts stores 1604, which is what
 * its UI shows as a birthday with no age attached. Neither is a real year and
 * both mean the same thing, so this is a translation between two conventions
 * rather than a guess — anything from 1000 up is somebody's actual birth year
 * and is passed through untouched.
 */
const NO_BIRTH_YEAR = 1604;

/**
 * A name split the way Contacts stores one: first, and the rest.
 *
 * Contacts has no single "name" field to write — `name` is read-only and
 * assembled from the parts — so a card has to be made with at least a first
 * name. One word is a first name; everything after the first word is the last
 * name, which is wrong for some names and is wrong in a way the person can see
 * and fix, unlike a card that failed to be created at all.
 */
function splitName(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

/**
 * Create-or-update a card, in one script.
 *
 * Found by name first, because the alternative is a second John Doe every time
 * a fact about him is learned. `save` at the end is not optional: Contacts
 * keeps the change in memory until it is asked to commit, and a script that
 * forgets it appears to work and writes nothing.
 *
 * The date carries the same two traps as a pushed reminder, for the same
 * reasons: assembled from components rather than written as a literal, because
 * an AppleScript date literal is read in the user's locale, and flattened to
 * the 1st first, because assigning a month to a date sitting on the 31st rolls
 * it into the next one.
 */
function contactScript(card) {
  const { first, last } = splitName(card.name);
  const label = applescriptString(CONTACT_LABEL);
  const created = [`first name:${applescriptString(first)}`]
    .concat(last ? [`last name:${applescriptString(last)}`] : [])
    .join(', ');

  const lines = [
    'tell application "Contacts"',
    `  set found to (every person whose name is ${applescriptString(card.name)})`,
    '  if (count of found) is 0 then',
    `    set thePerson to make new person with properties {${created}}`,
    '  else',
    '    set thePerson to item 1 of found',
    '  end if',
  ];

  for (const [field, plural] of [['phone', 'phones'], ['email', 'emails']]) {
    if (!card[field]) continue;
    lines.push(
      `  repeat with old in (every ${field} of thePerson whose label is ${label})`,
      '    delete old',
      '  end repeat',
      `  make new ${field} at end of ${plural} of thePerson with properties {label:${label}, value:${applescriptString(card[field])}}`,
    );
  }

  if (card.birthday) {
    const { year, month, day } = card.birthday;
    lines.push(
      '  set d to current date',
      '  set day of d to 1',
      `  set year of d to ${year >= 1000 ? year : NO_BIRTH_YEAR}`,
      `  set month of d to ${month}`,
      `  set day of d to ${day}`,
      '  set time of d to 0',
      '  set birth date of thePerson to d',
    );
  }

  lines.push('  save', 'end tell');
  return lines.join('\n');
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
  contactScript,
  CONTACT_LABEL,
  NO_BIRTH_YEAR,
  notifyScript,
  osascriptHint,
  reminderScript,
  responsibleApp,
  splitName,
};
