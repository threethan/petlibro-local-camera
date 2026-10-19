import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../addon/app/camera-talk.js', import.meta.url), 'utf8');
function harness(getUserMedia, options = {}) {
  const video = { muted: false };
  const elements = Object.fromEntries(['camera-talk-toggle', 'camera-talk-status', 'camera-live-sound'].map(id => [id, { setAttribute() {} }]));
  const contexts = [], nodes = [], sockets = [], listeners = {};
  const powerCommands = [];
  class Context {
    sampleRate = 44100;
    audioWorklet = { addModule: async () => {} };
    constructor() { contexts.push(this); }
    async resume() {}
    async close() { this.closed = true; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class Node {
    port = {};
    constructor() { nodes.push(this); }
    connect() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  class Socket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    sent = [];
    constructor(url) { this.url = url; sockets.push(this); }
    send(data) { this.sent.push(data); }
    close() { this.closed = true; }
  }
  const scope = vm.createContext({
    window: { isSecureContext: true, AudioContext: Context, AudioWorkletNode: Node, location: { href: 'https://example.test/prefix/' }, addEventListener: (name, cb) => { listeners[name] = cb; } },
    navigator: { mediaDevices: { getUserMedia } },
    document: { getElementById: id => elements[id], querySelector: () => video },
    BASE: '/prefix', AudioWorkletNode: Node, WebSocket: Socket, URL,
    _currentDevice: options.device || { serial: 'serial', cameraSwitch: true },
    _settings: {},
    api: async (_method, _url, data) => { powerCommands.push(data.cameraSwitch); await options.power?.(data.cameraSwitch); },
    _patchDevice() {},
    setTimeout: () => 1, clearTimeout() {}
  });
  vm.runInContext(readFileSync(new URL('../addon/app/modal-device.js', import.meta.url), 'utf8'), scope);
  vm.runInContext('_patchDevice = () => {}', scope);
  vm.runInContext(script, scope);
  return { run: code => vm.runInContext(code, scope), video, elements, contexts, nodes, sockets, listeners, powerCommands };
}
function microphone() {
  const track = { stopped: false, stop() { this.stopped = true; }, addEventListener(name, cb) { this[name] = cb; } };
  return { track, stream: { getTracks: () => [track] } };
}

test('capture waits for ready, sends PCM, bounds backlog, and restores camera sound', async () => {
  const mic = microphone();
  const h = harness(async () => mic.stream, { device: { serial: 'serial / one', cameraSwitch: true } });
  await h.run('startCameraTalk("serial / one")');
  assert.equal(h.video.muted, true);
  assert.equal(h.sockets[0].url, 'wss://example.test/prefix/api/devices/serial%20%2F%20one/camera/talk');
  assert.equal(h.nodes[0].connected, undefined);
  assert.match(h.elements['camera-talk-status'].textContent, /waiting for speaker/i);
  h.sockets[0].onmessage({ data: '{"type":"ready"}' });
  assert.match(h.elements['camera-talk-status'].textContent, /microphone connected/i);
  const pcm = new ArrayBuffer(4096);
  h.nodes[0].port.onmessage({ data: pcm });
  assert.equal(h.sockets[0].sent[0], pcm);
  h.sockets[0].bufferedAmount = 44101;
  h.nodes[0].port.onmessage({ data: pcm });
  assert.equal(h.sockets[0].closed, true);
  assert.equal(h.sockets[0].sent[1], '{"type":"stop"}');
  assert.equal(mic.track.stopped, true);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.video.muted, false);
  assert.match(h.elements['camera-talk-status'].textContent, /too slow/);
});

test('stopping during permission request disposes late stream without connecting', async () => {
  let allow;
  let requested = false;
  const mic = microphone();
  const h = harness(() => { requested = true; return new Promise(resolve => { allow = resolve; }); });
  const pending = h.run('startCameraTalk("serial")');
  while (!requested) await Promise.resolve();
  h.run('stopCameraTalk()');
  allow(mic.stream);
  await pending;
  assert.equal(mic.track.stopped, true);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.contexts[0].closed, true);
});

