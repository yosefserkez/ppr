/**
 * Saying it: the three lines that actually shell out.
 *
 * Kept apart from `applescript.js` so the half that can be wrong — escaping,
 * date assembly, error hints — stays pure and testable on any machine, and so
 * no test in this repo can accidentally post a banner or leave a reminder in
 * somebody's list.
 */

'use strict';

const { spawn } = require('node:child_process');
const { osascriptHint } = require('./applescript.js');

/**
 * Runs a script, and reports rather than throws.
 *
 * Whatever happens here, the entry it is about is already in the vault: these
 * plugins are couriers, and a courier that trips is worth a line on stderr and
 * nothing more.
 */
function osascript(script, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, hint: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, hint: osascriptHint(stderr) });
    });
  });
}

/** True on a Mac. Everywhere else these plugins are a polite no-op. */
const supported = () => process.platform === 'darwin';

/**
 * Reads stdin, if there is any to read.
 *
 * Never when stdin is a character device: a process launched by a scheduler or
 * an editor inherits a stdin that reports non-TTY and never reaches EOF, and a
 * plugin that hangs in cron is as broken as a CLI that does (ppr's I6, and the
 * same check ppr makes).
 */
function readStdin() {
  return new Promise((resolve) => {
    let stat;
    try {
      stat = require('node:fs').fstatSync(0);
    } catch {
      return resolve('');
    }
    if (stat.isCharacterDevice()) return resolve('');

    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** One line on stderr. Plugins never print anything to stdout. */
const note = (line) => process.stderr.write(`${line}\n`);

module.exports = { note, osascript, readStdin, supported };
