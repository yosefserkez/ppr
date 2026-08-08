#!/usr/bin/env node
/**
 * Runs the memory eval suite against a real model.
 *
 * Not part of `pnpm test`: it costs money, needs a network, and — the whole
 * point — is not deterministic. Tests pin behaviour; this measures it, and the
 * number it prints is only comparable to the same number from another run.
 *
 *   pnpm eval                        # the configured model
 *   pnpm eval --model gpt-4o-mini    # a specific one
 *   pnpm eval --repeat 3             # same suite three times, to see flakiness
 *   pnpm eval --dimension dates      # one dimension
 *   pnpm eval --json > runs/today.json
 *
 * Scoring is deterministic keyword matching, not a model judging a model. A
 * judge would add a second unmeasured system to the thing being measured, and
 * "did the fact mention Emily and chocolate" needs no judgement.
 */

import { Vault, MemoryStorage, DEFAULT_CONFIG, mergeConfig, toFact, createProvider, withProviderDefaults } from '../dist/index.js';
import { loadConfig, loadSecrets } from '../dist/node.js';
import { CASES } from './cases.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const REPEAT = Number(flag('repeat', 1));
const ONLY_DIMENSION = flag('dimension', null);
const ONLY_NAME = flag('case', null);
const AS_JSON = has('json');

// ---------------------------------------------------------------- matching

/**
 * Whether every term appears in the text as a whole word.
 *
 * Possessives are folded so "Emily's" satisfies "emily", and substrings never
 * count — "redis" must not satisfy "is", which is the mistake that made an
 * earlier version of this scoring look far better than the system was.
 */
function containsAll(text, terms) {
  // Curly apostrophes are normalised first: a model writing "don’t know" was
  // being scored as a failure to say it did not know, which measured the
  // scorer rather than the model.
  const normalise = (s) => s.toLowerCase().replace(/[’‘]/g, "'");
  const haystack = ` ${normalise(text).replace(/'s\b/g, '')} `;
  return terms.every((term) => {
    const needle = normalise(term).trim();
    if (!needle) return true;
    // A term with a trailing space (e.g. "no ") is matched literally, so a
    // case can ask for a phrase without fighting word boundaries.
    if (/\s$/.test(term)) return haystack.includes(needle);
    return new RegExp(`(?<![\\w'])${escapeRegExp(needle)}(?![\\w'])`).test(haystack);
  });
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const inRange = (value, expected) =>
  Array.isArray(expected) ? value >= expected[0] && value <= expected[1] : value === expected;

const show = (expected) => (Array.isArray(expected) ? `${expected[0]}–${expected[1]}` : String(expected));

// ------------------------------------------------------------------ running

async function buildProvider() {
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), await loadConfig(process.cwd()));
  const override = flag('model', null);
  if (override) config.ai.model = override;
  if (config.ai.provider === 'none') {
    throw new Error('No model configured. Run `ppr ai setup`, or pass --model.');
  }
  const secrets = await loadSecrets();
  const provider = createProvider(withProviderDefaults(config.ai), secrets);
  if (!provider) throw new Error(`Could not build provider: ${config.ai.provider}`);
  return { provider, config };
}

/** One case, once. Returns a list of named checks with pass/fail. */
async function runCase(testCase, provider, config) {
  const checks = [];
  const vault = await Vault.open({
    root: '/eval',
    storage: new MemoryStorage(),
    config: structuredClone(config),
    provider,
  });
  const byName = new Map();

  for (const [roundIndex, round] of testCase.rounds.entries()) {
    for (const entry of round.entries ?? []) {
      byName.set(entry.name, await vault.add({ body: entry.text, kind: 'log' }));
    }

    let result;
    try {
      result = await vault.learn();
    } catch (err) {
      checks.push({ name: `round ${roundIndex + 1}: learn`, ok: false, detail: String(err.message ?? err) });
      continue;
    }
    if (result.unreadable) {
      checks.push({
        name: `round ${roundIndex + 1}: the model was understood`,
        ok: false,
        detail: `${result.unreadable} entries produced unparseable output`,
      });
    }

    const facts = vault.facts();
    const expect = round.expect ?? {};
    const label = testCase.rounds.length > 1 ? `round ${roundIndex + 1}: ` : '';

    for (const wanted of expect.facts ?? []) {
      const hit = facts.find((f) => containsAll(f.text, wanted.must));
      checks.push({
        name: `${label}knows ${wanted.must.join(' + ')}`,
        ok: Boolean(hit),
        detail: hit ? hit.text : `facts: ${facts.map((f) => f.text).join(' | ') || '(none)'}`,
      });
      if (!hit) continue;

      if (wanted.date !== undefined) {
        const ok = wanted.date === null ? !hit.date : hit.date === wanted.date;
        checks.push({
          name: `${label}date of ${wanted.must.join(' + ')}`,
          ok,
          detail: `${hit.date ?? 'none'} (wanted ${wanted.date ?? 'none'})`,
        });
      }
      if (wanted.recurs !== undefined) {
        const ok = wanted.recurs === null ? !hit.recurs : hit.recurs === wanted.recurs;
        checks.push({
          name: `${label}recurrence of ${wanted.must.join(' + ')}`,
          ok,
          detail: `${hit.recurs ?? 'none'} (wanted ${wanted.recurs ?? 'none'})`,
        });
      }
      if (wanted.from) {
        const source = byName.get(wanted.from);
        checks.push({
          name: `${label}${wanted.must.join(' + ')} came from "${wanted.from}"`,
          ok: hit.from.length === 1 && hit.from[0] === source?.id,
          detail: `from ${hit.from.map((id) => nameOf(byName, id)).join(', ') || '(nothing)'}`,
        });
      }
    }

    for (const banned of expect.forbid ?? []) {
      const hit = facts.find((f) => containsAll(f.text, banned));
      checks.push({
        name: `${label}does not store ${banned.join(' + ')}`,
        ok: !hit,
        detail: hit ? hit.text : 'absent',
      });
    }

    for (const [key, actual] of [
      ['total', facts.length],
      ['learned', result.learned.length],
      ['refined', result.refined.length],
      ['conflicts', result.conflicts.length],
      ['duplicates', result.duplicates],
    ]) {
      if (expect[key] === undefined) continue;
      checks.push({
        name: `${label}${key}`,
        ok: inRange(actual, expect[key]),
        detail: `${actual} (wanted ${show(expect[key])})`,
      });
    }
  }

  for (const question of testCase.ask ?? []) {
    let answer;
    try {
      answer = await vault.ask(question.question);
    } catch (err) {
      checks.push({ name: `asks "${question.question}"`, ok: false, detail: String(err.message ?? err) });
      continue;
    }
    const text = answer.text;

    if (question.must) {
      const matched = question.must.filter((terms) => containsAll(text, terms));
      // `anyMust` is for answers with many valid phrasings — a refusal can be
      // "I do not know" or "nothing here mentions that", and both are right.
      const ok = question.anyMust ? matched.length > 0 : matched.length === question.must.length;
      checks.push({ name: `answers "${question.question}"`, ok, detail: truncate(text) });
    }
    for (const banned of question.mustNot ?? []) {
      checks.push({
        name: `does not invent ${banned.join(' + ')}`,
        ok: !containsAll(text, banned),
        detail: truncate(text),
      });
    }
  }

  return checks;
}

