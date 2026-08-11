import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandProgram,
  externalFor,
  findOnPath,
  resolveCommand,
  scanExternals,
  splitCommandLine,
} from '../dist/external.js';

/**
 * Splitting a command line, and finding the program at the front of one.
 *
 * Two rules that look like one and are not: what may be a *ppr subcommand word*
 * (`ppr foo` -> `ppr-foo`) and what may be a *program somebody named*. The
 * tests below hold them apart, because the day they merged, a binding to a
 * perfectly ordinary executable reported itself missing.
 */

/** A throwaway bin dir, so nothing here can see the developer's own PATH. */
async function sandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ppr-external-'));
  try {
    await mkdir(join(dir, 'bin'), { recursive: true });
    await fn({
      bin: join(dir, 'bin'),
      async writeProgram(name, body = 'exit 0') {
        const path = join(dir, 'bin', name);
        await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        return path;
      },
      // Only the temp dir: a developer who has run `install.sh` has real
      // `ppr-*` programs on their PATH, which would make every assertion here a
      // claim about that machine rather than about this code.
      env: { PATH: join(dir, 'bin') },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('an apostrophe in a path is a character, not a quote', () => {
  // The case that bites: a real home directory, and a binding that used to
  // collapse into one nonexistent word called "/Users/obrien/bin/notify --urgent".
  assert.deepEqual(splitCommandLine("/Users/o'brien/bin/notify --urgent"), [
    "/Users/o'brien/bin/notify",
    '--urgent',
  ]);
  assert.deepEqual(splitCommandLine("mine --msg don't"), ['mine', '--msg', "don't"]);
  // An apostrophe must not cost a genuinely quoted argument its quotes, which
  // is why an unmatched quote is skipped rather than ending the parse.
  assert.deepEqual(splitCommandLine("/Users/o'brien/bin/notify --list \"My List\""), [
    "/Users/o'brien/bin/notify",
    '--list',
    'My List',
  ]);
  // A quote inside a matched pair is content: it closes nothing.
  assert.deepEqual(splitCommandLine('mine --msg "it\'s fine"'), ['mine', '--msg', "it's fine"]);
});

test('a quoted word with a space in it is one word', () => {
  assert.deepEqual(splitCommandLine('ppr-notify'), ['ppr-notify']);
  assert.deepEqual(splitCommandLine('  /opt/mine   --urgent  '), ['/opt/mine', '--urgent']);
  assert.deepEqual(splitCommandLine('"/Applications/My App/notify" --list "My List"'), [
    '/Applications/My App/notify',
    '--list',
    'My List',
  ]);
  assert.deepEqual(splitCommandLine("'/opt/my notifier' -x"), ['/opt/my notifier', '-x']);
  // A quote mid-word still quotes: `--list="My List"` is how people write it.
  assert.deepEqual(splitCommandLine('mine --list="My List"'), ['mine', '--list=My List']);
  assert.deepEqual(splitCommandLine('mine --title ""'), ['mine', '--title', '']);
  assert.deepEqual(splitCommandLine(''), []);
  assert.deepEqual(splitCommandLine('   '), []);
});

test('an unterminated quote keeps the rest of the line, and shows itself', () => {
  // Swallowing it was the silent failure: the words after it simply stopped
  // existing. Kept as an ordinary character, the mistake travels all the way to
  // the error message — "there is nothing called \"/opt/my to run" points at
  // the missing quote, where "/opt/my notifier --urgent" pointed at nothing.
  assert.deepEqual(splitCommandLine('mine --msg "unterminated rest of it'), [
    'mine',
    '--msg',
    '"unterminated',
    'rest',
    'of',
    'it',
  ]);
  assert.equal(commandProgram('"/opt/my notifier --urgent'), '"/opt/my');
});

test('a backslash is a character too — no escapes, as promised', () => {
  // Deliberate, and the trade is stated: `\` before a space is rare, an
  // apostrophe in a home directory is not, and only one of the two can be
  // literal. Somebody with a space writes quotes.
  assert.deepEqual(splitCommandLine('x\\ y --z'), ['x\\', 'y', '--z']);
  assert.deepEqual(splitCommandLine('"x\\ y" --z'), ['x\\ y', '--z']);
});

test('the program at the front of a hook line is named, whatever the line does', () => {
  // The regression this file exists to pin: reporting commands (`ppr hooks
  // add`, `ppr plugins`, `schedule --pipe`) hand *shell* lines to
  // `commandProgram`, and shell quoting is richer than ours. Naming the program
  // and leaving the quote alone beats failing to describe the file at all.
  assert.equal(commandProgram("it's-a-script --x"), "it's-a-script");
  assert.equal(commandProgram("notify it\\'s-here"), 'notify');
  assert.equal(commandProgram('"/Applications/My App/notify" --loud'), '/Applications/My App/notify');
  assert.equal(commandProgram('ppr-reminders-push'), 'ppr-reminders-push');
  assert.equal(commandProgram('  '), '');
  assert.equal(commandProgram(''), '');
});

test('a program the user named is looked up by its real name on disk', async () => {
  await sandbox(async (box) => {
    // Neither of these is a legal ppr subcommand word, and neither has to be:
    // they are filenames, and the filesystem is what decides those.
    const plus = await box.writeProgram('my+notifier');
    const under = await box.writeProgram('my_notifier');

    assert.equal(findOnPath('my+notifier', box.env), plus, "a name outside ppr's own spelling");
    assert.equal(findOnPath('my_notifier', box.env), under);
    // Which is the answer `--notify`, a hook and `ppr plugins` all needed: the
    // bare name and the absolute path resolve to the same file.
    assert.equal(resolveCommand(commandProgram('my+notifier --x'), box.env), plus);
    assert.equal(resolveCommand(plus, box.env), plus);

    assert.equal(findOnPath('my+notifier-nope', box.env), null, 'absent is still absent');
    assert.equal(resolveCommand('', box.env), null);
  });
});

test('a PATH lookup is by name — anything with a separator is a path', async () => {
  await sandbox(async (box) => {
    await box.writeProgram('notify');
    // Joining a separator-carrying string onto every PATH entry would answer
    // about files nobody's PATH mentions. `resolveCommand` is where a path is
    // resolved, and it tests for the separator the same way.
    assert.equal(findOnPath('../bin/notify', box.env), null);
    assert.equal(findOnPath('', box.env), null);
    assert.equal(findOnPath('notify', { PATH: '' }), null, 'an empty PATH holds nothing');
  });
});

test('a plugin is only a subcommand if its name is one, which has not changed', async () => {
  await sandbox(async (box) => {
    await box.writeProgram('ppr-weather');
    await box.writeProgram('ppr-my+plugin');
    await box.writeProgram('not-a-plugin');

    // `ppr <word>` is ppr's own vocabulary and it stays narrow: a word ppr
    // would refuse to read as a command does not become one just because a file
    // of that name turned up on PATH.
    assert.equal(externalFor('weather', [], box.env), join(box.bin, 'ppr-weather'));
    assert.equal(externalFor('my+plugin', [], box.env), null, 'not a subcommand word');
    assert.equal(externalFor('weather', ['weather'], box.env), null, 'a built-in always wins');

    assert.deepEqual(
      scanExternals(box.env).map((cmd) => cmd.word),
      ['weather'],
      'the listing shows what `ppr <word>` would dispatch to, and nothing else',
    );
  });
});
