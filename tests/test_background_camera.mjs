import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const mode of ['preload', 'cards', 'web_interface', 'home_assistant']) test(`${mode} connects online camera feeders once and releases them when disabled`, async () => {
  const requests = [];
  const videos = [];
  const scope = vm.createContext({
    BASE: '',
    _settings: { camera_preload_live_feeds: mode === 'preload', camera_stream_lifetime: ['web_interface', 'home_assistant'].includes(mode) ? mode : undefined, feeder_card_display: mode === 'cards' ? 'live' : 'product' },
    _devices: [
      { serial: 'camera-1', device_type: 'camera_feeder', online: true },
      { serial: 'camera-2', device_type: 'camera_feeder', online: false },
      { serial: 'fountain', device_type: 'dockstream2', online: true },
    ],
    _liveCameraBackgroundSerial: null,
    document: {
      body: { append() {} },
      querySelectorAll() { return []; },
      createElement(tag) {
        if (tag === 'div') return { style: {}, setAttribute() {}, append() {}, prepend() {} };
        const video = { readyState: 2, style: {}, play: async () => {}, pause() {}, remove() {} };
        videos.push(video);
        return video;
      },
    },
    window: { addEventListener() {} },
    fetch: async (url, options) => {
      requests.push([url, options.method]);
      return { ok: true, headers: { get: () => 'session-1' }, text: async () => 'answer' };
    },
    RTCPeerConnection: class {
      iceGatheringState = 'complete';
      localDescription = { sdp: 'offer' };
      addTransceiver() { return {}; }
      async createOffer() { return {}; }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      addEventListener() {}
      close() { this.closed = true; }
    },
    MediaStream: class { addTrack() {} },
    acquireCameraPower: async () => {},
    releaseCameraPower() {},
    preferVP8() {},
    stopLiveCamera() {},
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(readFileSync(new URL('../addon/app/background-camera.js', import.meta.url), 'utf8'), scope);
  vm.runInContext('syncBackgroundCameras()', scope);
  assert.equal(await vm.runInContext('getBackgroundCamera("camera-1").ready', scope), true);
  assert.equal(vm.runInContext('getBackgroundCamera("camera-2")', scope), null);
  assert.equal(videos.length, 1);
  vm.runInContext('syncBackgroundCameras()', scope);
  assert.equal(videos.length, 1);
  vm.runInContext('_settings.camera_stream_lifetime = "viewing"; _settings.camera_preload_live_feeds = false; _settings.feeder_card_display = "product"; syncBackgroundCameras()', scope);
  assert.equal(vm.runInContext('getBackgroundCamera("camera-1")', scope), null);
  assert.deepEqual(requests.map(([url, method]) => method), ['POST', 'DELETE']);
});
