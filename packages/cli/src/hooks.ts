/**
 * Hooks: run my command when ppr writes something.
 *
 *   "hooks": { "entry.created": ["ppr-reminders-push"] }
 *
 * This is the general mechanism behind ppr's whole push surface. The command
 * gets the event as JSON on stdin — the same shape `ppr ls --json` prints, one
 * serializer (`eventJson`) — plus `PPR_EVENT` and `PPR_VAULT` in its
 * environment, so a two-line shell script is a legitimate consumer.
 *
 * ## The security rule, which is invariant-grade
 *
 * **Hooks are read from `~/.config/ppr/config.json` and from nowhere else.**
 * Never from `<vault>/.ppr/config.json`, whatever it says.
 *
 * Config merges three layers and the vault layer wins (§5), which is exactly
 * right for `display.listLimit` and catastrophic for a list of shell commands:
 * a vault is a git repo people are encouraged to clone and share, so honouring
 * a vault-declared hook would mean `git clone && ppr ls` executes a stranger's
 * shell. Git learned this the hard way and its answer is the same as ours —
 * hooks live in `.git/hooks` and do not clone.
 *
 * The enforcement is structural rather than a check: `hooks` is not a field on
 * `Config` at all, `validateConfig` deletes any that a merge produced, and the
 * only reader is `readConfigLayer(globalConfigPath())` right here. There is no
 * merged config to read one out of by mistake, and `ppr config set hooks.…`
 * refuses with a pointer to the file.
 *
 * Because the table can only come from the user's own machine, a hook is
 * allowed to be a shell string — the same trust as a line in their profile.
 */

import { eventJson, isEventName, type VaultEvent, type VaultEventName } from '@ppr/core';
import { globalConfigPath, readConfigLayer, writeConfigLayer } from '@ppr/core/node';
import { runChild } from './child.js';
import { dryRun, would } from './dryrun.js';
import { color, errline } from './render.js';

/** Event name -> the commands to run, in order. */
export type Hooks = Record<string, string[]>;

/**
 * What a `hooks` block means. Pure, so the parsing rules are testable without
 * a config file: unknown event names run nothing (a typo is silent rather than
 * surprising), and a bare string is read as a list of one.
 */
export function parseHooks(raw: unknown): Hooks {
  const out: Hooks = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isEventName(name)) continue;
    const commands = (Array.isArray(value) ? value : [value])
      .filter((command): command is string => typeof command === 'string')
      .map((command) => command.trim())
      .filter(Boolean);
    if (commands.length) out[name] = commands;
  }
  return out;
}

/** The hook table, from the user layer alone. See the security rule above. */
export async function loadHooks(env: NodeJS.ProcessEnv = process.env): Promise<Hooks> {
  return parseHooks((await readConfigLayer(globalConfigPath(env))).hooks);
}

/**
 * The registration half, in the same file as the runner on purpose.
 *
 * `ppr hooks add` is a pen over a file you may still edit by hand — the Rails
 * rule: a friendly command writes the visible config, it never becomes a second
 * place a hook can live. It writes the layer the runner above reads and no
 * other, so "registered" and "runs" cannot come apart, and `config set hooks.…`
 * stays refused because that path would let `--local` put one in a vault.
 */
export function withHook(hooks: Hooks, event: VaultEventName, command: string): Hooks | null {
  const current = hooks[event] ?? [];
  // Registering twice is a no-op rather than a second spawn: a hook is wiring,
  // and wiring is either there or not.
  if (current.includes(command)) return null;
  return { ...hooks, [event]: [...current, command] };
}

/** Drops one command, or the whole event. The last one takes the key with it. */
export function withoutHook(
  hooks: Hooks,
  event: VaultEventName,
  command?: string,
): { hooks: Hooks; removed: string[] } {
  const current = hooks[event] ?? [];
  const removed = command ? current.filter((c) => c === command) : current;
  const left = command ? current.filter((c) => c !== command) : [];

  const next = { ...hooks };
  // An empty list is not "no hooks", it is a leftover — and a config file full
  // of empty arrays is a file nobody can read at a glance.
  if (left.length) next[event] = left;
  else delete next[event];
  return { hooks: next, removed };
}

/**
 * Persists the table, leaving every other key in the file alone.
 *
 * Read-modify-write of the user layer, so somebody's `display.listLimit` is
 * still there afterwards. Returns the file, because naming it is how a person
 * finds out where their hooks actually live.
 *
 * `change` is the one line a `--dry-run` plan shows for it. The guard is here
 * rather than at the two call sites so that a third one cannot forget it:
 * this is the only function in ppr that writes a hook.
 */
export async function saveHooks(hooks: Hooks, change?: string): Promise<string> {
  const file = globalConfigPath();
  if (dryRun()) {
    would(`write ${file}`, change ? [change] : []);
    return file;
  }
  const layer = await readConfigLayer(file);
  if (Object.keys(hooks).length) layer.hooks = hooks;
  else delete layer.hooks;
  await writeConfigLayer(file, layer);
  return file;
}

/**
 * An `onEvent` listener that spawns the configured commands, or nothing at all
 * when no hooks are configured — which is the overwhelmingly common case, and
 * the reason nothing is read or spawned on a plain `ppr ls`.
 *
 * Spawned immediately rather than buffered: an interactive browse session can
 * run for ten minutes, and forty pending notifications delivered at the end of
 * it are forty notifications about things you already watched happen.
 * `drainChildren()` at the end of the command is what bounds the waiting.
 */
export function hookRunner(hooks: Hooks): ((event: VaultEvent) => void) | undefined {
  if (!Object.keys(hooks).length) return undefined;

  return (event: VaultEvent) => {
    const commands = hooks[event.event];
    if (!commands) return;
    const payload = `${JSON.stringify(eventJson(event))}\n`;

    for (const command of commands) {
      void runChild(command, {
        shell: true,
        input: payload,
        env: { PPR_EVENT: event.event, PPR_VAULT: event.vault },
        because: `${command}  (${event.event})`,
      }).then((result) => {
        // One line, on stderr, and never an exit code: the entry is written
        // and a courier that tripped is not the user's problem to solve now.
        // Whatever it said is passed on whether or not it failed — a hook that
        // exits 0 saying "not on this platform" is reporting, not succeeding.
        const line = result.said ?? result.hint;
        if (line) errline(color.dim(`hook ${event.event}: ${line}`));
      });
    }
  };
}
