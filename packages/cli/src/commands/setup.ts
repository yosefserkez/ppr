import { Command } from 'commander';
import { PprError } from '@ppr/core';
import { findVault } from '@ppr/core/node';
import { globals } from '../context.js';
import { refuseDryRun } from '../dryrun.js';
import { confirm } from '../input.js';
import { Keyboard } from '../ui/keyboard.js';
import { color, json, out, errline, table } from '../render.js';
import {
  CHECKS,
  applicable,
  checkContext,
  inspect,
  inspectAll,
  type Check,
  type CheckContext,
  type CheckReport,
} from '../setup/checks.js';

/**
 * Two renderings of one check registry.
 *
 * `ppr doctor` reports. `ppr setup` walks you through it and will download and
 * install things with your say-so. Both print the non-interactive command for
 * everything they do, so the guided path teaches the scriptable one instead of
 * hiding it — and `--json` hands an agent the same list as data.
 */

const MARK: Record<string, string> = {
  ok: color.green('✓'),
  warn: color.yellow('!'),
  missing: color.red('✗'),
};

const reportJson = (reports: CheckReport[], root: string) => ({
  vault: root,
  ok: reports.every((r) => r.status === 'ok'),
  checks: reports.map((r) => ({
    id: r.id,
    label: r.label,
    status: r.status,
    detail: r.detail,
    ...(r.fix ? { fix: r.fix } : {}),
    repairable: r.repairable,
  })),
});

function printReport(reports: CheckReport[]): void {
  for (const report of reports) {
    out(`${MARK[report.status]} ${report.label.padEnd(18)} ${report.detail}`);
    if (report.status !== 'ok' && report.fix) out(`  ${color.dim(report.fix)}`);
  }
  const broken = reports.filter((r) => r.status !== 'ok');
  if (!broken.length) return;

  const fixable = broken.filter((r) => r.repairable).length;
  errline('');
  errline(
    color.yellow(`${broken.length} thing${broken.length === 1 ? '' : 's'} to look at`) +
      (fixable ? color.dim(` — \`ppr setup\` can fix ${fixable} of them`) : ''),
  );
}

/** Runs one step of the guided walkthrough. */
async function runStep(
  check: Check,
  ctx: CheckContext,
  position: string,
): Promise<'fixed' | 'kept' | 'skipped'> {
  const before = await check.inspect(ctx);
  out('');
  out(`${color.dim(position)}  ${color.bold(check.label)}   ${MARK[before.status]} ${before.detail}`);

  if (!check.repair) return 'kept';

  // Already-good steps are offered, not forced: setup is also how you change
  // your mind about a choice you made last month.
  const question = before.status === 'ok' ? '  Change it?' : '  Set it up now?';
  if (!(await confirm(question, before.status !== 'ok'))) return 'skipped';

  const changed = await check.repair(ctx);
  if (!changed) return 'skipped';

  const after = await check.inspect(ctx);
  out(`  ${MARK[after.status]} ${after.detail}`);
  return 'fixed';
}

/**
 * Narrows the walkthrough to the steps the user named.
 *
 * Ids are dotted, so a prefix selects a family: `voice` picks up `voice.binary`,
 * `voice.model`, and `voice.recorder` — which is how you fix one thing without
 * sitting through the whole tour.
 */
function matchSteps(names: string[], available: Check[]): Check[] {
  const wanted = names.map((n) => n.toLowerCase());
  const picked = available.filter((check) =>
    wanted.some((name) => check.id === name || check.id.startsWith(`${name}.`)),
  );
  if (picked.length) return picked;

  throw new PprError(
    'EINVALID',
    `No setup step matches: ${names.join(', ')}`,
    `Steps: ${available.map((c) => c.id).join(', ')}`,
  );
}

