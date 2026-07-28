/** Typed errors so the CLI can map failures to exit codes and useful hints. */

export type PprErrorCode =
  | 'ENOVAULT'
  | 'ENOTFOUND'
  | 'EAMBIGUOUS'
  | 'EINVALID'
  | 'ENOAI'
  | 'EAI'
  | 'ENETWORK'
  | 'ECONFIG'
  | 'EEXTERNAL';

export class PprError extends Error {
  readonly code: PprErrorCode;
  /** A short, actionable next step shown under the error message. */
  readonly hint?: string;

  constructor(code: PprErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'PprError';
    this.code = code;
    this.hint = hint;
  }
}

export const noVault = (dir: string) =>
  new PprError('ENOVAULT', `No ppr vault at ${dir}`, `Run \`ppr init\` to create one.`);

export const notFound = (what: string) => new PprError('ENOTFOUND', `No entry matching "${what}"`);

export const ambiguous = (what: string, ids: string[]) =>
  new PprError(
    'EAMBIGUOUS',
    `"${what}" matches ${ids.length} entries`,
    `Be more specific: ${ids.slice(0, 5).join(', ')}`,
  );

export const invalid = (message: string, hint?: string) => new PprError('EINVALID', message, hint);

export const noAI = () =>
  new PprError(
    'ENOAI',
    'No AI provider configured',
    'Run `ppr ai setup` to pick one, or re-run with --no-ai to use offline heuristics.',
  );
