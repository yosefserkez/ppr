/**
 * The friendly flags, and the two ways an intent resolves to a tool.
 *
 * `ppr brief --notify` and `ppr remind --push` are still here, still spelled
 * the same, and still on by a single boolean in config. What has gone is any
 * idea inside ppr of *how* a notification happens. A flag names an **intent**,
 * and the intent is spelled the same in both places it can be answered:
 *
 *   --notify  ->  notify           ->  ppr-notify          (stdin: text; --title)
 *   --push    ->  reminders-push   ->  ppr-reminders-push   (stdin: the event)
 *
 * Resolution order, per intent:
 *
 *   1. `porcelain.<intent>` in ~/.config/ppr/config.json — a whole command line
 *   2. `ppr-<intent>` on PATH — the convention, and the default
 *   3. nothing, and one dim line on stderr saying so
 *
 * The PATH convention is the one that needs no ppr release and no config
 * schema, so it stays the default: replace `ppr-reminders-push` and `--push`
 * means Todoist. The binding is there because winning PATH order with a wrapper
 * script named exactly `ppr-notify` is a lot of ceremony for "`--notify` means
 * `/opt/my-notifier --urgent`" — and because the analogy this design is built
 * on always allowed arguments. `$EDITOR` is a *command line*: `EDITOR="code
 * --wait"` works, and has since long before ppr.
 *
 *   "porcelain": { "notify": "/opt/my-notifier --urgent",
 *                  "reminders-push": "todoist-add --project Inbox" }
 *
 * ## Where a binding may come from — the same security rule as `hooks`
 *
 * **Read from `~/.config/ppr/config.json` and from nowhere else.** A binding is
 * a program ppr will run, so it carries `hooks.ts`'s rule verbatim: config
 * merges three layers and the vault layer wins, which is right for
 * `display.listLimit` and catastrophic for a command line, because a vault is a
 * git repo people are told to clone and `git clone && ppr brief --notify` would
 * then run a stranger's program. Enforced structurally, not by a check:
 * `porcelain` is not a field on `Config`, `validateConfig` deletes any that a
 * merge produced, the only reader is `readConfigLayer(globalConfigPath())`
 * below, and `ppr config set porcelain.…` refuses at every scope and names the
 * file. Hand-editing that file is the whole interface.
 *
 * ## A binding is argv, not a shell line
 *
 * A hook gets `shell: true` because a hook is a whole pipeline the user wrote
 * and ppr adds nothing to it. A binding is different in exactly the way that
 * matters: ppr appends `--title <the first thing in your brief>` to it, and a
 * title comes out of the user's own notes, where `foo; rm -rf ~` is a legal
 * thing to have written. Under `shell: true` node appends arguments to the
 * command string unquoted (see `ChildOptions`), so that title would be shell
 * source. Quoting it would work; not having a shell works better and needs no
 * one to remember. So a binding is split into words (`splitCommandLine`,
 * quotes honoured, nothing else) and spawned as argv. `|` in a binding is an
 * argument; somebody who wants a pipeline writes a script and binds that —
 * which is what `$EDITOR` has always required too.
 *
 * ## A binding is printed, so a binding is redacted
 *
 * Of everything in that config file, the binding is the value most likely to be
 * holding a credential: `todoist-add --token sk-…` is exactly the line somebody
 * writes. It is also the value ppr *echoes* the most — on stderr after every
 * push, in `ppr plugins` and its `--json`, in a `--dry-run` plan, and in the
 * error when the program at its front is not there. I7 says a secret reaches
 * neither a config file, the vault, nor an error message, so every one of those
 * goes through `redactCommand` below, which is `@ppr/core`'s `redactValue`
 * applied word by word. One rule about what a config value may look like on the
 * way out is how I7 is enforced; a second rule living here would be a second
 * thing to keep in step.
 *
 * The hard rules survive all of it unchanged, because they were never about
 * macOS:
 *
 * - The vault write happens first and always stands. Everything here runs
 *   after it and cannot undo it — a plugin that is missing, slow, or broken
 *   costs one dim line on stderr and never an exit code (I2's shape).
 * - **ppr fans out once, from the command a person ran.** A binding is a
 *   command line out of the same file a hook comes from, so it is the same fork
 *   bomb with a different trigger, and it gets `hookRunner`'s answer verbatim:
 *   nothing here spawns anything when `PPR_HOOK_DEPTH` is already set (L24).
 * - One-way. Nothing is read back from wherever the copy went, so nothing over
 *   there can write in here, so the markdown stays the only owner of the row
 *   (I1).
 * - **One contract, whichever door was used.** A bound command is a drop-in for
 *   `ppr-notify`: same `--title` argument, same body on stdin. A bound push gets
 *   the `entry.created` event on stdin with `PPR_EVENT`/`PPR_VAULT`, exactly as
 *   a hook on that event would. Two doors with two contracts is two things to
 *   keep working (L18), and every published plugin would break under a binding.
 * - Pure decisions, thin executors. What a banner says, whether a reminder is
 *   allowed out of the vault, and what a binding resolves to are functions with
 *   unit tests; the code around them is three lines and goes through
 *   `runChild`, which is the one way ppr runs anybody else's program.
 */

