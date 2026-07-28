import { PprError } from '../errors.js';
import { run, which } from './exec.js';
import { ensureSwiftHelper } from './swift.js';

/**
 * Input devices and microphone permission.
 *
 * Both of the ways a recording comes back silent live here. The common one is
 * not permission at all: macOS lists virtual audio devices (Zoom, Loopback,
 * BlackHole) alongside real ones, they frequently sort first, and recording
 * from one produces a perfect, permanent silence. The other is TCC, where the
 * only honest answer is to ask the system.
 */

export interface AudioDevice {
  /** avfoundation index, or `default` for the system's choice. */
  id: string;
  name: string;
  /** Virtual devices capture nothing unless their app is running. */
  virtual: boolean;
  isDefault: boolean;
}

/** Names that mean "this is not a microphone". */
const VIRTUAL_HINTS =
  /zoom|blackhole|loopback|soundflower|virtual|aggregate|multi-output|obs|teams|discord|krisp|voicemeeter/i;

/**
 * Lists macOS audio inputs by parsing ffmpeg's device dump.
 *
 * ffmpeg prints the list and then exits non-zero because no input was given —
 * that is expected, not a failure.
 */
export async function listInputDevices(): Promise<AudioDevice[]> {
  if (process.platform !== 'darwin') return [];
  if (!(await which('ffmpeg'))) return [];

  const { stderr } = await run(
    'ffmpeg',
    ['-nostdin', '-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    { timeoutMs: 15_000 },
  );
  return parseDeviceList(stderr);
}

/** Pure, so the parsing is tested without an ffmpeg on the machine. */
export function parseDeviceList(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let inAudio = false;

  for (const line of output.split('\n')) {
    if (/AVFoundation audio devices:/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (/AVFoundation video devices:/i.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;

    const match = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    devices.push({
      id: match[1]!,
      name: match[2]!,
      virtual: VIRTUAL_HINTS.test(match[2]!),
      isDefault: false,
    });
  }
  return devices;
}

/**
 * The device ppr should record from when the user has not chosen one.
 *
 * `default` follows the system setting, which is what someone means by "my
 * microphone" — and crucially it is not index 0, which is wherever a virtual
 * device happened to land.
 */
export const DEFAULT_DEVICE = 'default';

export type MicPermission = 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown';

const MIC_HELPER_SOURCE = `import AVFoundation
import Foundation

func label(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted:    return "restricted"
    case .denied:        return "denied"
    case .authorized:    return "authorized"
    @unknown default:    return "unknown"
    }
}

let status = AVCaptureDevice.authorizationStatus(for: .audio)

// --request only means anything while the decision is still open; once denied,
// only the user can change it in System Settings.
if CommandLine.arguments.contains("--request"), status == .notDetermined {
    let gate = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { ok in
        granted = ok
        gate.signal()
    }
    _ = gate.wait(timeout: .now() + 120)
    print(granted ? "authorized" : "denied")
} else {
    print(label(status))
}
`;

const micHelper = () =>
  ensureSwiftHelper({
    name: 'ppr-mic',
    source: MIC_HELPER_SOURCE,
    args: ['-framework', 'AVFoundation'],
    purpose: 'checking microphone permission',
  });

async function askHelper(request: boolean): Promise<MicPermission> {
  const binary = await micHelper();
  const { code, stdout } = await run(binary, request ? ['--request'] : [], { timeoutMs: 150_000 });
  if (code !== 0) return 'unknown';
  const known: MicPermission[] = ['authorized', 'denied', 'restricted', 'notDetermined'];
  const answer = stdout.trim() as MicPermission;
  return known.includes(answer) ? answer : 'unknown';
}

/** Current permission, without prompting. Non-macOS platforms cannot say. */
export async function micPermission(): Promise<MicPermission> {
  if (process.platform !== 'darwin') return 'unknown';
  try {
    return await askHelper(false);
  } catch {
    return 'unknown';
  }
}

/**
 * Triggers the system prompt when the decision is still open.
 *
 * macOS attributes the prompt to the app responsible for the process — your
 * terminal — so that is what appears in the dialog and in System Settings
 * afterwards. Once denied, no prompt can be raised again from here; the only
 * route is Settings, which `openMicSettings` opens directly.
 */
export async function requestMicPermission(): Promise<MicPermission> {
  if (process.platform !== 'darwin') return 'unknown';
  return askHelper(true);
}

const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

export async function openMicSettings(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const { code } = await run('open', [SETTINGS_URL], { timeoutMs: 10_000 });
  return code === 0;
}

/** The app macOS holds responsible for a terminal process, for clearer messages. */
export function responsibleApp(env: NodeJS.ProcessEnv = process.env): string {
  const program = env.TERM_PROGRAM ?? '';
  const known: Record<string, string> = {
    Apple_Terminal: 'Terminal',
    iTerm: 'iTerm',
    'iTerm.app': 'iTerm',
    ghostty: 'Ghostty',
    WarpTerminal: 'Warp',
    vscode: 'Visual Studio Code',
    Hyper: 'Hyper',
    WezTerm: 'WezTerm',
    kitty: 'kitty',
    alacritty: 'Alacritty',
  };
  return known[program] ?? (program || 'your terminal');
}

export const micPermissionError = (): PprError =>
  new PprError(
    'EEXTERNAL',
    'Microphone access is denied',
    `Allow ${responsibleApp()} in System Settings › Privacy & Security › Microphone, then try again.`,
  );
