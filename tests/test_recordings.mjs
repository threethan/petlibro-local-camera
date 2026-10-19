import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function context(zone = 'America/New_York') {
  const scope = vm.createContext({
    Intl, Date, URLSearchParams, AbortController, setTimeout, clearTimeout, Blob, TextEncoder,
    _settings: { feeder_timezone: zone }, _devices: [],
    t: key => key, window: { addEventListener() {} }, document: { addEventListener() {} },
  });
  vm.runInContext(readFileSync(new URL('../addon/app/recordings.js', import.meta.url), 'utf8'), scope);
  return scope;
}

test('recording player accepts AAC and preserves sound when autoplay needs a tap', async () => {
  const scope = context();
  const types = [];
  class MediaSource {
    static isTypeSupported(type) { types.push(type); return true; }
    addEventListener() {}
    removeEventListener() {}
  }
  const video = {
    play: () => Promise.reject(Object.assign(new Error('Tap required'), { name: 'NotAllowedError' })),
    pause() {}, removeAttribute() {}, load() {}, remove() {},
  };
  let failures = 0;
  Object.assign(scope, {
    MediaSource,
    URL: { createObjectURL: () => 'blob:recording', revokeObjectURL() {} },
    callbacks: { onReady() {}, onEnd() { failures++; } },
  });
  scope.window.MediaSource = MediaSource;
  scope.document.createElement = () => video;
  scope.document.getElementById = () => ({ prepend() {} });
  const player = vm.runInContext(`openRecordingPlayer('/video.mp4', callbacks)`, scope);
  try {
    assert.match(types[0], /mp4a\.40\.2/);
    assert.equal(video.muted, false);
    video.onloadeddata();
    await Promise.resolve();
    assert.equal(video.controls, true);
    assert.equal(failures, 0);
  } finally { player.close(); }
});

test('calendar days follow feeder timezone and daylight saving transitions', () => {
  const scope = context();
  for (const [date, hours, expected] of [
    ['2026-03-08', 23, '2026-03-08T05:00:00.000Z'],
    ['2026-11-01', 25, '2026-11-01T04:00:00.000Z'],
    ['2026-10-16', 24, '2026-10-16T04:00:00.000Z'],
  ]) {
    const range = vm.runInContext(`recordingDayRange('${date}')`, scope);
    assert.equal(range.end - range.start, hours * 3600);
    assert.equal(new Date(range.start * 1000).toISOString(), expected);
  }
  assert.equal(vm.runInContext(`recordingDate(Date.parse('2026-10-17T02:00:00Z') / 1000)`, scope), '2026-10-16');
  assert.equal(vm.runInContext(`recordingAdjacentDate('2026-12-31', 1)`, scope), '2027-01-01');
});

test('date boundaries also support zones east of UTC and half-hour offsets', () => {
  assert.equal(vm.runInContext(`recordingMidnight('2026-10-16')`, context('Asia/Tokyo')), Date.parse('2026-10-15T15:00:00Z') / 1000);
  assert.equal(vm.runInContext(`recordingMidnight('2026-10-16')`, context('America/St_Johns')), Date.parse('2026-10-16T02:30:00Z') / 1000);
});

test('filters use the Petlibro event enum and retain unknown events under All', () => {
  const scope = context();
  vm.runInContext(`_recordings.items = [{ event: 48 }, { event: 1 }, { event: 240 }, { event: 18 }, { event: 21 }]`, scope);
  for (const [filter, count] of [['all', 5], ['feeding', 1], ['motion', 1], ['sound', 1]]) {
    assert.equal(vm.runInContext(`_recordings.filter = '${filter}'; filteredRecordings().length`, scope), count);
  }
});

test('leaving the tab aborts listing, playback, and releases its power lease', () => {
  const scope = context();
  let aborted = 0, closed = 0, released = 0;
  Object.assign(scope, { releaseCameraPower: () => released++, updateRecordingControls: () => {} });
  scope.document.getElementById = id => id === 'recordings-selection-island' ? null : ({ hidden: false, textContent: '', classList: { remove() {} } });
  scope.controller = { abort() { aborted++; } };
  scope.player = { close() { closed++; } };
  vm.runInContext(`_recordings.abort = controller; _recordings.player = player; _recordings.power = { serial: 'feeder' }; setRecordingsTabActive(false)`, scope);
  assert.equal(aborted, 1);
  assert.equal(closed, 1);
  assert.equal(released, 1);
  assert.equal(vm.runInContext('_recordings.playing', scope), false);
});