import { countdown, formatDay, redactValue, truncate, vaultEvent, eventJson, type Entry, type Upcoming, type Vault } from '@ppr/core';
import { globalConfigPath, readConfigLayer } from '@ppr/core/node';
import { childDepth, runChild } from './child.js';
import { resolveCommand, splitCommandLine } from './external.js';
import { color, errline } from './render.js';

/** The read composer: text in, wherever you like it, out. */
export const NOTIFY_INTENT = 'notify';

/** The write consumer: one ppr event in, a copy somewhere else out. */
export const PUSH_INTENT = 'reminders-push';

/**
 * One naming rule, so nothing needs a lookup table.
 *
 * The intent key *is* the conventional program name minus its prefix, which is
 * why `ppr plugins` can print both halves of a row from one string and why
 * there is no second vocabulary to learn: bind `porcelain.notify` and you have
 * rebound whatever `ppr-notify` was doing.
 */
export const porcelainName = (intent: string): string => `ppr-${intent}`;

/**
 * The conventional name spelled out, for the one help string that names it.
 * Anything deciding what to *run* asks `resolveIntent`, so that a binding is
 * never bypassed by a constant.
 */
export const NOTIFY_PLUGIN = porcelainName(NOTIFY_INTENT);

/** The intents a flag can name. Two, and both ship a program (I13). */
export const INTENTS = [NOTIFY_INTENT, PUSH_INTENT] as const;

/** Intent -> the command line that answers it. */
export type Porcelain = Record<string, string>;

/**
 * What a `porcelain` block means. Pure, so the parsing rules are testable
 * without a config file, and shaped exactly like `parseHooks`: an intent ppr
 * does not have runs nothing (a typo is silent rather than surprising, and
 * guessing which intent somebody meant would mean running a program for it),
 * and anything that is not a non-empty string is ignored rather than obeyed.
 */
export function parsePorcelain(raw: unknown): Porcelain {
  const out: Porcelain = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  for (const [intent, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(INTENTS as readonly string[]).includes(intent)) continue;
    if (typeof value !== 'string') continue;
    const command = value.trim();
    if (command) out[intent] = command;
  }
  return out;
}

/**
 * The keys in a `porcelain` block that ppr has no flag for.
 *
 * Dropping them silently is right for *running* — guessing which intent
 * somebody meant would mean running a program for it — but it is wrong for
 * *reporting*, and that is the difference from `parseHooks`. There are eight
 * event names and two intents; `porcelain.notifi` is the likelier mistake by a
 * mile, and until something says so it looks exactly like no binding at all.
 * `missing()` was written to name a mistyped program for the same reason, and
 * this is that sentence for a mistyped intent.
 *
 * The keys only. The value is a command line and may be holding a credential
 * (I7), and a typo is no reason to print one.
 */
export function unknownIntents(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.keys(raw as Record<string, unknown>).filter(
    (key) => !(INTENTS as readonly string[]).includes(key),
  );
}

/** The bindings, from the user layer alone. See the security rule above. */
export async function loadPorcelain(env: NodeJS.ProcessEnv = process.env): Promise<Porcelain> {
  return parsePorcelain((await readConfigLayer(globalConfigPath(env))).porcelain);
}

/**
 * The stray keys, from that same one file.
 *
 * Here rather than in `ppr plugins` because the file a binding may come from is
 * read in exactly one place (the security rule above), and a report that opened
 * `globalConfigPath()` for itself would be a second reader to keep honest.
 */
export async function strayIntents(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  return unknownIntents((await readConfigLayer(globalConfigPath(env))).porcelain);
}

