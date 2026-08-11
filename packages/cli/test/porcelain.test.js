import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printPlan, setDryRun } from '../dist/dryrun.js';
import { splitCommandLine } from '../dist/external.js';
import {
  announceBrief,
  briefNotification,
  canPush,
  handToReminders,
  loadPorcelain,
  missing,
  parsePorcelain,
  pushDecision,
  redactCommand,
  resolveIntent,
  strayIntents,
  unknownIntents,
  NOTIFY_INTENT,
  PUSH_INTENT,
} from '../dist/porcelain.js';

/**
 * The decisions, and what an intent resolves to. Nothing here posts a real
 * banner or creates a reminder: the pure/executor split exists so the half that
 * can be wrong runs on any machine, including one with no plugin installed on
 * it. The one test that does spawn something spawns a shell script it wrote
 * itself, with the config directory redirected into a temp dir.
 */

/** An `Upcoming`, cut down to what the notification actually reads. */
const item = (text, days, date) => ({
  item: { id: 'x', text },
  date: new Date(date),
  days,
  mentions: [],
});

test('a banner carries the soonest thing and says how much is behind it', () => {
  const banner = briefNotification([
    item('call the dentist', -3, '2026-08-05T00:00:00'),
    item("Emily's birthday", 12, '2026-08-20T00:00:00'),
    item('the lease ends', 25, '2026-09-02T00:00:00'),
  ]);
  assert.equal(banner.title, 'ppr · call the dentist');
  assert.match(banner.body, /3 days overdue/);
  // Not a lie about how much is waiting, and not five things nobody reads.
  assert.match(banner.body, /· 2 more$/);
});

test('one thing coming up does not claim there are others', () => {
  const banner = briefNotification([item('pay the rent', 1, '2026-08-09T00:00:00')]);
  assert.equal(banner.title, 'ppr · pay the rent');
  assert.doesNotMatch(banner.body, /more/);
});

test('a title too long for a banner is cut before macOS cuts it', () => {
  const banner = briefNotification([
    item(
      'renew the domain registration and also update the billing address on the account',
      2,
      '2026-08-10T00:00:00',
    ),
  ]);
  // Roughly one line. Beyond this the OS truncates without ceremony and the
  // useful half of the sentence is the half that disappears.
  assert.ok(banner.title.length <= 54, `too long: ${banner.title.length}`);
  assert.match(banner.title, /^ppr · renew the domain/);
  assert.match(banner.title, /…$/);
});

test('nothing upcoming is nothing to post', () => {
  // A daily "nothing coming up" ping trains people to ignore the channel, and
  // the one that mattered gets ignored with it.
  assert.equal(briefNotification([]), null);
});

test('a reminder only leaves the vault when something says it may', () => {
  const base = { dated: true, available: true };
  assert.deepEqual(pushDecision({ ...base, configured: true }), { push: true });
  assert.deepEqual(pushDecision({ ...base, configured: false, asked: true }), { push: true });

  // Off by default: pushing into another app is not something ppr does to you.
  assert.deepEqual(pushDecision({ ...base, configured: false }), { push: false, reason: 'off' });
  // An instruction wins over the config it disagrees with.
  assert.deepEqual(pushDecision({ ...base, configured: true, asked: false }), {
    push: false,
    reason: 'refused',
  });
});

test('a line with no day is never pushed, however loudly it was asked for', () => {
  // It is a todo, and a todo has no moment for anything over there to ring
  // at — so `--push` cannot conjure a reminder out of it.
  assert.deepEqual(pushDecision({ configured: true, asked: true, dated: false, available: true }), {
    push: false,
    reason: 'undated',
  });
});

test('asking for a push with nothing to push with is answered, not dropped', () => {
  // This used to ask "is this a Mac". It now asks "is there a program on PATH
  // that does this" — the same question, without ppr having to know the answer
  // for every operating system there is.
  assert.deepEqual(pushDecision({ configured: true, dated: true, available: false }), {
    push: false,
    reason: 'unavailable',
  });
  // With nothing switched on there is nothing to explain, so whether the tool
  // exists never comes up.
  assert.deepEqual(pushDecision({ configured: false, dated: true, available: false }), {
    push: false,
    reason: 'off',
  });
});

