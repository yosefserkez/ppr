import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeviceList, responsibleApp } from '../dist/node.js';

/** Real output from `ffmpeg -f avfoundation -list_devices true -i ""`. */
const FFMPEG_OUTPUT = `[AVFoundation indev @ 0x899038140] AVFoundation video devices:
[AVFoundation indev @ 0x899038140] [0] MacBook Pro Camera
[AVFoundation indev @ 0x899038140] [1] Capture screen 0
[AVFoundation indev @ 0x899038140] AVFoundation audio devices:
[AVFoundation indev @ 0x899038140] [0] ZoomAudioDevice
[AVFoundation indev @ 0x899038140] [1] MacBook Pro Microphone
[in#0 @ 0x899038000] Error opening input: Input/output error`;

test('audio devices are read without picking up the cameras', () => {
  const devices = parseDeviceList(FFMPEG_OUTPUT);
  assert.deepEqual(
    devices.map((d) => d.name),
    ['ZoomAudioDevice', 'MacBook Pro Microphone'],
  );
  assert.deepEqual(devices.map((d) => d.id), ['0', '1']);
});

test('virtual devices are flagged, because they record perfect silence', () => {
  // This is the whole bug: Zoom installs a virtual input, it sorts to index 0,
  // and anything recording from "device 0" captures nothing, forever.
  const [zoom, mic] = parseDeviceList(FFMPEG_OUTPUT);
  assert.equal(zoom.virtual, true);
  assert.equal(mic.virtual, false);
});

test('the usual suspects are all recognised as virtual', () => {
  const names = ['BlackHole 2ch', 'Loopback Audio', 'Krisp Microphone', 'OBS Virtual Camera'];
  const output = [
    'AVFoundation audio devices:',
    ...names.map((name, i) => `[AVFoundation indev @ 0x1] [${i}] ${name}`),
  ].join('\n');
  assert.ok(parseDeviceList(output).every((d) => d.virtual));
});

test('output with no audio section yields nothing rather than throwing', () => {
  assert.deepEqual(parseDeviceList('AVFoundation video devices:\n[0] Some Camera'), []);
  assert.deepEqual(parseDeviceList(''), []);
});

test('the responsible app is named from the terminal, for a clearer message', () => {
  assert.equal(responsibleApp({ TERM_PROGRAM: 'Apple_Terminal' }), 'Terminal');
  assert.equal(responsibleApp({ TERM_PROGRAM: 'ghostty' }), 'Ghostty');
  assert.equal(responsibleApp({ TERM_PROGRAM: 'vscode' }), 'Visual Studio Code');
  assert.equal(responsibleApp({ TERM_PROGRAM: 'Something New' }), 'Something New');
  assert.equal(responsibleApp({}), 'your terminal');
});
