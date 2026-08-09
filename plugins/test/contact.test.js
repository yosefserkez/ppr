const test = require('node:test');
const assert = require('node:assert/strict');
const { contactScript, splitName } = require('../applescript.js');
const {
  birthdayIn,
  cardFor,
  emailIn,
  mentions,
  personIn,
  phoneIn,
  subject,
} = require('../ppr-contact');

/**
 * The extraction and the script builders. Nothing here runs osascript and
 * nothing here spawns ppr: `ppr-contact` is split the same way its siblings
 * are, so the half that can be wrong is testable on a machine that is not a
 * Mac — and so a test run never leaves a card in a real person's address book.
 *
 * The fixture is what `ppr context "<name>" --json` actually hands back, down
 * to the two things that make this awkward: the fact store comes back whole
 * while it is small, so most of these facts are about somebody else, and a
 * birthday nobody knows the year of carries `0000`.
 */
const CONTEXT_JSON = {
  query: 'John Doe',
  now: '2026-08-09T09:00:00+01:00',
  facts: [
    {
      id: 'k7x2m9q4b1caaaaa',
      kind: 'memory',
      text: "John Doe's phone number is +44 20 7946 0958",
      from: ['k7x2m9q4b1cbbbbb'],
      origin: 'learned',
      status: 'current',
    },
    {
      id: 'k7x2m9q4b1cccccc',
      kind: 'memory',
      text: 'John Doe can be reached at john.doe@example.com.',
      from: [],
      origin: 'manual',
      status: 'current',
    },
    {
      id: 'k7x2m9q4b1cddddd',
      kind: 'memory',
      text: "John Doe's birthday is 20 October",
      from: [],
      origin: 'manual',
      status: 'current',
      date: '0000-10-20',
      recurs: 'yearly',
    },
    {
      // Somebody else entirely, handed over because the store is small enough
      // to send whole. Putting this number on John's card is the bug this
      // fixture exists to catch.
      id: 'k7x2m9q4b1ceeeee',
      kind: 'memory',
      text: "Priya Raman's phone number is 555 010 9999",
      from: [],
      origin: 'learned',
      status: 'current',
    },
    {
      id: 'k7x2m9q4b1cfffff',
      kind: 'memory',
      text: 'The lease ends on 2027-03-01',
      from: [],
      origin: 'manual',
      status: 'current',
      date: '2027-03-01',
    },
  ],
  upcoming: [],
  entries: [],
};

const factsFor = () => CONTEXT_JSON.facts;

test('a card is built only from facts about that person', () => {
  const card = cardFor('John Doe', factsFor());
  assert.equal(card.phone, '+44 20 7946 0958');
  assert.equal(card.email, 'john.doe@example.com');
  assert.deepEqual(card.birthday, { year: 0, month: 10, day: 20 });

  // The neighbour's number came back in the same answer and stays off the
  // card: `ppr context` sends the whole store while it is small, so filtering
  // is the caller's job and not the query's.
  assert.doesNotMatch(JSON.stringify(card), /555/);

  const priya = cardFor('Priya Raman', factsFor());
  assert.equal(priya.phone, '555 010 9999');
  assert.equal(priya.email, undefined);
  assert.equal(priya.birthday, undefined);

  // Nobody ppr has a fact about is a card with nothing on it, not a guess.
  const stranger = cardFor('Someone Else', factsFor());
  assert.deepEqual(stranger, { name: 'Someone Else' });
});

test('a phone number reaches Contacts spelled the way it was written', () => {
  // Every one of these is how somebody's number is written down. Normalising
  // them into one house format is how a country code gets dropped.
  for (const [text, expected] of [
    ["John's phone number is +44 20 7946 0958", '+44 20 7946 0958'],
    ['reach him on (555) 010-9999', '(555) 010-9999'],
    ['mobile 555.010.9999', '555.010.9999'],
    ['tel +1-202-555-0143', '+1-202-555-0143'],
    // The number stops where the digits do; the extension is prose.
    ['office: 020 7946 0958 ext 12', '020 7946 0958'],
  ]) {
    assert.equal(phoneIn(text), expected, text);
  }
});