/** A throwaway config dir and bin dir, so no test can read the developer's own. */
async function sandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ppr-porcelain-'));
  try {
    await mkdir(join(dir, 'config', 'ppr'), { recursive: true });
    await mkdir(join(dir, 'bin'), { recursive: true });
    await fn({
      dir,
      bin: join(dir, 'bin'),
      /** The *user* layer — the only place a binding is ever honoured from. */
      async writeConfig(data) {
        await writeFile(join(dir, 'config', 'ppr', 'config.json'), JSON.stringify(data, null, 2));
      },
      async writeProgram(name, body) {
        const path = join(dir, 'bin', name);
        await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        return path;
      },
      // Never `process.env.PATH`: a developer who has run `install.sh` has a
      // real `ppr-notify` on theirs, which would make every assertion below a
      // claim about that machine. `/usr/bin` and `/bin` are here only so a
      // `#!/bin/sh` recorder can find `cat` and `printf`; no plugin lands in
      // either of them.
      env: { XDG_CONFIG_HOME: join(dir, 'config'), PATH: [join(dir, 'bin'), '/usr/bin', '/bin'].join(':') },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a `porcelain` block means intent to command line, and nothing else', () => {
  assert.deepEqual(parsePorcelain({ notify: '/opt/mine --urgent' }), { notify: '/opt/mine --urgent' });
  assert.deepEqual(parsePorcelain({ 'reminders-push': 'todoist-add --project Inbox' }), {
    'reminders-push': 'todoist-add --project Inbox',
  });
  // An intent ppr does not have runs nothing, the way a hook on an event name
  // ppr does not emit runs nothing: the alternative is guessing which flag
  // somebody meant and running a program for it.
  assert.deepEqual(parsePorcelain({ notifi: 'rm -rf /', push: 'rm -rf /' }), {});
  for (const raw of [null, undefined, 'notify', 42, ['notify']]) {
    assert.deepEqual(parsePorcelain(raw), {});
  }
  assert.deepEqual(parsePorcelain({ notify: ['a'], 'reminders-push': 42 }), {});
  assert.deepEqual(parsePorcelain({ notify: '   ' }), {}, 'blank is not a binding');
  assert.deepEqual(parsePorcelain({ notify: '  mine  ' }), { notify: 'mine' });
});

test('a binding answers an intent, and the name on PATH is what answers without one', async () => {
  await sandbox(async (box) => {
    const mine = await box.writeProgram('my-notifier', 'exit 0');
    await box.writeProgram('ppr-notify', 'exit 0');

    // Nothing configured: today's behaviour exactly — `ppr-notify` on PATH.
    const convention = resolveIntent(NOTIFY_INTENT, {}, box.env);
    assert.equal(convention.bound, false);
    assert.equal(convention.command, 'ppr-notify');
    assert.deepEqual(convention.argv, ['ppr-notify']);
    assert.equal(convention.path, join(box.bin, 'ppr-notify'));

    // A binding wins, even with the conventional name sitting right there —
    // which is the whole point: you should not have to win PATH order to say
    // what `--notify` means.
    const bound = resolveIntent(NOTIFY_INTENT, { notify: `"${mine}" --urgent` }, box.env);
    assert.equal(bound.bound, true);
    assert.deepEqual(bound.argv, [mine, '--urgent'], 'the binding carries its own arguments');
    assert.equal(bound.path, mine);
    // And the intent still names the convention, because there is one naming
    // rule: `porcelain.notify` and `ppr-notify` are the same word.
    assert.equal(bound.intent, 'notify');
    assert.equal(bound.name, 'ppr-notify');
  });
});

test('a binding is read from the user layer, which is the only layer there is', async () => {
  await sandbox(async (box) => {
    await box.writeConfig({
      display: { listLimit: 5 },
      porcelain: { notify: '/opt/mine --urgent', notifi: 'rm -rf /' },
    });
    assert.deepEqual(await loadPorcelain(box.env), { notify: '/opt/mine --urgent' });
    // No file at all is no bindings, not an error: this runs on every
    // `ppr remind`, and a machine with no config file is the common case.
    assert.deepEqual(await loadPorcelain({ XDG_CONFIG_HOME: join(box.dir, 'nowhere') }), {});
  });
});

test('a mistyped intent runs nothing and says so, rather than looking like no binding', async () => {
  // Two intents, so the typo is the likely mistake — and `porcelain.notifi`
  // read back as "nothing configured", which is the same thing a person sees
  // when they have configured nothing at all.
  assert.deepEqual(unknownIntents({ notifi: 'mine', notify: 'mine' }), ['notifi']);
  assert.deepEqual(unknownIntents({ notify: 'mine', 'reminders-push': 'mine' }), []);
  for (const raw of [null, undefined, 'notify', 42, ['notify']]) {
    assert.deepEqual(unknownIntents(raw), []);
  }

  await sandbox(async (box) => {
    await box.writeConfig({ porcelain: { notifi: 'my-notifier --token sk-live-abcdef0123456789' } });
    assert.deepEqual(await strayIntents(box.env), ['notifi']);
    // Still not an error, and still not a binding: a typo must not break a
    // command, and guessing which intent was meant would run a program for it.
    assert.deepEqual(await loadPorcelain(box.env), {});
    assert.deepEqual(await strayIntents({ XDG_CONFIG_HOME: join(box.dir, 'nowhere') }), []);
  });
});

test('a command line reaches a terminal with its token hidden and its program named', () => {
  // The binding is the config value most likely to hold a credential, and it
  // is echoed on every push, by `ppr plugins`, in a `--dry-run` plan, and in
  // the error when the program is not there (I7).
  assert.equal(
    redactCommand(['todoist-add', '--token', 'sk-live-abcdef0123456789']),
    'todoist-add --token sk-liv…6789',
  );
  assert.equal(
    redactCommand(['todoist-add', '--api-key=sk-live-abcdef0123456789']),
    'todoist-add --api-key=sk-liv…6789',
  );
  // The same rule `config list` applies, so a header field is judged by its
  // name too: on a command line, `-` is what `.` is in a config path.
  assert.equal(
    redactCommand(['curl', '-H', 'X-Api-Key: sk-live-abcdef0123456789']),
    "curl -H 'X-Api-Key: sk-liv…6789'",
  );

  // Naming the program is the entire point of every report this feeds, so it
  // is never hidden — and neither is an argument that is not a secret, or the
  // plan would stop saying what would run.
  assert.equal(
    redactCommand(['/opt/my-notifier', '--urgent', '--title', 'ppr · call the dentist']),
    "/opt/my-notifier --urgent --title 'ppr · call the dentist'",
  );
  assert.equal(
    redactCommand(['todoist-add', '--project', 'Inbox', '--url', 'https://example.com/x']),
    'todoist-add --project Inbox --url https://example.com/x',
  );
  assert.equal(redactCommand(['ppr-notify']), 'ppr-notify');
});

test('a binding counts as something to push with', async () => {
  await sandbox(async (box) => {
    const mine = await box.writeProgram('todoist-add', 'exit 0');

    const bound = resolveIntent(PUSH_INTENT, { 'reminders-push': `${mine} --project Inbox` }, box.env);
    assert.equal(canPush(bound), true);
    // The failure this prevents: `--push` reporting "nothing installed" while a
    // binding sits in the config file.
    assert.deepEqual(pushDecision({ configured: true, dated: true, available: canPush(bound) }), {
      push: true,
    });

    // Nothing bound and nothing on PATH is still unavailable, unchanged.
    const nothing = resolveIntent(PUSH_INTENT, {}, box.env);
    assert.equal(canPush(nothing), false);
    assert.deepEqual(pushDecision({ configured: true, dated: true, available: canPush(nothing) }), {
      push: false,
      reason: 'unavailable',
    });
  });
});

test('a typo in a binding is named as one, not reported as nothing installed', async () => {
  await sandbox(async (box) => {
    const absent = missing(resolveIntent(NOTIFY_INTENT, {}, box.env));
    assert.match(absent, /Nothing called ppr-notify on your PATH/, 'the convention names itself');

    const typo = missing(resolveIntent(NOTIFY_INTENT, { notify: 'my-notifier --urgent' }, box.env));
    // Two different mistakes: one is "install something", the other is "you
    // wrote a name that is not there", and only the second can name the file
    // and the word to fix.
    assert.match(typo, /porcelain\.notify/);
    assert.match(typo, /my-notifier/);
    assert.doesNotMatch(typo, /--urgent to run/, 'the arguments are not part of the name');
    assert.match(typo, /config\.json/);
  });
});

test('a command line is words, and a quoted word with a space in it is one word', () => {
  assert.deepEqual(splitCommandLine('ppr-notify'), ['ppr-notify']);
  assert.deepEqual(splitCommandLine('  /opt/mine   --urgent  '), ['/opt/mine', '--urgent']);
  // The case a whitespace split gets silently wrong, which is the case people
  // hit: an application path, and an option whose value is a sentence.
  assert.deepEqual(splitCommandLine('"/Applications/My App/notify" --list "My List"'), [
    '/Applications/My App/notify',
    '--list',
    'My List',
  ]);
  assert.deepEqual(splitCommandLine("'/opt/my notifier' -x"), ['/opt/my notifier', '-x']);
  assert.deepEqual(splitCommandLine('mine --title ""'), ['mine', '--title', '']);
  assert.deepEqual(splitCommandLine(''), []);
});

test('a hostile title reaches the bound program as text, because there is no shell', async () => {
  await sandbox(async (box) => {
    const seen = join(box.dir, 'seen.txt');
    // Records its argv one per line, then the body. Nothing else.
    const mine = await box.writeProgram(
      'my-notifier',
      `printf '%s\\n' "$@" > "${seen}"\nprintf -- '--stdin--\\n' >> "${seen}"\ncat >> "${seen}"`,
    );
    await box.writeConfig({ porcelain: { notify: `"${mine}" --urgent` } });

    // A title comes out of the user's own notes, where every one of these is a
    // legal thing to have typed. `spawn(cmd, args, { shell: true })` does not
    // pass argv — it appends the arguments to the command string unquoted — so
    // under a shell this title would have been three commands and a pipe.
    const text = "; rm -rf ~ $(id) `id` \"q\" 'p' | & \nline two";
    const banner = briefNotification([item(text, 9, '2026-08-20T00:00:00')]);
    assert.ok(banner.title.endsWith('line two'), 'short enough that nothing is truncated away');

    // PPR_DIR too, though nothing here opens a vault: a test that spawns
    // anything points every ppr path at the temp dir, no exceptions. It is an
    // argument rather than a change to the real `process.env`, which is what
    // the `env` parameter is for — the module's other three take one.
    const env = { ...box.env, PPR_DIR: join(box.dir, 'vault'), NO_COLOR: '1' };
    await announceBrief([item(text, 9, '2026-08-20T00:00:00')], env);

    const [argv, body] = (await readFile(seen, 'utf8')).split('--stdin--\n');
    // The contract is the contract whichever door was used: the binding's own
    // arguments, then `--title`, then the title, and the body on stdin. Three
    // arguments exactly — a shell would have cut the third one at the `;` and
    // substituted the rest.
    assert.equal(argv, `--urgent\n--title\n${banner.title}\n`);
    assert.equal(body, banner.body);
  });
});

test('a dry run names what would have run, arguments and all', async () => {
  await sandbox(async (box) => {
    const seen = join(box.dir, 'seen.txt');
    const mine = await box.writeProgram('my-notifier', `printf 'ran\\n' > "${seen}"`);
    await box.writeConfig({
      porcelain: { notify: `"${mine}" --urgent --token sk-live-abcdef0123456789` },
    });

    const said = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk) => (said.push(String(chunk)), true);
    try {
      setDryRun(true);
      await announceBrief([item('call the dentist', -3, '2026-08-05T00:00:00')], {
        ...box.env,
        PPR_DIR: join(box.dir, 'vault'),
      });
      printPlan();
    } finally {
      setDryRun(false);
      process.stderr.write = write;
    }

    assert.equal(await readFile(seen, 'utf8').catch(() => null), null, 'a plan runs nothing');
    const plan = said.join('');
    // §6: the plan is what the command would have done. The program on its own
    // is not that — a binding carries its own arguments, and the title is the
    // line somebody is checking.
    assert.match(plan, /would run .*my-notifier --urgent/);
    assert.match(plan, /--title 'ppr · call the dentist'/);
    // And a plan is printed, so a plan is redacted (I7).
    assert.match(plan, /--token sk-liv…6789/);
    assert.doesNotMatch(plan, /abcdef0123456789/);
  });
});

