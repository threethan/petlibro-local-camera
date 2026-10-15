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
  bridge.close();
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(reader.cancelled, true);
  assert.equal(video.removed, true);
  assert.deepEqual(revoked, ['blob:camera']);
});