const nameOf = (byName, id) => {
  for (const [name, entry] of byName) if (entry.id === id) return name;
  return id.slice(-6);
};

const truncate = (s, max = 100) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

// ------------------------------------------------------------------ reporting

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `${code}${s}${RESET}` : s);

async function main() {
  const { provider, config } = await buildProvider();
  const selected = CASES.filter(
    (c) =>
      (!ONLY_DIMENSION || c.dimension === ONLY_DIMENSION) &&
      (!ONLY_NAME || c.name.includes(ONLY_NAME)),
  );
  if (!selected.length) throw new Error('No cases matched.');

  if (!AS_JSON) {
    process.stderr.write(
      `${paint(BOLD, 'ppr memory eval')}  ${config.ai.provider}/${config.ai.model}  ` +
        `${selected.length} cases × ${REPEAT}\n\n`,
    );
  }

  const runs = [];
  for (let pass = 0; pass < REPEAT; pass++) {
    for (const testCase of selected) {
      const checks = await runCase(testCase, provider, config);
      runs.push({ case: testCase.name, dimension: testCase.dimension, pass, checks });
      if (!AS_JSON) report(testCase, checks);
    }
  }

  const summary = summarise(runs);
  if (AS_JSON) {
    process.stdout.write(
      `${JSON.stringify(
        { model: `${config.ai.provider}/${config.ai.model}`, repeat: REPEAT, summary, runs },
        null,
        2,
      )}\n`,
    );
  } else {
    printSummary(summary);
  }
  // A failing suite is a failing exit code, so this can gate a release.
  process.exitCode = summary.total.failed > 0 ? 1 : 0;
}

function report(testCase, checks) {
  const failed = checks.filter((c) => !c.ok);
  const mark = failed.length ? paint(RED, '✖') : paint(GREEN, '✔');
  process.stderr.write(`${mark} ${testCase.name} ${paint(DIM, `(${testCase.dimension})`)}\n`);
  for (const check of failed) {
    process.stderr.write(`    ${paint(RED, check.name)}\n      ${paint(DIM, check.detail)}\n`);
  }
}

function summarise(runs) {
  const byDimension = {};
  let passed = 0;
  let failed = 0;
  for (const run of runs) {
    const bucket = (byDimension[run.dimension] ??= { passed: 0, failed: 0 });
    for (const check of run.checks) {
      if (check.ok) {
        bucket.passed++;
        passed++;
      } else {
        bucket.failed++;
        failed++;
      }
    }
  }
  const rate = (b) => (b.passed + b.failed ? b.passed / (b.passed + b.failed) : 1);
  return {
    byDimension: Object.fromEntries(
      Object.entries(byDimension).map(([k, v]) => [k, { ...v, rate: Number(rate(v).toFixed(3)) }]),
    ),
    total: { passed, failed, rate: Number(rate({ passed, failed }).toFixed(3)) },
  };
}

function printSummary(summary) {
  process.stderr.write(`\n${paint(BOLD, 'Score')}\n`);
  const width = Math.max(...Object.keys(summary.byDimension).map((k) => k.length));
  for (const [dimension, stats] of Object.entries(summary.byDimension)) {
    const pct = `${Math.round(stats.rate * 100)}%`.padStart(4);
    const bar = '█'.repeat(Math.round(stats.rate * 20)).padEnd(20, '·');
    const tint = stats.rate === 1 ? GREEN : stats.rate >= 0.8 ? '' : RED;
    process.stderr.write(`  ${dimension.padEnd(width)}  ${paint(tint, pct)}  ${paint(DIM, bar)}\n`);
  }
  const { passed, failed, rate } = summary.total;
  process.stderr.write(
    `\n  ${paint(BOLD, `${Math.round(rate * 100)}%`)}  ${passed} passed, ${failed} failed\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`${paint(RED, 'eval failed')} ${err.message ?? err}\n`);
  process.exitCode = 1;
});