test('server errors, track loss and page exit release microphone resources', async () => {
  for (const cause of ['server', 'track', 'pagehide']) {
    const mic = microphone();
    const h = harness(async () => mic.stream);
    await h.run('startCameraTalk("serial")');
    if (cause === 'server') h.sockets[0].onmessage({ data: '{"type":"error","message":"Feeder is busy"}' });
    if (cause === 'track') mic.track.ended();
    if (cause === 'pagehide') h.listeners.pagehide();
    assert.equal(mic.track.stopped, true, cause);
    assert.equal(h.sockets[0].closed, true, cause);
    assert.equal(h.contexts[0].closed, true, cause);
  }
});

test('Talk and live view retain power until their last owner stops', async () => {
  for (const firstStop of ['talk', 'view']) {
    const mic = microphone();
    const h = harness(async () => mic.stream, { device: { serial: 'serial', cameraSwitch: false, camera_power_with_live_view: true } });
    await h.run('startCameraTalk("serial")');
    await h.run('_liveCameraPowerOwner = { serial: "serial" }; acquireCameraPower("serial", _liveCameraPowerOwner)');
    assert.deepEqual(h.powerCommands, [true]);
    if (firstStop === 'talk') {
      h.run('stopCameraTalk()');
      await h.run('_liveCameraPowerRequest');
      assert.deepEqual(h.powerCommands, [true]);
      h.run('stopLiveCamera(false)');
    } else {
      h.run('stopLiveCamera(false)');
      await h.run('_liveCameraPowerRequest');
      assert.deepEqual(h.powerCommands, [true]);
      assert.equal(mic.track.stopped, false);
      h.run('stopCameraTalk()');
    }
    await h.run('_liveCameraPowerRequest');
    assert.deepEqual(h.powerCommands, [true, false]);
    assert.equal(mic.track.stopped, true);
  }
});

test('cancel during delayed power-on turns power off and never requests the microphone', async () => {
  let powerOnComplete;
  let microphoneRequests = 0;
  const h = harness(async () => { microphoneRequests++; return microphone().stream; }, {
    device: { serial: 'serial', cameraSwitch: false, camera_power_with_live_view: true },
    power: enabled => enabled ? new Promise(resolve => { powerOnComplete = resolve; }) : Promise.resolve()
  });
  const pending = h.run('startCameraTalk("serial")');
  while (!powerOnComplete) await Promise.resolve();
  h.run('stopCameraTalk()');
  powerOnComplete();
  await pending;
  await h.run('_liveCameraPowerRequest');
  assert.deepEqual(h.powerCommands, [true, false]);
  assert.equal(microphoneRequests, 0);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.contexts[0].closed, true);
});

test('camera disabled without automatic power never opens microphone or powers camera', async () => {
  let requests = 0;
  const h = harness(async () => { requests++; return microphone().stream; }, {
    device: { serial: 'serial', cameraSwitch: false }
  });
  await h.run('startCameraTalk("serial")');
  assert.equal(requests, 0);
  assert.deepEqual(h.powerCommands, []);
  assert.match(h.elements['camera-talk-status'].textContent, /Enable the camera/);
});

test('worklet downmixes, clips, and emits bounded little-endian PCM16 blocks', () => {
  let Processor;
  const blocks = [];
  const scope = vm.createContext({
    AudioWorkletProcessor: class { port = { postMessage: data => blocks.push(data) }; },
    registerProcessor: (_name, processor) => { Processor = processor; }
  });
  vm.runInContext(readFileSync(new URL('../addon/app/camera-talk-worklet.js', import.meta.url), 'utf8'), scope);
  const processor = new Processor();
  const left = new Float32Array(2048).fill(0.5);
  const right = new Float32Array(2048).fill(-0.5);
  left[0] = right[0] = 2;
  left[1] = right[1] = -2;
  processor.process([[left, right]]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].byteLength, 4096);
  const view = new DataView(blocks[0]);
  assert.equal(view.getInt16(0, true), 32767);
  assert.equal(view.getInt16(2, true), -32768);
  assert.equal(view.getInt16(4, true), 0);
});
