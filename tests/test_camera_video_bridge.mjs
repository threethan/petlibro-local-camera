import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('remote camera bridge plays MP4 video and closes its ingress request', async () => {
  const requests = [];
  const appended = [];
  const revoked = [];
  let source;
  class FakeSource extends EventTarget {
    static isTypeSupported(type) { return type.includes('avc1.42C01F'); }
    readyState = 'closed';
    constructor() { super(); source = this; }
    addSourceBuffer(type) {
      assert.match(type, /video\/mp4/);
      assert.match(type, /mp4a\.40\.2/);
      const buffer = new EventTarget();
      buffer.buffered = { length: 0 };
      buffer.appendBuffer = bytes => { appended.push(bytes); queueMicrotask(() => buffer.dispatchEvent(new Event('updateend'))); };
      return buffer;
    }
  }
  let video;
  const document = { createElement(tag) {
    assert.equal(tag, 'video');
    video = { style: {}, play: async () => {}, pause() {}, removeAttribute() {}, load() {}, remove() { this.removed = true; } };
    return video;
  } };
  const frame = { prepend(element) { assert.equal(element, video); } };
  let finishRead;
  const reader = {
    reads: 0,
    read() {
      if (!this.reads++) return Promise.resolve({ value: new Uint8Array([1, 2, 3]), done: false });
      return new Promise(resolve => { finishRead = resolve; });
    },
    async cancel() { this.cancelled = true; finishRead?.({ done: true }); },
  };
  const scope = vm.createContext({
    window: { MediaSource: FakeSource, addEventListener() {} }, MediaSource: FakeSource, document, frame,
    BASE: '/ingress', AbortController, setTimeout, clearTimeout,
    URL: { createObjectURL: () => 'blob:camera', revokeObjectURL: url => revoked.push(url) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, body: { getReader: () => reader } };
    },
  });
  vm.runInContext(readFileSync(new URL('../addon/app/modal-device.js', import.meta.url), 'utf8'), scope);
  const bridge = vm.runInContext('openLiveCameraVideoBridge("serial / one", frame, () => {})', scope);
  source.readyState = 'open';
  source.dispatchEvent(new Event('sourceopen'));
  for (let i = 0; i < 10 && !appended.length; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests[0].url, '/ingress/api/devices/serial%20%2F%20one/camera/live.mp4');
  assert.deepEqual([...appended[0]], [1, 2, 3]);
  video.onloadeddata();
  assert.equal(await bridge.ready, true);
  assert.equal(video.muted, true);
  bridge.close();
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(reader.cancelled, true);
  assert.equal(video.removed, true);
  assert.deepEqual(revoked, ['blob:camera']);
});

for (const preload of [false, true, 'home_assistant']) test(`remote sound can be unmuted and muted (preload=${preload})`, async () => {
  const video = { muted: true, style: {}, play: async () => {}, remove() {} };
  const sound = { hidden: true, setAttribute() {} };
  const start = { click() { this.started = this.onclick(); } };
  const status = {};
  const frame = {
    classList: { add() {}, remove() {} },
    prepend() {}, querySelector: () => video,
  };
  const elements = { 'camera-live-frame': frame, 'camera-live-start': start,
    'camera-live-status': status, 'camera-live-sound': sound };
  const bridge = { video, ready: Promise.resolve(true), close() {} };
  const background = { video, bridge, ready: Promise.resolve(true), closed: false };
  const scope = vm.createContext({
    window: { addEventListener() {} },
    document: { getElementById: id => elements[id] || null,
      querySelectorAll: () => [], createElement: () => video },
    _currentDevice: { serial: 'feeder', device_type: 'camera_feeder' },
    _settings: { camera_preload_live_feeds: preload === true, camera_stream_lifetime: preload === 'home_assistant' ? preload : undefined },
    wireCameraTalk() {}, muteCameraForTalk() {},
    getBackgroundCamera: () => background,
    RTCPeerConnection: class { constructor() { throw new Error('No direct connection'); } },
  });
  vm.runInContext(readFileSync(new URL('../addon/app/modal-device.js', import.meta.url), 'utf8'), scope);
  scope.openLiveCameraVideoBridge = () => bridge;
  scope.wireDeviceTabHandlers('overview');
  if (preload === 'home_assistant') {
    assert.ok(start.started, 'persistent mode starts the viewer automatically');
    await start.started;
  } else {
    await start.onclick();
  }
  assert.equal(status.textContent, 'Live');
  assert.equal(sound.hidden, false);
  assert.equal(video.muted, true);
  sound.onclick();
  assert.equal(video.muted, false);
  assert.equal(sound.title, 'Mute camera sound');
  sound.onclick();
  assert.equal(video.muted, true);
  assert.equal(sound.title, 'Turn sound on');
});

test('closing a browser power lease keeps a persistent camera powered on', async () => {
  const commands = [];
  const scope = vm.createContext({
    window: { addEventListener() {} },
    document: {},
    _settings: { camera_stream_lifetime: 'home_assistant' },
    _currentDevice: null,
    api: async (method, path, body) => commands.push(body.cameraSwitch),
    _patchDevice() {},
  });
  vm.runInContext(readFileSync(new URL('../addon/app/modal-device.js', import.meta.url), 'utf8'), scope);
  vm.runInContext('_patchDevice = () => {}', scope);
  await vm.runInContext('var owner = {}; acquireCameraPower("feeder", owner)', scope);
  vm.runInContext('releaseCameraPower("feeder", owner)', scope);
  await vm.runInContext('_liveCameraPowerRequest', scope);
  assert.deepEqual(commands, [true]);
});