export function setupCommand(): Command {
  return new Command('setup')
    .description('guided setup: configure, install, and download what ppr needs')
    .argument('[step...]', 'only these steps, e.g. `voice` or `ai.key`')
    .option('--all', 'walk every check, not just the main steps')
    .option('--list', 'list the step ids and exit')
    .action(async (steps: string[], flags: { all?: boolean; list?: boolean }, self: Command) => {
      // `ppr doctor` is the preview: it inspects everything and changes
      // nothing. Setup downloads a model and installs a helper, and there is
      // no version of showing that which does not do it.
      if (!flags.list) refuseDryRun('ppr setup', 'It downloads and installs things; `ppr doctor` reports without touching anything.');
      const g = globals(self);
      const found = findVault(g.vault ? { explicit: g.vault } : {});
      const ctx = await checkContext(found.root, found.exists);

      if (flags.list) {
        const rows = CHECKS.map((check) => [
          check.id,
          color.dim(check.repair ? check.label : `${check.label} (report only)`),
        ]) as Array<[string, string]>;
        return g.json ? json(CHECKS.map((c) => ({ id: c.id, label: c.label, repairable: Boolean(c.repair) }))) : out(table(rows));
      }

      // Validate names before anything else, so a typo is caught on every path.
      const named = steps.length ? matchSteps(steps, CHECKS) : null;

      // No terminal? Show the plan instead of hanging on a prompt nobody sees.
      if (!Keyboard.usable() || g.json) {
        const reports = await inspect(ctx, named ?? undefined);
        if (g.json) return json(reportJson(reports, ctx.root));
        out(color.bold('ppr setup needs a terminal. Here is what it would do:\n'));
        printReport(reports);
        out(`\n${color.dim('Every step above is also a plain command — see the hints.')}`);
        return;
      }

      out(color.bold('ppr setup'));
      out(color.dim('Enter accepts the default in brackets. Ctrl-C stops; nothing is lost.'));

      // Recomputed each turn: a repair changes which checks apply — picking
      // ollama adds an Ollama step, picking whisper adds a model download — and
      // the walkthrough should pick those up in registry order, not append them.
      const wanted = (check: Check) =>
        named
          ? named.some((c) => c.id === check.id)
          : flags.all || check.guided || Boolean(check.repair);
      const done = new Set<string>();
      let fixed = 0;

      // Named steps are run whether or not they currently apply, so
      // `ppr setup voice.model` works before whisper has been chosen.
      const pool = () => (named ? CHECKS : applicable(ctx));

      for (;;) {
        const pending = pool().filter((c) => wanted(c) && !done.has(c.id));
        const next = pending[0];
        if (!next) break;
        done.add(next.id);

        const result = await runStep(next, ctx, `${done.size}/${done.size + pending.length - 1}`);
        if (result === 'fixed') fixed++;
      }

      const reports = await inspectAll(ctx);
      const broken = reports.filter((r) => r.status === 'missing');
      out('');
      out(
        broken.length
          ? color.yellow(`Done — ${broken.length} thing${broken.length === 1 ? '' : 's'} still unset`)
          : color.green('All set.'),
      );
      if (fixed) out(color.dim(`Changed ${fixed} setting${fixed === 1 ? '' : 's'}.`));
      if (steps.length) return;
      out('');
      out(table([
        ['ppr "first note"', color.dim('write something')],
        ['ppr ls', color.dim('browse with the keyboard')],
        ['ppr setup <step>', color.dim('change one thing later')],
        ['ppr doctor', color.dim('check this again any time')],
      ]));
    });
}

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('check the environment and report anything that needs attention')
    .argument('[step...]', 'only report or fix these steps')
    .option('--fix', 'offer to repair whatever is broken')
    .action(async (steps: string[], flags: { fix?: boolean }, self: Command) => {
      if (flags.fix) refuseDryRun('ppr doctor --fix', 'Plain `ppr doctor` is the dry run: it reports and changes nothing.');
      const g = globals(self);
      const found = findVault(g.vault ? { explicit: g.vault } : {});
      const ctx = await checkContext(found.root, found.exists);

      const scope = (list: Check[]) => (steps.length ? matchSteps(steps, CHECKS) : list);

      if (flags.fix && Keyboard.usable() && !g.json) {
        for (const check of scope(applicable(ctx))) {
          const finding = await check.inspect(ctx);
          if (finding.status === 'ok' || !check.repair) continue;
          out('');
          out(`${MARK[finding.status]} ${color.bold(check.label)}  ${finding.detail}`);
          if (await confirm('  Fix it now?', true)) await check.repair(ctx);
        }
        out('');
      }

      const reports = await inspect(ctx, steps.length ? scope(CHECKS) : undefined);
      if (g.json) return json(reportJson(reports, ctx.root));
      printReport(reports);
      if (!flags.fix && reports.some((r) => r.status !== 'ok' && r.repairable)) {
        errline(color.dim('Run `ppr doctor --fix` to be walked through it.'));
      }
    });
}
