import { spawn } from 'node:child_process';
import { PprError } from '../errors.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Thin promise wrapper over spawn. No shell unless explicitly asked for. */
export function run(
  command: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number; signal?: AbortSignal; shell?: boolean; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: opts.shell ?? false,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
      : undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new PprError('EEXTERNAL', `Command not found: ${command}`)
          : err,
      );
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function which(command: string): Promise<string | null> {
  try {
    const { code, stdout } = await run(process.platform === 'win32' ? 'where' : 'which', [command]);
    return code === 0 ? stdout.trim().split('\n')[0]! : null;
  } catch {
    return null;
  }
}
