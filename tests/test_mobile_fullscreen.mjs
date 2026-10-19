import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../addon/app/modal-device.js', import.meta.url), 'utf8');

function cameraView({ enabled, mode, recording = false, userAgent, portrait, fullscreen = true, platform, maxTouchPoints,
  coarse = false, screenWidth = 390, screenHeight = 844, companionApp = false } = {}) {
  const classes = new Set();
  const frame = {
    id: recording ? 'recordings-frame' : 'camera-live-frame',
    classList: {
      toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
  };
  const button = { setAttribute() {} };
  const document = {
    fullscreenElement: fullscreen ? frame : null,
    getElementById(id) { return id === frame.id ? frame : id === 'camera-live-fullscreen' ? button : null; },
    addEventListener() {},
  };
  const window = {
    matchMedia(query) { return { matches: query === '(pointer: coarse)' ? coarse : portrait }; },
    screen: { width: screenWidth, height: screenHeight },
    externalApp: companionApp ? {} : undefined,
    addEventListener() {},
  };
  const scope = vm.createContext({ document, window, navigator: { userAgent, platform, maxTouchPoints } });
  vm.runInContext(source, scope);
  scope._settings = { camera_force_landscape_mobile: enabled, camera_fullscreen_rotation: mode };
  if (recording) vm.runInContext(readFileSync(new URL('../addon/app/recordings.js', import.meta.url), 'utf8'), scope);
  vm.runInContext(recording ? 'syncRecordingFullscreen()' : 'syncLiveCameraFullscreen()', scope);
  if (mode) return { rotated: classes.has('is-landscape-rotated'), clockwise: classes.has('is-rotation-clockwise') };
  return classes.has('is-landscape-rotated');
}

test('force landscape rotates only fullscreen portrait mobile clients when enabled', () => {
  assert.equal(cameraView({ enabled: true, userAgent: 'iPhone', portrait: true }), true);
  assert.equal(cameraView({ enabled: false, userAgent: 'iPhone', portrait: true }), false);
  assert.equal(cameraView({ enabled: true, userAgent: 'iPhone', portrait: false }), false);
  assert.equal(cameraView({ enabled: true, userAgent: 'Windows', portrait: true }), false);
  assert.equal(cameraView({ enabled: true, userAgent: 'iPhone', portrait: true, fullscreen: false }), false);
  assert.equal(cameraView({ enabled: true, userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5, portrait: true }), true);
  assert.equal(cameraView({ enabled: true, userAgent: 'Desktop', portrait: true, companionApp: true }), true);
  assert.equal(cameraView({ enabled: true, userAgent: 'Desktop', portrait: true, maxTouchPoints: 5, coarse: true }), true);
  assert.equal(cameraView({ enabled: true, userAgent: 'Desktop', portrait: true, maxTouchPoints: 5,
    coarse: true, screenWidth: 1440, screenHeight: 900 }), false);
});

test('enabled mobile rotation requests native fullscreen instead of forcing the page fallback', async () => {
  const classes = new Set();
  let nativeCalls = 0;
  const frame = {
    classList: { add(name) { classes.add(name); }, contains(name) { return classes.has(name); } },
    requestFullscreen(options) { nativeCalls++; assert.equal(options.navigationUI, 'hide'); return Promise.resolve(); },
  };
  const scope = vm.createContext({
    document: { addEventListener() {} },
    window: { externalApp: {}, addEventListener() {} },
    navigator: { userAgent: 'Desktop' },
    frame,
  });
  vm.runInContext(source, scope);
  vm.runInContext('globalThis._settings = { camera_force_landscape_mobile: true }', scope);
  await vm.runInContext('enterLiveCameraFullscreen(frame)', scope);
  assert.equal(nativeCalls, 1);
  assert.equal(classes.has('is-fullscreen-fallback'), false);
});

test('disabled mode still requests native fullscreen', async () => {
  let nativeCalls = 0;
  const frame = {
    classList: { add() { throw new Error('unexpected fallback'); }, contains() { return false; } },
    requestFullscreen() { nativeCalls++; return Promise.resolve(); },
  };
  const scope = vm.createContext({
    document: { addEventListener() {} },
    window: { externalApp: {}, addEventListener() {} },
    navigator: { userAgent: 'Desktop' },
    frame,
  });
  vm.runInContext(source, scope);
  vm.runInContext('globalThis._settings = { camera_force_landscape_mobile: false }', scope);
  await vm.runInContext('enterLiveCameraFullscreen(frame)', scope);
  assert.equal(nativeCalls, 1);
});

for (const recording of [false, true]) {
  for (const mode of ['off', 'clockwise', 'counterclockwise']) {
    test(`${recording ? 'recordings' : 'live'} fullscreen respects ${mode} rotation and orientation`, () => {
      const options = { mode, recording, userAgent: 'Android', portrait: true };
      assert.deepEqual(cameraView(options), { rotated: mode !== 'off', clockwise: mode === 'clockwise' });
      assert.deepEqual(cameraView({ ...options, portrait: false }), { rotated: false, clockwise: false });
      assert.deepEqual(cameraView({ ...options, fullscreen: false }), { rotated: false, clockwise: false });
    });
  }
}

for (const target of ['live', 'recordings']) test(`${target} enters and exits native fullscreen with rotation enabled`, async () => {
  const classes = new Set();
  const frame = {
    id: target === 'live' ? 'camera-live-frame' : 'recordings-frame',
    classList: {
      add(name) { classes.add(name); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    querySelector: () => null,
    async requestFullscreen(options) { assert.equal(options.navigationUI, 'hide'); document.fullscreenElement = frame; },
  };
  const document = {
    fullscreenElement: null, addEventListener() {},
    getElementById: id => id === frame.id ? frame : null,
    async exitFullscreen() { document.fullscreenElement = null; },
  };
  const scope = vm.createContext({
    document, frame, _settings: { camera_fullscreen_rotation: 'clockwise' },
    navigator: { userAgent: 'Android' },
    window: { addEventListener() {}, matchMedia: () => ({ matches: true }) },
  });
  vm.runInContext(source, scope);
  vm.runInContext(readFileSync(new URL('../addon/app/recordings.js', import.meta.url), 'utf8'), scope);
  await vm.runInContext(target === 'live' ? 'enterLiveCameraFullscreen(frame);' : 'toggleRecordingFullscreen()', scope);
  if (target === 'live') vm.runInContext('syncLiveCameraFullscreen()', scope);
  assert.equal(document.fullscreenElement, frame);
  assert.equal(classes.has('is-landscape-rotated'), true);
  assert.equal(classes.has('is-rotation-clockwise'), true);
  assert.equal(classes.has('is-fullscreen-fallback'), false);
  await vm.runInContext(target === 'live' ? 'exitLiveCameraFullscreen()' : 'toggleRecordingFullscreen()', scope);
  assert.equal(document.fullscreenElement, null);
  assert.equal(classes.has('is-landscape-rotated'), false);
  assert.equal(classes.has('is-video-fullscreen'), false);
});

for (const nativeVideo of [false, true]) test(`rejected container fullscreen tries native video before viewport fallback (native video=${nativeVideo})`, async () => {
  let videoCalls = 0;
  const classes = new Set();
  const video = nativeVideo ? { webkitEnterFullscreen() { videoCalls++; } } : {};
  const frame = {
    classList: { add(name) { classes.add(name); } }, querySelector: () => video,
    async requestFullscreen() { throw new Error('Unsupported'); },
  };
  const scope = vm.createContext({ document: { addEventListener() {} }, window: { addEventListener() {} }, frame });
  vm.runInContext(source, scope);
  await vm.runInContext('enterCameraFullscreen(frame)', scope);
  assert.equal(videoCalls, nativeVideo ? 1 : 0);
  assert.equal(classes.has('is-fullscreen-fallback'), !nativeVideo);
});

for (const mode of ['off', 'clockwise', 'counterclockwise']) test(`video settings save ${mode} and refresh both players`, async () => {
  const elements = new Map();
  let saved, liveUpdates = 0, recordingUpdates = 0;
  const scope = vm.createContext({
    document: { getElementById(id) {
      if (id === 'btn-save-camera') return null;
      if (!elements.has(id)) elements.set(id, { value: id === 's-camera-fullscreen-rotation' ? mode : '', checkValidity: () => true });
      return elements.get(id);
    } },
    _settings: {}, _lastDeviceRenderKey: '',
    api: async (method, path, body) => { assert.equal(path, '/api/settings'); saved = body; return body; },
    applyTabVisibility() {}, syncBackgroundCameras() {}, renderDevices() {},
    syncLiveCameraFullscreen() { liveUpdates++; },
    syncRecordingFullscreen() { recordingUpdates++; },
    alert(message) { assert.fail(message); }, t: (key, values) => values?.error || key,
  });
  vm.runInContext(readFileSync(new URL('../addon/app/settings.js', import.meta.url), 'utf8'), scope);
  scope.applyTabVisibility = () => {};
  await vm.runInContext('saveSettings("camera")', scope);
  assert.equal(saved.camera_fullscreen_rotation, mode);
  assert.equal(liveUpdates, 1);
  assert.equal(recordingUpdates, 1);
});

test('a transient visibility change during fullscreen keeps the live connection', () => {
  const timers = new Map();
  let nextTimer = 0;
  const document = { hidden: true, addEventListener() {}, getElementById() { return null; } };
  const scope = vm.createContext({
    document,
    window: { addEventListener() {} },
    setTimeout(callback, delay) { assert.equal(delay, 2000); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source, scope);
  vm.runInContext('globalThis.stops = 0; stopLiveCamera = () => stops++; stopCameraTalk = () => stops++', scope);

  vm.runInContext('handleCameraVisibilityChange()', scope);
  assert.equal(timers.size, 1);
  document.hidden = false;
  vm.runInContext('handleCameraVisibilityChange()', scope);
  assert.equal(timers.size, 0);
  assert.equal(vm.runInContext('stops', scope), 0);

  document.hidden = true;
  vm.runInContext('handleCameraVisibilityChange()', scope);
  [...timers.values()][0]();
  assert.equal(vm.runInContext('stops', scope), 2);
});