/** What an intent resolves to right now, and how. */
export interface Target {
  /** `notify` — the conventional program name minus its `ppr-`. */
  intent: string;
  /** `ppr-notify` — what the PATH convention looks for. */
  name: string;
  /**
   * The whole command line that will run: the binding, or the bare name.
   *
   * Raw — the record of what is configured, and not the thing to print.
   * Everything that shows a person a command line shows `redactCommand(argv)`
   * (I7, see the header).
   */
  command: string;
  /** That command line as argv. Everything ppr adds goes after it. */
  argv: string[];
  /** Whether a `porcelain.<intent>` answered, rather than PATH. */
  bound: boolean;
  /** Where the program at the front is, or null when there is nothing to run. */
  path: string | null;
}

/**
 * The one answer to "what does this flag run", for every caller.
 *
 * Pure with respect to the binding table so a test can hand one over, and it
 * asks `resolveCommand` the same question `ppr plugins` and `ppr hooks add`
 * ask, so a binding naming `/opt/my-notifier` is found by all three or by none.
 */
export function resolveIntent(
  intent: string,
  porcelain: Porcelain,
  env: NodeJS.ProcessEnv = process.env,
): Target {
  const bound = porcelain[intent];
  const name = porcelainName(intent);
  const command = bound ?? name;
  const argv = bound ? splitCommandLine(bound) : [name];
  return {
    intent,
    name,
    command,
    argv,
    bound: bound !== undefined,
    path: resolveCommand(argv[0] ?? '', env),
  };
}

