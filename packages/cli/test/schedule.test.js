import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { crontabLine, jobArgv, labelFor, parseAt, plist } from '../dist/schedule.js';

test('a time of day is parsed or refused, never guessed', () => {
  assert.deepEqual(parseAt('08:00'), { hour: 8, minute: 0 });
  assert.deepEqual(parseAt('3:05'), { hour: 3, minute: 5 });
  for (const bad of ['24:00', '08:60', '8am', '0800', '']) {
    assert.equal(parseAt(bad), null, `should reject: ${bad}`);
  }
});

test('a scheduled job is an ordinary ppr command', () => {
  assert.deepEqual(
    jobArgv({ job: 'learn', at: '03:00' }, '/opt/homebrew/bin/node', '/repo/dist/index.js'),
    ['/opt/homebrew/bin/node', '/repo/dist/index.js', 'memory', 'learn', '--quiet'],
  );
  // The vault has to be explicit: cron has no cwd worth inheriting.
  assert.deepEqual(
    jobArgv({ job: 'brief', at: '08:00', vault: '~/notes' }, '/usr/bin/node', '/repo/dist/index.js'),
    ['/usr/bin/node', '/repo/dist/index.js', '--vault', '~/notes', 'brief'],
  );
});

test('a scheduled job names its interpreter instead of trusting PATH', () => {
  const argv = jobArgv({ job: 'learn', at: '03:00' }, process.execPath, '/repo/dist/index.js');
  // launchd runs with PATH=/usr/bin:/bin:/usr/sbin:/sbin and cron with as
  // little; a shebang that says `env node` finds nothing there.
  assert.ok(isAbsolute(argv[0]), `expected an absolute node path, got ${argv[0]}`);
  assert.equal(argv[0], process.execPath);
  assert.ok(isAbsolute(argv[1]), `expected an absolute script path, got ${argv[1]}`);
});

test('the launchd agent runs on a clock and never at load', () => {
  const xml = plist({ job: 'brief', at: '08:30' }, ['/bin/ppr', 'brief']);

  assert.match(xml, /<key>Label<\/key>\s*<string>sh\.ppr\.brief<\/string>/);
  assert.match(xml, /<key>Hour<\/key>\s*<integer>8<\/integer>/);
  assert.match(xml, /<key>Minute<\/key>\s*<integer>30<\/integer>/);
  // Installing a schedule must not run the job, and neither must waking up.
  assert.doesNotMatch(xml, /RunAtLoad/);
  // A job you cannot debug is a job you stop trusting.
  assert.match(xml, /StandardErrorPath/);
});

test('paths with characters XML cares about survive', () => {
  const xml = plist({ job: 'learn', at: '03:00' }, ['/bin/ppr', '--vault', '/tmp/a&b<c>']);
  assert.match(xml, /<string>\/tmp\/a&amp;b&lt;c&gt;<\/string>/);
});

test('the crontab line quotes what a shell would otherwise split', () => {
  const line = crontabLine({ job: 'learn', at: '03:07' }, ['ppr', '--vault', '/my notes', 'memory', 'learn']);
  assert.match(line, /^7 3 \* \* \* /);
  assert.match(line, /'\/my notes'/);
});

test('job labels are stable — they are what the OS is keyed on', () => {
  assert.equal(labelFor('learn'), 'sh.ppr.learn');
  assert.equal(labelFor('brief'), 'sh.ppr.brief');
});
