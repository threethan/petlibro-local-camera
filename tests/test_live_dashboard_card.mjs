import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup() {
  const registered = new Map();
  const frames = [];
  const images = [];
  const title = {};
  const span = { textContent: '' }, button = {}, message = { querySelector: key => key === 'span' ? span : button };
  const root = {
    querySelector(key) {
      if (key === 'iframe') return frames.find(frame => !frame.removed);
      if (key === 'img') return images.find(image => !image.removed);
      return ({ '.title': title, '.message': message, button, '.frame': { append: frame => (frame.tag === 'img' ? images : frames).push(frame) } })[key];
    },
  };
  const scope = vm.createContext({
    HTMLElement: class { isConnected = false; attachShadow() { this.shadowRoot = root; } },
    customElements: { define: (name, value) => registered.set(name, value), get: name => registered.get(name) },
    window: {}, document: { cookie: '', createElement: tag => ({ tag, dataset: {}, remove() { this.removed = true; } }) },
    location: { protocol: 'https:' }, setTimeout: () => 1, clearTimeout() {},
  });
  vm.runInContext(readFileSync(new URL('../dist/petlibro-local-status-card.js', import.meta.url), 'utf8'), scope);
  return { Card: registered.get('petlibro-local-live-camera-card'), frames, images, registered, scope, span, title };
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('live camera selection resolves the feeder without a manually entered serial', async () => {
  const { Card, frames } = setup();
  const card = new Card();
  card.setConfig({ live_camera_entity: 'camera.renamed_live' });
  card.isConnected = true;
  card.hass = { connection: {}, callWS: async request => {
    if (request.type === 'config/entity_registry/list') return [
      { entity_id: 'camera.renamed_live', unique_id: 'petlibro_AF030103030202814F5B_camera_live' },
    ];
    return request.endpoint === '/ingress/session' ? { session: 'session' }
      : { state: 'started', ingress_url: '/api/hassio_ingress/entry/' };
  } };
  await settle();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].src, '/api/hassio_ingress/entry/camera?serial=AF030103030202814F5B');
});

test('snapshot selection shows the selected image without opening a live or ingress session', async () => {
  const { Card, images, frames, title } = setup();
  const card = new Card();
  card.setConfig({ camera_entity: 'camera.feeder_snapshot' });
  card.isConnected = true;
  let requests = 0;
  const hass = { states: { 'camera.feeder_snapshot': { state: 'idle', attributes: { friendly_name: 'PetLibro Dark Camera Camera', entity_picture: '/api/camera_proxy/camera.feeder_snapshot?token=test' } } },
    callWS: async () => { requests++; } };
  card.hass = hass;
  await settle();
  assert.equal(frames.length, 0);
  assert.equal(requests, 0);
  assert.equal(images.length, 1);
  assert.equal(title.textContent, 'PetLibro Dark Camera');
  assert.match(images[0].src, /^\/api\/camera_proxy\/camera.feeder_snapshot\?token=test&_petlibro=/);
  const timer = card._snapshotTimer;
  card.hass = hass;
  assert.equal(images.length, 1);
  assert.equal(card._snapshotTimer, timer);
  card.disconnectedCallback();
  assert.ok(images[0].removed);
  assert.equal(card._snapshotTimer, null);
});

test('camera editor offers the same camera entity selectors as the status card', () => {
  const { registered, scope } = setup();
  scope.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  const Editor = registered.get('petlibro-local-live-camera-card-editor');
  const editor = new Editor();
  const pickers = ['camera_entity', 'live_camera_entity'].map(key => ({ dataset: { key },
    addEventListener(type, callback) { this.changed = callback; } }));
  editor.querySelectorAll = selector => selector === 'ha-entity-picker' ? pickers : [];
  let event;
  editor.dispatchEvent = value => { event = value; };
  editor.setConfig({ camera_entity: 'camera.snapshot' });
  editor.hass = {};
  assert.ok(editor.innerHTML.includes('Snapshot camera (optional)'));
  assert.ok(editor.innerHTML.includes('Live camera (optional)'));
  assert.equal(pickers[0].value, 'camera.snapshot');
  assert.equal(pickers[1].includeDomains[0], 'camera');
  pickers[1].changed({ detail: { value: 'camera.live' } });
  assert.equal(event.detail.config.live_camera_entity, 'camera.live');
  assert.equal(event.detail.config.camera_entity, 'camera.snapshot');
  assert.equal(event.detail.config.serial, undefined);
});

test('shared player contains the Status controls and escapes camera URLs', () => {
  const scope = vm.createContext({
    navigator: {}, document: { addEventListener() {} }, window: { addEventListener() {} },
    BASE: '/api/hassio_ingress/test', t: key => key,
  });
  vm.runInContext(readFileSync(new URL('../addon/app/modal-device.js', import.meta.url), 'utf8'), scope);
  const html = vm.runInContext('buildLiveCameraView({serial:"FEEDER123",device_type:"camera_feeder"})', scope);
  for (const id of ['camera-live-frame', 'camera-live-start', 'camera-live-sound', 'camera-talk-toggle',
    'camera-live-record', 'camera-live-snapshot', 'camera-live-fullscreen', 'camera-live-resolution', 'camera-live-night-vision']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes('/api/hassio_ingress/test/api/devices/FEEDER123/camera/snapshot'));
});