/** The same thing, having read the one file a binding may come from. */
export async function porcelainFor(
  intent: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Target> {
  return resolveIntent(intent, await loadPorcelain(env), env);
}

/**
 * A command line on its way to a terminal, a `--json` payload, or an error.
 *
 * The rule is `redactValue`, the one `config list`, `config get`, `ai status
 * --json`, and `ppr plugins`' own settings section already go through — not a
 * second rule that happens to agree with it today (I7, and see the header).
 *
 * What a command line needs is the *translation*, not a new rule. `redactValue`
 * judges a value by the key above it, and a command line spells that pair as
 * two words (`--token sk-…`) or as one (`--token=sk-…`, `X-Api-Key: sk-…`), so
 * the line is walked as pairs and every value is asked of the one helper. The
 * name is handed over the way a config path spells it: `-` and `_` separate the
 * parts of a name on a command line where a path uses `.`, and `SECRET_KEY` is
 * asking whether the last part is one of the words every author uses for a
 * credential.
 *
 * The program at the front is never a value and is never hidden — naming it is
 * the entire point of every report this feeds.
 *
 * The limit is the helper's own, and it is deliberate: a credential whose name
 * ppr cannot see — `-H "Authorization: Bearer sk-…"` — survives here exactly as
 * `plugins.x.authorization` survives `config list`. Widening that belongs in
 * `SECRET_KEY`, where every caller gets it at once.
 */
export function redactCommand(argv: readonly string[]): string {
  return argv.map((word, i) => quoted(i === 0 ? word : hide(word, argv[i - 1]))).join(' ');
}

/** `--token=sk-…`, `X-Api-Key: sk-…` — a name and its value inside one word. */
const NAMED_VALUE = /^(-{0,2}[A-Za-z][A-Za-z0-9_-]*)([=:] ?)([\s\S]+)$/;

/** One argument, hidden when the word before it — or its own prefix — names a secret. */
function hide(word: string, previous: string | undefined): string {
  const inline = NAMED_VALUE.exec(word);
  // Reassembled from the parts, so a word that names nothing secret comes back
  // byte for byte: `https://example.com` is a name and a value too.
  if (inline) {
    const [, name = '', separator = '', value = ''] = inline;
    return `${name}${separator}${secretless(name, value)}`;
  }
  // A flag is a key and the word after it is its value — but a second flag is
  // the next key, not the value of the first.
  if (previous?.startsWith('-') && !word.startsWith('-')) return secretless(previous, word);
  return word;
}

const secretless = (name: string, value: string): string =>
  String(redactValue(name.replace(/^-+/, '').replace(/[-_]/g, '.'), value));

/**
 * Display only, and never shell source (there is no shell — see the header).
 * A title with a space in it must not read as two arguments in a plan, which
 * is the whole reason the plan prints the arguments at all.
 */
const quoted = (word: string): string =>
  word !== '' && !/\s/.test(word) ? word : word.includes("'") ? `"${word}"` : `'${word}'`;

export interface Notification {
  title: string;
  body: string;
}

/**
 * How much of a title survives a banner.
 *
 * Notifications truncate hard and without ceremony — a title runs to roughly
 * one line and a body to two, at a width nobody controls. So the notification
 * is built from the *items*, not from the brief's prose: a model writing three
 * sentences about a birthday produces something that reads well in a terminal
 * and turns into "Emily's birthday is on 20 Octo…" in a banner.
 */
const TITLE_WIDTH = 54;

/** The `ppr` mark, so a banner attributed to Script Editor is still legible. */
const MARK = 'ppr · ';

/**
 * The soonest thing, and a count of the rest.
 *
 * One item in the title is the whole design. A banner is read in the half
 * second it slides past, and a list of five squeezed into two lines is read as
 * none of them — whereas "call the dentist" plus "3 days overdue" is a thing
 * you act on. The count is there so the notification is not a lie about how
 * much is waiting, and `ppr brief` in a terminal is where the rest lives.
 *
 * Null when nothing is upcoming: see `announceBrief`.
 */
export function briefNotification(items: Upcoming[]): Notification | null {
  const [first, ...rest] = items;
  if (!first) return null;
  return {
    title: MARK + truncate(first.item.text, TITLE_WIDTH - MARK.length),
    body:
      `${formatDay(first.date)} — ${countdown(first.days)}` +
      (rest.length ? ` · ${rest.length} more` : ''),
  };
}

/**
 * Posts the brief, or explains why it did not.
 *
 * Nothing upcoming posts nothing. A daily "Nothing coming up" ping is how a
 * notification channel stops being read, and once it is ignored the one that
 * mattered is ignored with it — so silence is the feature, and stderr says so
 * for anyone reading a scheduled job's log.
 *
 * The title goes over as argv and never through a shell, so a note called
 * `; rm -rf ~` is a title and not an instruction (see the header).
 *
 * `env` is a parameter for the same reason it is one on `resolveIntent`,
 * `porcelainFor`, and `loadPorcelain`: everything this reads out of the
 * environment — which config file, which PATH, how deep in a chain of
 * ppr-started programs it already is — is an argument, so a test can say so
 * instead of reaching into the real `process.env` and hoping to put it back.
 */
export async function announceBrief(
  items: Upcoming[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const banner = briefNotification(items);
  if (!banner) return errline(color.dim('Nothing coming up — no notification sent.'));

  // No depth guard here, deliberately — see `handToReminders`, which has one.
  // L24 is about a *write* being reachable from a write it caused, and a brief
  // is a read: `hooks: { "entry.created": ["ppr brief --notify"] }` is a
  // reasonable thing to wire and it worked before bindings existed. A binding
  // that itself ran `ppr brief --notify` would loop, but so would `$EDITOR` set
  // to a script that opens `$EDITOR`, and refusing every hook-launched banner
  // to prevent it costs more than it saves.
  const target = await porcelainFor(NOTIFY_INTENT, env);
  if (!target.path) return errline(color.dim(missing(target)));

  const args = [...target.argv.slice(1), '--title', banner.title];
  const result = await runChild(target.path, {
    args,
    input: banner.body,
    // §6: a plan is what the command would have done, and "would run
    // /opt/my-notifier" is not that — the binding's own arguments and the title
    // are the half worth reading. `hooks.ts` names its event here for the same
    // reason.
    because: redactCommand([target.path, ...args]),
  });
  // A plugin that succeeded but had something to say — "not on this platform",
  // most often — has to be heard, or the user is told a banner was posted that
  // never was.
  if (result.said) errline(color.dim(result.said));
  else if (!result.ok) errline(color.dim(`No notification — ${result.hint}`));
}

/** Why a reminder was or was not handed over. */
export type PushDecision =
  | { push: true }
  | { push: false; reason: 'refused' | 'off' | 'undated' | 'unavailable' };

/**
 * Whether this reminder leaves the vault.
 *
 * Pure, and the only place that decides — so `ppr remind` and the quoted
 * `ppr "remind me …"` form cannot answer differently (L18): both reach it
 * through one call in `remind()`.
 *
 * The order is what the reasons mean. `--no-push` is an instruction and wins
 * outright. A line with no readable day is never pushed however loudly it was
 * asked for: the entry is a todo, and there is no moment for anything over
 * there to ring at. Only then does it matter whether the tool exists — which is what
 * keeps `--push` with no plugin installed an explanation rather than a
 * silence. That last check used to be `platform === 'darwin'`; it is now "is
 * there a program that does this", which is the same question asked without ppr
 * having to know the answer for every operating system there is.
 */
export function pushDecision(opts: {
  /** `remind.push` in config. */
  configured: boolean;
  /** `--push` / `--no-push`, undefined when neither was typed. */
  asked?: boolean;
  /** Whether a day was found, so the entry is a reminder and not a log. */
  dated: boolean;
  /** Whether the intent resolves to something runnable. */
  available: boolean;
}): PushDecision {
  if (opts.asked === false) return { push: false, reason: 'refused' };
  if (!opts.asked && !opts.configured) return { push: false, reason: 'off' };
  if (!opts.dated) return { push: false, reason: 'undated' };
  if (!opts.available) return { push: false, reason: 'unavailable' };
  return { push: true };
}

/**
 * Whether `ppr remind --push` has anything to push with.
 *
 * Reading a binding is I/O and `pushDecision` is pure, so the resolution is
 * done once — `await porcelainFor(PUSH_INTENT)` in `remind()` — and both the
 * decision and the spawn read that one `Target`. This predicate stays
 * synchronous because it is the question, not the lookup: an async `canPush()`
 * that resolved the intent a second time would be a second answer waiting to
 * disagree with the one that actually ran.
 */
export const canPush = (target: Target): boolean => target.path !== null;

/**
 * Hands a saved reminder to whatever answers the `reminders-push` intent.
 *
 * Called *after* the write, and it cannot undo one: whatever happens here, the
 * markdown is on disk and the entry stands. What goes down the pipe is the
 * `entry.created` event, in exactly the shape a hook on `entry.created` would
 * receive — so the flag, a binding, and the hook are three doors into one
 * contract, and there is one serializer behind all of them.
 *
 * The target is passed in rather than resolved here so that the reason the
 * decision gave and the program that runs come from the same lookup.
 */
export async function handToReminders(
  vault: Vault,
  entry: Entry,
  decision: PushDecision,
  target: Target,
): Promise<void> {
  if (!decision.push) {
    // The other reasons are already obvious from what the user typed; this one
    // is not, and an explicit `--push` deserves an answer.
    if (decision.reason === 'unavailable') {
      errline(color.dim(`  ${missing(target)} The entry is in your vault.`));
    }
    return;
  }
  if (!target.path) return;

  // ppr fans out once, from the command a person ran (L24). This is the path
  // that cascade is easiest to build by accident: `porcelain.reminders-push`
  // bound to a `ppr` that logs the reminder into a second vault writes an
  // entry, and `remind.push` is a user-layer setting that applies to that vault
  // too, so the write pushes again — a process per generation, forever. A hook
  // wired the same way is stopped by `hookRunner`; a binding was not.
  if (childDepth()) {
    return errline(color.dim('  → not handed over — ppr fans out once, from the command you ran.'));
  }

  const event = vaultEvent({ event: 'entry.created', entry }, { vault: vault.root, now: vault.now() });
  const args = target.argv.slice(1);
  const result = await runChild(target.path, {
    args,
    input: `${JSON.stringify(eventJson(event))}\n`,
    env: { PPR_EVENT: event.event, PPR_VAULT: event.vault },
    // What would run, rather than the program it starts with (§6).
    because: redactCommand([target.path, ...args]),
  });
  // Whatever the plugin said, it said with its own name on the front, so it
  // stands on its own — that is the line the user needs when the copy did not
  // happen and the exit code was 0 anyway.
  if (result.said) return errline(color.dim(`  ${result.said}`));
  // Redacted, because this line is printed on every single push and a binding
  // is the config value most likely to carry a token (I7).
  const said = redactCommand(target.argv);
  errline(result.ok ? color.dim(`  → ${said}`) : color.dim(`  → ${said} declined — ${result.hint}`));
}

/**
 * What to say when an intent resolves to nothing.
 *
 * Two different sentences, because they are two different mistakes. Nothing
 * configured and nothing on PATH names the program the convention wants, which
 * is the thing the user can act on: write one, install ppr's, or bind the
 * intent. A binding whose program is not there is a typo in a file, and saying
 * *which* file and *which* word is the difference between a five-second fix and
 * an evening wondering why a flag went quiet.
 *
 * Quoting the binding back is the useful half of that, and an error message is
 * one of the three places I7 names — so what comes back is `redactCommand`'s
 * version. A token pasted into a binding would otherwise reach stderr on a day
 * when something is already going wrong, which is exactly when output gets
 * pasted into a bug report.
 */
export function missing(target: Target): string {
  if (target.bound) {
    return (
      `porcelain.${target.intent} is set to \`${redactCommand(target.argv)}\`, ` +
      `and there is nothing called ${target.argv[0] ?? ''} to run — ` +
      `check ${globalConfigPath()}.`
    );
  }
  return `Nothing called ${target.name} on your PATH — ppr ships one, or write your own.`;
}