test('a date is not a phone number, however many digits it has', () => {
  // Eight digits around separators, which is exactly what a phone number looks
  // like to a pattern — and a fact store is full of them.
  assert.equal(phoneIn('the lease ends on 2027-03-01'), null);
  assert.equal(phoneIn("Emily's birthday is 2002-10-20"), null);
  // Too short to dial: a quantity, a version, or a door number.
  assert.equal(phoneIn('the build takes 123456 ms'), null);
  assert.equal(phoneIn('flat 221b'), null);
  assert.equal(phoneIn(''), null);
});

test('an email is taken without the sentence it was sitting in', () => {
  assert.equal(emailIn('write to john.doe@example.com.'), 'john.doe@example.com');
  assert.equal(emailIn('<a.b+tag@sub.example.co.uk>'), 'a.b+tag@sub.example.co.uk');
  assert.equal(emailIn('he has no email'), null);
  assert.equal(emailIn('@handle is not an address'), null);
});

test('a birthday has to say it is one, and has to recur', () => {
  const base = { text: "John Doe's birthday is 20 October", date: '0000-10-20', recurs: 'yearly' };
  assert.deepEqual(birthdayIn(base), { year: 0, month: 10, day: 20 });
  assert.deepEqual(
    birthdayIn({ ...base, date: '1984-10-20' }),
    { year: 1984, month: 10, day: 20 },
  );
  // A birthday that happened once is an event, not a birthday.
  assert.equal(birthdayIn({ ...base, recurs: undefined }), null);
  // A yearly fact that is not a birthday is an anniversary, a renewal, a
  // subscription — Contacts has one birth date field and this is not it.
  assert.equal(birthdayIn({ ...base, text: 'the domain renews on 20 October' }), null);
  assert.equal(birthdayIn({ ...base, date: undefined }), null);
  assert.equal(birthdayIn(null), null);
});

