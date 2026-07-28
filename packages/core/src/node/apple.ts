import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AIConfig } from '../config.js';
import { PprError } from '../errors.js';
import type { AIProvider } from '../ports.js';
import { run, which } from './exec.js';

/**
 * Apple's on-device Foundation Models, reached through a tiny Swift shim that
 * ppr compiles once and caches.
 *
 * No key, no account, no network — the strongest version of "bring your own
 * model" on a Mac. Requires macOS 26+ with Apple Intelligence enabled.
 */
const SHIM_SOURCE = `import Foundation
import FoundationModels

let args = CommandLine.arguments
func flag(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let prompt = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
let instructions = flag("--system")
let temperature = Double(flag("--temperature") ?? "") ?? 0.2
let maxTokens = Int(flag("--max-tokens") ?? "") ?? 1024

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\\n").utf8))
    exit(code)
}

if #available(macOS 26.0, *) {
    let model = SystemLanguageModel.default
    switch model.availability {
    case .available: break
    case .unavailable(let reason):
        fail("Apple Intelligence unavailable: \\(reason)", 3)
    @unknown default:
        fail("Apple Intelligence unavailable", 3)
    }

    let session = instructions.map { LanguageModelSession(instructions: $0) } ?? LanguageModelSession()
    let options = GenerationOptions(temperature: temperature, maximumResponseTokens: maxTokens)
    do {
        let response = try await session.respond(to: prompt, options: options)
        print(response.content)
    } catch {
        fail("Generation failed: \\(error)", 4)
    }
} else {
    fail("Requires macOS 26 or later", 3)
}
`;

const cacheDir = (): string =>
  join(process.env.XDG_CACHE_HOME || join(process.env.HOME || homedir(), '.cache'), 'ppr');

const BINARY = 'ppr-afm';

async function isFresh(binPath: string, sourcePath: string): Promise<boolean> {
  const [bin, src] = await Promise.all([stat(binPath).catch(() => null), stat(sourcePath).catch(() => null)]);
  return Boolean(bin && src && bin.mtimeMs >= src.mtimeMs);
}

/** Compiles the shim on first use. Subsequent calls just exec the binary. */
export async function ensureAppleShim(): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new PprError('EEXTERNAL', 'The apple provider only runs on macOS');
  }
  const dir = cacheDir();
  const sourcePath = join(dir, 'ppr-afm.swift');
  const binPath = join(dir, BINARY);

  await mkdir(dir, { recursive: true });
  await writeFile(sourcePath, SHIM_SOURCE);
  if (await isFresh(binPath, sourcePath)) return binPath;

  if (!(await which('swiftc'))) {
    throw new PprError(
      'EEXTERNAL',
      'swiftc not found, so the on-device Apple model cannot be reached',
      'Install Xcode command line tools: xcode-select --install',
    );
  }

  const { code, stderr } = await run('swiftc', ['-O', '-o', binPath, sourcePath], {
    timeoutMs: 180_000,
  });
  if (code !== 0) {
    throw new PprError(
      'EEXTERNAL',
      `Could not build the Apple Foundation Models helper:\n${stderr.trim().slice(0, 600)}`,
      'This needs macOS 26+ with the matching SDK. Try `ppr ai set provider ollama` instead.',
    );
  }
  return binPath;
}

export function appleProvider(ai: AIConfig): AIProvider {
  let binPath: Promise<string> | undefined;

  return {
    id: 'apple',
    model: ai.model || 'apple-on-device',
    local: true,
    async generate(req) {
      binPath ??= ensureAppleShim();
      const bin = await binPath;
      const args = [
        '--temperature',
        String(req.temperature ?? ai.temperature),
        '--max-tokens',
        String(req.maxTokens ?? ai.maxTokens),
      ];
      if (req.system) args.push('--system', req.system);
      // The on-device model has no JSON mode; ask for it in the prompt instead.
      const prompt = req.json ? `${req.prompt}\n\nRespond with JSON only. No prose, no code fences.` : req.prompt;

      const { code, stdout, stderr } = await run(bin, args, {
        input: prompt,
        timeoutMs: 120_000,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      if (code !== 0) {
        throw new PprError(
          'EAI',
          stderr.trim() || `Apple model exited with code ${code}`,
          code === 3 ? 'Enable Apple Intelligence in System Settings, or pick another provider.' : undefined,
        );
      }
      return stdout.trim();
    },
  };
}