test('a banner still posts from inside a hook, because a read is not a fan-out', async () => {
  await sandbox(async (box) => {
    const seen = join(box.dir, 'seen.txt');
    const mine = await box.writeProgram('my-notifier', `printf 'ran\\n' > "${seen}"`);
    await box.writeConfig({ porcelain: { notify: `"${mine}" --urgent` } });

    // L24 is about a *write* being reachable from a write it caused. A brief
    // reads, so `hooks: { "entry.created": ["ppr brief --notify"] }` is a
    // reasonable thing to wire and the depth marker on the spawn must not
    // silence it. Guarding here would cost that wiring to prevent a loop only
    // a binding that re-ran `ppr brief --notify` could build.
    await announceBrief([item('call the dentist', 9, '2026-08-20T00:00:00')], {
      ...box.env,
      PPR_DIR: join(box.dir, 'vault'),
      PPR_HOOK_DEPTH: '1',
    });
    assert.equal(await readFile(seen, 'utf8'), 'ran\n');
  });
});

test('a push does not hand over from inside a push, because ppr fans out once', async () => {
  await sandbox(async (box) => {
    const seen = join(box.dir, 'pushed.txt');
    const mine = await box.writeProgram('my-push', `printf 'ran\\n' > "${seen}"`);
    await box.writeConfig({ porcelain: { 'reminders-push': `"${mine}"` } });

    // The other half of the asymmetry above, and the one that has teeth: a
    // binding that logs the reminder into a second vault writes an entry, and
    // `remind.push` is a user-layer setting that applies to that vault too — so
    // the write pushes again, a process per generation, forever (L24). A hook
    // wired the same way is stopped by `hookRunner`; a binding needs its own.
    const target = resolveIntent(PUSH_INTENT, await loadPorcelain(box.env), box.env);
    assert.ok(target.path, 'the binding resolves, so a miss cannot pass for a refusal');

    // `childDepth()` reads the real environment here — the guard returns before
    // the vault or the entry is touched, so both can be the thinnest possible.
    const before = process.env.PPR_HOOK_DEPTH;
    process.env.PPR_HOOK_DEPTH = '1';
    try {
      await handToReminders(
        { root: join(box.dir, 'vault'), now: () => new Date('2026-08-11T00:00:00Z') },
        { id: 'x', path: 'entries/x.md' },
        { push: true },
        target,
      );
    } finally {
      if (before === undefined) delete process.env.PPR_HOOK_DEPTH;
      else process.env.PPR_HOOK_DEPTH = before;
    }
    assert.equal(await readFile(seen, 'utf8').catch(() => null), null, 'nothing was handed over');
  });
});