test('a birthday with no year gets the year Contacts uses for that', () => {
  const script = contactScript({ name: 'John Doe', birthday: { year: 0, month: 10, day: 20 } });
  // ppr writes `0000` for a year nobody knows; Contacts writes 1604 and shows
  // a birthday with no age. Two conventions for one idea, translated here.
  assert.match(script, /set year of d to 1604/);
  assert.match(script, /set month of d to 10/);
  assert.match(script, /set day of d to 20/);
  // Flattened first, or assigning a month to a date sitting on the 31st rolls
  // it into the next one.
  assert.ok(script.indexOf('set day of d to 1\n') < script.indexOf('set month of d to'));
  // A date *literal* would be read in the user's locale, where 10/08 is August
  // in one region and October in another.
  assert.doesNotMatch(script, /date "/);

  // A real year is somebody's actual birth year and is passed straight through.
  assert.match(
    contactScript({ name: 'x', birthday: { year: 1984, month: 2, day: 29 } }),
    /set year of d to 1984/,
  );
});

test('a hostile name cannot end the string and start a command', () => {
  const script = contactScript({
    name: 'a" & (do shell script "id") & "b',
    phone: '555 010 9999',
  });
  // The injected quote is escaped, so the whole thing stays one string literal
  // and `do shell script` is text rather than an expression.
  assert.match(script, /whose name is "a\\" & \(do shell script \\"id\\"\) & \\"b"/);
  assert.doesNotMatch(script, /^\s*do shell script/m);
  // And it is still one script: a literal cannot span lines.
  for (const line of script.split('\n')) {
    assert.equal((line.match(/(?<!\\)"/g) || []).length % 2, 0, `unbalanced quotes: ${line}`);
  }
});

test("an apostrophe in a name is a name, not an escape", () => {
  const script = contactScript({ name: "Siobhán O'Brien", email: 'sio@example.ie' });
  // AppleScript takes exactly five escapes and an apostrophe is not one of
  // them — quoting it would put a backslash into somebody's surname.
  assert.match(script, /whose name is "Siobhán O'Brien"/);
  assert.match(script, /first name:"Siobhán", last name:"O'Brien"/);
  assert.deepEqual(splitName("Siobhán O'Brien"), { first: 'Siobhán', last: "O'Brien" });
  assert.deepEqual(splitName('Prince'), { first: 'Prince', last: '' });
  assert.deepEqual(splitName('  Jean  Luc  Picard '), { first: 'Jean', last: 'Luc Picard' });
});

test('a card is found before it is created, and saved after it is written', () => {
  const script = contactScript({ name: 'John Doe', phone: '555 010 9999', email: 'j@e.com' });
  assert.equal(
    script,
    [
      'tell application "Contacts"',
      '  set found to (every person whose name is "John Doe")',
      '  if (count of found) is 0 then',
      '    set thePerson to make new person with properties {first name:"John", last name:"Doe"}',
      '  else',
      '    set thePerson to item 1 of found',
      '  end if',
      // Labelled, and the old ppr-labelled one deleted first: a hook on
      // fact.learned runs again and again, and a card with thirty copies of
      // one number is worse than no card.
      '  repeat with old in (every phone of thePerson whose label is "ppr")',
      '    delete old',
      '  end repeat',
      '  make new phone at end of phones of thePerson with properties {label:"ppr", value:"555 010 9999"}',
      '  repeat with old in (every email of thePerson whose label is "ppr")',
      '    delete old',
      '  end repeat',
      '  make new email at end of emails of thePerson with properties {label:"ppr", value:"j@e.com"}',
      // Contacts keeps the change in memory until it is asked to commit, so a
      // script that forgets this appears to work and writes nothing.
      '  save',
      'end tell',
    ].join('\n'),
  );
});

test('the person a fact is about is read from how it was written', () => {
  assert.equal(personIn("Emily's phone number is 555 010 9999"), 'Emily');
  assert.equal(personIn("John Doe's email is j@e.com"), 'John Doe');
  assert.equal(personIn('John Doe can be reached at j@e.com'), 'John Doe');
  assert.equal(personIn("Siobhán O'Brien's number is 555 010 9999"), "Siobhán O'Brien");
  // One capitalised word with no possessive is a sentence, not a person. "The
  // lease ends 2027-03-01" begins with a capital, and a card called The is
  // worse than no card at all.
  assert.equal(personIn('The lease ends on 2027-03-01'), null);
  assert.equal(personIn('the deploy failed again'), null);
  assert.equal(personIn(''), null);
});

test('a fact has to be about a person and carry a field before anything happens', () => {
  const event = (body, extra, name = 'fact.learned') => ({
    v: 1,
    event: name,
    at: '2026-08-09T09:00:00+01:00',
    vault: '/home/me/ppr',
    entry: {
      id: 'k7x2m9q4b1c6jc6ad',
      kind: 'memory',
      title: body,
      body,
      path: 'memory/a-fact-6ad.md',
      ...(extra ? { extra } : {}),
    },
  });

  assert.equal(subject(event("John Doe's phone number is 555 010 9999")), 'John Doe');
  assert.equal(subject(event('Emily can be emailed at emily@example.com')), null, 'one word, no possessive');
  assert.equal(subject(event("Emily's email is emily@example.com")), 'Emily');
  assert.equal(
    subject(event("Emily's birthday is 20 October", { date: '0000-10-20', recurs: 'yearly' })),
    'Emily',
  );

  // Hooks fire for everything, so most of what arrives here is somebody
  // else's business and leaves without a word.
  assert.equal(subject(event('Emily likes dark chocolate')), null);
  assert.equal(subject(event('The lease ends on 2027-03-01', { date: '2027-03-01' })), null);
  assert.equal(subject(event("John Doe's phone number is 555 010 9999", null, 'entry.created')), null);
  assert.equal(subject(event("John Doe's phone number is 555 010 9999", null, 'entry.updated')), null);
  assert.equal(subject(null), null);
  assert.equal(subject({}), null);

  // A refined fact is the wording changing, which is exactly when a card is
  // out of date.
  assert.equal(subject(event("John Doe's phone number is 555 010 9999", null, 'fact.refined')), 'John Doe');
});

test('every part of a name has to appear before a fact counts as theirs', () => {
  assert.equal(mentions("John Doe's phone number is 555", 'John Doe'), true);
  assert.equal(mentions('john doe is on 555', 'John Doe'), true);
  assert.equal(mentions("John Smith's phone number is 555", 'John Doe'), false);
  assert.equal(mentions('', 'John Doe'), false);
});
