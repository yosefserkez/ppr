import test from 'node:test';
import assert from 'node:assert/strict';
import { applescriptString, notifyScript, osascriptHint, reminderScript } from '../dist/node.js';

/**
 * The script builders only. Nothing here runs osascript: the bridge is split
 * pure/executor precisely so the part that can be wrong is testable on a
 * machine that is not a Mac, and so a test run never posts a notification or
 * leaves a reminder behind.
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
