import { Command } from 'commander';
import { findVault } from '@ppr/core/node';
import { globals } from '../context.js';
import { confirm } from '../input.js';
import { Keyboard } from '../ui/keyboard.js';
import { color, json, out, errline, table } from '../render.js';
import {
  applicable,
  checkContext,
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

export function setupCommand(): Command {
  return new Command('setup')
    .description('guided setup: configure, install, and download what ppr needs')
    .option('--all', 'walk every check, not just the main steps')
    .action(async (flags: { all?: boolean }, self: Command) => {
      const g = globals(self);
      const found = findVault(g.vault ? { explicit: g.vault } : {});
      const ctx = await checkContext(found.root, found.exists);

      // No terminal? Show the plan instead of hanging on a prompt nobody sees.
      if (!Keyboard.usable() || g.json) {
        const reports = await inspectAll(ctx);
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
      const wanted = (check: Check) => flags.all || check.guided || Boolean(check.repair);
      const done = new Set<string>();
      let fixed = 0;

      for (;;) {
        const pending = applicable(ctx).filter((c) => wanted(c) && !done.has(c.id));
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
      out('');
      out(table([
        ['ppr "first note"', color.dim('write something')],
        ['ppr ls', color.dim('browse with the keyboard')],
        ['ppr doctor', color.dim('check this again any time')],
      ]));
    });
}

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('check the environment and report anything that needs attention')
    .option('--fix', 'offer to repair whatever is broken')
    .action(async (flags: { fix?: boolean }, self: Command) => {
      const g = globals(self);
      const found = findVault(g.vault ? { explicit: g.vault } : {});
      const ctx = await checkContext(found.root, found.exists);

      if (flags.fix && Keyboard.usable() && !g.json) {
        for (const check of applicable(ctx)) {
          const finding = await check.inspect(ctx);
          if (finding.status === 'ok' || !check.repair) continue;
          out('');
          out(`${MARK[finding.status]} ${color.bold(check.label)}  ${finding.detail}`);
          if (await confirm('  Fix it now?', true)) await check.repair(ctx);
        }
        out('');
      }

      const reports = await inspectAll(ctx);
      if (g.json) return json(reportJson(reports, ctx.root));
      printReport(reports);
      if (!flags.fix && reports.some((r) => r.status !== 'ok' && r.repairable)) {
        errline(color.dim('Run `ppr doctor --fix` to be walked through it.'));
      }
    });
}
