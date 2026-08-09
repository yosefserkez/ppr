/**
 * `--dry-run`: what would this have done?
 *
 * Cheap because of two decisions that were made for other reasons. Every write
 * ppr makes goes through the `Storage` port (I8), and every program ppr runs
 * goes through `runChild` (I13) — so intercepting two seams intercepts all of
 * it, and there is no list of side effects to keep up to date. The commands
 * that write *outside* Storage are the exceptions, and there are four of them:
 * `init`, `config set`, `hooks add/rm`, and `schedule add/rm`. Each says here
 * what it would have written.
 *
 * ## What a dry run does not fake
 *
 * **Models still run.** A preview assembled from a fake model answer is
 * fiction: the whole question `ppr dump --dry-run` asks is "what would the
 * distiller do to my words", and answering it with the words unchanged is
 * worse than not answering. A dry run costs what the command costs.
 *
 * **`$EDITOR` still opens.** Composing is not an effect; saving is, and saving
 * is what gets suppressed. An `--dry-run` that would not let you see the
 * template is not showing you the command.
 *
 * **Errors still stand.** `ppr memory learn --dry-run` with no model
 * configured is still `ENOAI` and still exits 4. A dry run reports what would
 * happen, and what would happen is that.
 *
 * The plan goes to stderr, dim, after the command's own output — so
 * `--dry-run --json` still prints exactly the JSON the real run would have
 * printed (I10), which on a write command is the entry that would have been
 * created. That is the preview, and it is the natural one.
 */

import { PprError, type FileStat, type Storage } from '@ppr/core';
import { color, errline } from './render.js';

interface PlanStep {
  line: string;
  /** Extra lines, indented under it: a config delta, a plist's calendar entry. */
  detail: string[];
}

let active = false;
let plan: PlanStep[] = [];
let housekeeping = 0;

/** Set once, from `hoistGlobals`, before any command runs. */
export function setDryRun(on: boolean): void {
  active = on;
  plan = [];
  housekeeping = 0;
}

export const dryRun = (): boolean => active;

/** Records something that would have happened. A no-op when not dry-running. */
export function would(line: string, detail: string[] = []): void {
  if (active) plan.push({ line, detail });
}

/**
 * Everything that would have happened, once the command has had its say.
 *
 * Printed at the very end rather than as it goes, so the plan reads as a plan
 * and not as interleaved chatter — and after the output, because the output is
 * the preview and this is the footnote explaining that it was one.
 */
export function printPlan(): void {
  if (!active) return;
  for (const step of plan) {
    errline(color.dim(`would ${step.line}`));
    for (const line of step.detail) errline(color.dim(`       ${line}`));
  }
  // One line for the bookkeeping, because naming `.ppr/cache/index.json` and
  // `.ppr/state.json` individually would bury the entry the user asked about
  // under the housekeeping that happens on every command anyway.
  if (housekeeping) {
    errline(
      color.dim(`would refresh ${housekeeping} file${housekeeping === 1 ? '' : 's'} under .ppr/`),
    );
  }
}

/**
 * Refuses a preview that cannot be honest.
 *
 * `ppr setup` downloads a model and installs a helper; there is no version of
 * showing that which does not do it. Saying so is better than a plan that
 * quietly omits the interesting half.
 */
export function refuseDryRun(command: string, why: string): void {
  if (!active) return;
  throw new PprError(
    'EINVALID',
    `--dry-run cannot preview \`${command}\``,
    `${why} Nothing was changed.`,
  );
}

/** Where the vault's own files live, as opposed to the user's words. */
const HOUSEKEEPING = '.ppr/';

/**
 * The Storage port, recording instead of writing.
 *
 * Reads pass straight through, so everything the command does — resolving a
 * ref, ranking a search, reading the high-water mark — behaves exactly as it
 * would have. Only the four mutating methods are intercepted, and they are
 * classified by path prefix: a file under `.ppr/` is the index cache or the
 * learn mark, which every command touches and nobody asked about, while
 * anything else is the entry the user came for.
 */
export function recordingStorage(storage: Storage): Storage {
  const note = (verb: string, path: string): void => {
    if (path.startsWith(HOUSEKEEPING)) housekeeping++;
    else would(`${verb} ${path}`);
  };
  return {
    read: (path: string): Promise<string | null> => storage.read(path),
    list: (prefix: string): Promise<FileStat[]> => storage.list(prefix),
    stat: (path: string): Promise<FileStat | null> => storage.stat(path),
    async write(path: string): Promise<void> {
      note('write', path);
    },
    async remove(path: string): Promise<void> {
      note('remove', path);
    },
    async move(from: string, to: string): Promise<void> {
      if (from.startsWith(HOUSEKEEPING)) housekeeping++;
      else would(`move ${from} → ${to}`);
    },
  };
}
