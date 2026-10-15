import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../addon/app/modal-device.js', import.meta.url), 'utf8');

function cameraView({ enabled, userAgent, portrait, fullscreen = true, platform, maxTouchPoints,
  coarse = false, screenWidth = 390, screenHeight = 844, companionApp = false } = {}) {
  const classes = new Set();
  const frame = {
    id: 'camera-live-frame',
    classList: {
      toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
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
  vm.runInContext(`globalThis._settings = { camera_force_landscape_mobile: ${enabled} }; syncLiveCameraFullscreen()`, scope);
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

test('enabled mobile mode uses the page fullscreen layout instead of native fullscreen', async () => {
  const classes = new Set();
  let nativeCalls = 0;
  const frame = {
    classList: { add(name) { classes.add(name); } },
    requestFullscreen() { nativeCalls++; return Promise.resolve(); },
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
  assert.equal(nativeCalls, 0);
  assert.equal(classes.has('is-fullscreen-fallback'), true);
});

test('disabled mode still requests native fullscreen', async () => {
  let nativeCalls = 0;
  const frame = {
    classList: { add() { throw new Error('unexpected fallback'); } },
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
