const test = require('node:test');
const assert = require('node:assert/strict');
const { applescriptString, notifyScript, osascriptHint, reminderScript } = require('../applescript.js');
const { pushable } = require('../ppr-reminders-push');
const { parseArgs } = require('../ppr-notify');

/**
 * The script builders only. Nothing here runs osascript: the plugins are split
 * pure/executor precisely so the part that can be wrong is testable on a
 * machine that is not a Mac, and so a test run never posts a notification or
 * leaves a reminder behind.
 *
 * These assertions moved out of `core/test/macos.test.js` with the code they
 * describe — every one of them was a bug once, and rewriting them from scratch
 * on the way out of core would have thrown that away.
 */

test('a string reaches AppleScript as the string that went in', () => {
  assert.equal(applescriptString('plain'), '"plain"');
  // The two that break the literal, and the three that cannot be in one.
  assert.equal(applescriptString('say "hi"'), '"say \\"hi\\""');
  assert.equal(applescriptString('C:\\path'), '"C:\\\\path"');
  assert.equal(applescriptString('one\ntwo'), '"one\\ntwo"');
  assert.equal(applescriptString('a\tb\r'), '"a\\tb\\r"');
  // A backslash already in front of a quote must not eat the escape ppr adds.
  assert.equal(applescriptString('\\"'), '"\\\\\\""');
});

test('a hostile title cannot end the notification and start a command', () => {
  const script = notifyScript('a" & (do shell script "id") & "b', 'body');
  // The injected quote is escaped, so the whole thing stays one string literal
  // and `do shell script` is text rather than an expression.
  assert.equal(
    script,
    'display notification "body" with title "a\\" & (do shell script \\"id\\") & \\"b"',
  );
});

test('a brief with newlines in it stays a single AppleScript literal', () => {
  const script = notifyScript('ppr brief', 'Call the dentist\n3 days overdue');
  assert.equal(
    script,
    'display notification "Call the dentist\\n3 days overdue" with title "ppr brief"',
  );
  assert.doesNotMatch(script.split('\n')[0], /^$/);
  assert.equal(script.split('\n').length, 1, 'a raw newline would be a syntax error');
});

test('a pushed reminder builds its date rather than writing one out', () => {
  const script = reminderScript({ title: 'call the dentist', date: '2026-08-10', note: 'ppr 6jc6ad' });
  assert.equal(
    script,
    [
      'tell application "Reminders"',
      '  set d to current date',
      // Flattened first: assigning a month while the date sits on the 31st
      // rolls it into the next one.
      '  set day of d to 1',
      '  set year of d to 2026',
      '  set month of d to 8',
      '  set day of d to 10',
      '  set time of d to 32400',
      '  make new reminder with properties {name:"call the dentist", body:"ppr 6jc6ad", remind me date:d}',
      'end tell',
    ].join('\n'),
  );
  // A date *literal* would be read in the user's locale, where 10/08 is
  // August in one region and October in another.
  assert.doesNotMatch(script, /date "/);
  // No list is picked: the default list is where a hand-made reminder goes.
  assert.doesNotMatch(script, /list/);
});

test('a reminder with no usable date still lands in the list', () => {
  for (const date of [undefined, '', 'tomorrow', '2026-8-10']) {
    const script = reminderScript({ title: 'x', ...(date === undefined ? {} : { date }) });
    assert.doesNotMatch(script, /remind me date/, `should not date from: ${date}`);
    assert.match(script, /make new reminder with properties \{name:"x"\}/);
  }
});

test('a reminder carries the short id that traces it back to the entry', () => {
  const script = reminderScript({ title: 'pay the rent', date: '2027-03-01', note: 'ppr 6jc6ad' });
  assert.match(script, /body:"ppr 6jc6ad"/);
});

test('the automation refusal names the switch that fixes it', () => {
  const hint = osascriptHint(
    'execution error: Not authorized to send Apple events to Reminders. (-1743)',
  );
  assert.match(hint, /System Settings › Privacy & Security › Automation/);
  // Anything else is reported as itself, on one line.
  assert.equal(osascriptHint('execution error: boom (-42)\ntrailing noise'), 'execution error: boom (-42)');
  assert.match(osascriptHint('   \n  '), /without saying why/);
});

/**
 * Which events `ppr-reminders-push` is about.
 *
 * It is wired to `entry.created`, which means it is handed every log, note,
 * and clip as well — ppr's event names are coarse on purpose and a consumer
 * does its own filtering. Getting this wrong in the loud direction would put
 * every note you write into Reminders.app.
 */
const event = (entry, name = 'entry.created') => ({
  v: 1,
  event: name,
  at: '2026-08-09T09:00:00+01:00',
  vault: '/home/me/ppr',
  entry: { id: 'k7x2m9q4b1c6jc6ad', kind: 'reminder', body: 'call the dentist', ...entry },
});

test('a dated reminder is what gets pushed, and nothing else is', () => {
  const push = pushable(event({ extra: { date: '2026-08-10' } }));
  assert.equal(push.title, 'call the dentist');
  assert.equal(push.date, '2026-08-10');
  // The short id, so `ppr show 6jc6ad` answers "where did this come from".
  assert.equal(push.note, 'ppr 6jc6ad');
});

test('everything else on entry.created is silently none of its business', () => {
  // An ordinary capture. This runs on every one of them.
  assert.equal(pushable(event({ kind: 'log', extra: {} })), null);
  assert.equal(pushable(event({ kind: 'memory', extra: { date: '2026-08-10' } })), null);
  // A reminder with no day has nothing to ring at.
  assert.equal(pushable(event({ extra: {} })), null);
  assert.equal(pushable(event({ extra: undefined })), null);
  // One already dealt with has nothing to ring about.
  assert.equal(pushable(event({ extra: { date: '2026-08-10', status: 'done' } })), null);
  // And an update is not a creation: pushing on every edit would file the same
  // reminder again every time you fixed a typo.
  assert.equal(pushable(event({ extra: { date: '2026-08-10' } }, 'entry.updated')), null);
  assert.equal(pushable(event({ extra: { date: '2026-08-10' } }, 'entry.completed')), null);
  assert.equal(pushable(null), null);
  assert.equal(pushable({}), null);
});

test('ppr-notify takes a title and reads the rest from stdin', () => {
  assert.equal(parseArgs([]).title, 'ppr');
  assert.equal(parseArgs(['--title', 'this morning']).title, 'this morning');
  assert.equal(parseArgs(['--title=this morning']).title, 'this morning');
  assert.equal(parseArgs(['-t', 'x']).title, 'x');
  assert.equal(parseArgs(['--help']).help, true);
});