test('ZIP preparation yields so cancellation prevents a completed archive', async () => {
  const scope = context();
  const controller = new AbortController();
  scope.files = [{ name: 'recording.mp4', blob: new Blob([new Uint8Array(4 * 1024 * 1024)]) }];
  scope.signal = controller.signal;
  scope.progress = fraction => { if (fraction > 0) setTimeout(() => controller.abort(), 0); };
  await assert.rejects(vm.runInContext('recordingZip(files, { signal, onProgress: progress })', scope), { name: 'AbortError' });
});

function availabilityElements(scope) {
  const elements = new Map();
  scope.document.getElementById = id => {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, hidden: false, textContent: '', innerHTML: '',
      classList: { toggle(name, enabled) { this[name] = enabled; } },
    });
    return elements.get(id);
  };
  scope.noSdCardDetected = device => device.sdCardState === 0 || device.sdCardState === '0';
  return id => scope.document.getElementById(id);
}

test('availability explains missing cameras and cards, then restores the recording controls', () => {
  const scope = context();
  const element = availabilityElements(scope);
  vm.runInContext('updateRecordingAvailability(undefined)', scope);
  assert.equal(element('recordings-availability').textContent, 'recordings.no_devices');
  assert.equal(element('recordings-content').hidden, true);
  assert.equal(element('recordings-device-label').hidden, true);
  assert.equal(element('recordings-heading').classList['sr-only'], false);
  for (const state of [0, '0']) {
    scope.device = { online: true, sdCardState: state, sdCardTotalCapacity: 2048, sdCardUsedCapacity: 1024 };
    vm.runInContext('updateRecordingAvailability(device)', scope);
    assert.equal(element('recordings-availability').textContent, 'recordings.no_card');
    assert.equal(element('recordings-content').hidden, true);
    assert.equal(element('recordings-device-label').hidden, false);
    assert.equal(element('recordings-storage').textContent, '');
  }
  scope.device.sdCardState = 1;
  vm.runInContext('updateRecordingAvailability(device)', scope);
  assert.equal(element('recordings-availability').hidden, true);
  assert.equal(element('recordings-content').hidden, false);
  assert.equal(element('recordings-storage').textContent, '1.0 / 2.0 GB');
  assert.equal(element('recordings-heading').classList['sr-only'], true);
  scope.device.online = false;
  vm.runInContext('updateRecordingAvailability(device)', scope);
  assert.equal(element('recordings-availability').textContent, 'recordings.offline');
  assert.equal(element('recordings-content').hidden, true);
});

test('device dropdown includes only camera feeders and handles removal of the last camera', () => {
  const scope = context();
  const element = availabilityElements(scope);
  Object.assign(scope, {
    escHtml: value => value, leaveRecordingsDevice() {}, loadRecordings() {}, renderRecordingList() {},
    _devices: [
      { serial: 'fountain', name: 'Fountain', device_type: 'fountain' },
      { serial: 'camera', name: 'Kitchen camera', device_type: 'camera_feeder', online: true, sdCardState: 1 },
      { serial: 'feeder', name: 'Feeder', device_type: 'granary' },
    ],
  });
  vm.runInContext('_recordings.active = true; syncRecordingsDevices()', scope);
  assert.equal(element('recordings-device').innerHTML, '<option value="camera">Kitchen camera</option>');
  assert.equal(element('recordings-device').value, 'camera');
  scope._devices = scope._devices.filter(device => device.serial !== 'camera');
  vm.runInContext('syncRecordingsDevices()', scope);
  assert.equal(element('recordings-device').innerHTML, '');
  assert.equal(element('recordings-availability').textContent, 'recordings.no_devices');
  assert.equal(element('recordings-content').hidden, true);
});