test('live card authenticates ingress and keeps the same player across HA updates', async () => {
  const { Card, frames, scope } = setup();
  const card = new Card();
  const requests = [];
  card.setConfig({ serial: 'FEEDER123' });
  card.isConnected = true;
  const hass = { callWS: async request => {
    requests.push(request);
    return request.endpoint === '/ingress/session' ? { session: 'private-session' }
      : { state: 'started', ingress_url: '/api/hassio_ingress/entry/' };
  } };
  card.hass = hass;
  await settle();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].src, '/api/hassio_ingress/entry/camera?serial=FEEDER123');
  assert.ok(scope.document.cookie.includes('path=/api/hassio_ingress/;SameSite=Strict;Secure'));
  assert.ok(frames[0].allow.includes('microphone'));
  card.hass = hass;
  await settle();
  assert.equal(requests.length, 2);
  card.disconnectedCallback();
  assert.ok(frames[0].removed);
});

test('removed cards discard pending setup and an unsafe ingress URL is rejected', async () => {
  const { Card, frames } = setup();
  const card = new Card();
  card.setConfig({ serial: 'FEEDER123' });
  card.isConnected = true;
  let resolve;
  card.hass = { callWS: () => new Promise(done => { resolve = done; }) };
  card.disconnectedCallback();
  card.isConnected = false;
  resolve({ session: 'session' });
  await settle();
  assert.equal(frames.length, 0);

  const second = setup();
  const unsafe = new second.Card();
  unsafe.setConfig({ serial: 'FEEDER123' });
  unsafe.isConnected = true;
  unsafe.hass = { callWS: async request => request.endpoint === '/ingress/session' ? { session: 'session' }
    : { state: 'started', ingress_url: 'https://example.com/' } };
  await settle();
  assert.equal(second.frames.length, 0);
  assert.match(second.span.textContent, /no ingress URL/);
});

test('standalone camera view mounts and wires the Status player for only the selected feeder', async () => {
  const selected = { serial: 'FEEDER123', online: true, device_type: 'camera_feeder' };
  let deviceLink;
  const host = { querySelector: () => ({ prepend: link => { deviceLink = link; } }) };
  let mounted, wired, warmed;
  const scope = vm.createContext({
    location: { search: '?serial=FEEDER123' }, URLSearchParams, BASE: '/api/hassio_ingress/entry/',
    document: {
      getElementById: id => id === 'camera-view' ? host : null, addEventListener() {},
      createElement: () => ({ setAttribute(name, value) { this[name] = value; } }),
    },
    window: { addEventListener() {} }, setTimeout: () => 1, clearTimeout() {},
    api: async (_method, path) => path === '/api/devices' ? [selected, { ...selected, serial: 'OTHER' }] : {},
    _settings: {}, _devices: [], _currentDevice: null,
    loadLocale: async () => {}, buildLiveCameraView: device => { mounted = device; return 'shared-player'; },
    wireDeviceTabHandlers: tab => { wired = tab; },
    syncBackgroundCameras: () => { warmed = scope._devices; },
    handleCameraVisibilityChange() {},
  });
  vm.runInContext(readFileSync(new URL('../addon/app/camera-view.js', import.meta.url), 'utf8'), scope);
  await settle();
  assert.equal(mounted.serial, selected.serial);
  assert.equal(wired, 'overview');
  assert.equal(host.innerHTML, 'shared-player');
  assert.equal(warmed.length, 1);
  assert.equal(deviceLink.href, '/api/hassio_ingress/entry/?device=FEEDER123');
  assert.equal(deviceLink.target, '_top');
  assert.match(deviceLink['aria-label'], /FEEDER123 Status/);
});

test('device links open the selected device Status page after loading, and ignore missing devices', () => {
  const source = readFileSync(new URL('../addon/app/init.js', import.meta.url), 'utf8');
  const selected = { serial: 'FEEDER123' };
  const opened = [];
  const scope = vm.createContext({
    URLSearchParams, location: { search: '?device=FEEDER123' },
    _devices: [{ serial: 'OTHER' }, selected],
    _settings: {}, document: { querySelectorAll: () => [], getElementById: () => null },
    openDeviceModal: device => opened.push(device),
  });
  vm.runInContext(source.split('(async () => {')[0], scope);
  vm.runInContext('openRequestedDevice()', scope);
  assert.equal(opened[0], selected);
  scope.location.search = '?device=MISSING';
  vm.runInContext('openRequestedDevice()', scope);
  scope.location.search = '';
  vm.runInContext('openRequestedDevice()', scope);
  assert.equal(opened.length, 1);
  assert.ok(source.indexOf('openRequestedDevice();') > source.indexOf('await loadAll();', source.indexOf('// Initial load')));
});
