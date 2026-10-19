import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup() {
  const registry = new Map();
  const context = vm.createContext({
    HTMLElement: class { attachShadow() { this.shadowRoot = { innerHTML: '', querySelector: () => null }; } },
    customElements: { get: name => registry.get(name), define: (name, value) => registry.set(name, value) },
    document: {}, window: {},
  });
  vm.runInContext(readFileSync(new URL('../dist/petlibro-local-status-card.js', import.meta.url), 'utf8'), context);
  return { Card: registry.get('petlibro-local-status-card'), context };
}

test('status fields use real sensor domains and match the app labels and tile styling', () => {
  const { Card } = setup();
  const card = new Card();
  card.setConfig({ feed_now_entity: 'button.white_feeder_feed_now' });
  card.hass = { states: {
    'button.white_feeder_feed_now': { state: 'unknown', attributes: {} },
    'sensor.white_feeder_food_status': { state: 'Adequate' },
    'sensor.white_feeder_battery': { state: '65' },
    'sensor.white_feeder_last_fed': { state: new Date().toISOString() },
    'sensor.white_feeder_next_meal': { state: new Date(2026, 9, 19, 18, 30).toISOString() },
  } };
  const html = card.shadowRoot.innerHTML;
  for (const label of ['Food Level', 'Battery', 'Last Fed', 'Next Feed']) assert.ok(html.includes(label), label);
  for (const value of ['OK', '65%', 'Just Now', '6:30 PM']) assert.ok(html.includes(`>${value}</div>`), value);
  assert.ok(html.includes('gap:12px'));
  assert.ok(html.includes('padding:8px 14px'));
  assert.ok(html.includes('font-size:20px; font-weight:700'));
  assert.ok(html.includes('font-size:28px; font-weight:700; line-height:1.2'));
  assert.ok(html.includes('var(--secondary-background-color, #282828) 50%, transparent'));
  assert.ok(html.includes('border-radius:var(--petlibro-control-radius)'));
  assert.ok(html.includes('.actions { padding:0 16px 16px; }'));
  assert.ok(html.includes('border:0; box-shadow:none'));
  assert.ok(!html.includes('food_status.white_feeder'));
  assert.ok(!html.includes('Food status'));
});

test('renamed buttons and sensors resolve through stable device unique IDs, sharing one registry request', async () => {
  const { Card } = setup();
  const connection = {};
  let requests = 0;
  const entries = [
    { entity_id: 'button.dinner', unique_id: 'petlibro_SERIAL_feed_now', device_id: 'feeder', platform: 'mqtt' },
    { entity_id: 'sensor.renamed_food', unique_id: 'petlibro_SERIAL_food_status', device_id: 'feeder', platform: 'mqtt' },
    { entity_id: 'sensor.renamed_battery', unique_id: 'petlibro_SERIAL_battery', device_id: 'feeder', platform: 'mqtt' },
    { entity_id: 'sensor.wrong_device', unique_id: 'petlibro_SERIAL_food_status', device_id: 'other', platform: 'mqtt' },
  ];
  const hass = { connection, states: {
    'button.dinner': { state: 'unknown', attributes: {} },
    'sensor.renamed_food': { state: 'Low' }, 'sensor.renamed_battery': { state: '14' },
  }, callWS: async request => { assert.equal(request.type, 'config/entity_registry/list'); requests++; return entries; } };
  const cards = [new Card(), new Card()];
  for (const card of cards) { card.setConfig({ feed_now_entity: 'button.dinner' }); card.hass = hass; }
  for (let i = 0; i < 5; i++) await Promise.resolve();
  for (const card of cards) {
    assert.equal(card._entity('food_status'), 'sensor.renamed_food');
    assert.equal(card._entity('battery'), 'sensor.renamed_battery');
    assert.ok(card.shadowRoot.innerHTML.includes('>Low</div>'));
    assert.ok(card.shadowRoot.innerHTML.includes('>14%</div>'));
  }
  assert.equal(requests, 1);
});

test('unavailable or absent values stay empty and explicit entity choices are respected', () => {
  const { Card } = setup();
  const card = new Card();
  card.setConfig({ feed_now_entity: 'button.feeder_feed_now', food_status_entity: 'sensor.selected_food' });
  card.hass = { states: { 'sensor.selected_food': { state: 'unavailable' } } };
  assert.equal(card._entity('food_status'), 'sensor.selected_food');
  assert.ok(card.shadowRoot.innerHTML.includes('>—</div>'));
  assert.ok(card.shadowRoot.innerHTML.includes('>Offline</span>'));
});

test('status card mounts the shared camera view once and preserves it across sensor updates', () => {
  const { Card, context } = setup();
  const card = new Card();
  card.setConfig({ feed_now_entity: 'button.feeder_feed_now', live_camera_entity: 'camera.live', camera_entity: 'camera.snapshot' });
  let view, creations = 0, appends = 0;
  context.document.createElement = tag => {
    assert.equal(tag, 'petlibro-local-camera-view');
    creations++;
    return { setConfig(config) { this.config = config; } };
  };
  const slot = { querySelector: () => view, append(element) { view = element; appends++; } };
  const metrics = {}, title = {}, availability = { classList: { toggle() {} } }, button = { addEventListener() {} };
  card.shadowRoot.querySelector = selector => ({
    'petlibro-local-camera-view': view, '[data-camera-slot]': slot, '.grid': metrics,
    '[data-title]': title, '.availability': availability, button,
  })[selector];
  const hass = { states: { 'button.feeder_feed_now': { state: 'unknown', attributes: {} } } };
  card.hass = hass;
  card.hass = { states: { ...hass.states, 'sensor.feeder_battery': { state: '87' } } };
  assert.equal(creations, 1);
  assert.equal(appends, 1);
  assert.equal(view.config.live_camera_entity, 'camera.live');
  assert.equal(view.config.camera_entity, 'camera.snapshot');
  assert.equal(view.config.embedded, true);
  assert.ok(metrics.innerHTML.includes('87%'));
});

test('feeding timestamp text matches the app formatter for recent and older feedings', () => {
  const { context } = setup();
  const app = vm.createContext({ window: { __BASE__: '', __VERSION__: '' }, navigator: {}, document: {} });
  vm.runInContext(readFileSync(new URL('../addon/app/util.js', import.meta.url), 'utf8'), app);
  const locale = JSON.parse(readFileSync(new URL('../addon/app/locales/en.json', import.meta.url), 'utf8'));
  app.locale = locale;
  vm.runInContext('_t = locale', app);
  for (const secondsAgo of [0, 20 * 60, 3 * 3600, 2 * 86400]) {
    const timestamp = Math.floor(Date.now() / 1000) - secondsAgo;
    context.state = { state: new Date(timestamp * 1000).toISOString() };
    app.timestamp = timestamp;
    assert.equal(vm.runInContext('statusValue("last_fed", state)', context), vm.runInContext('lastFedLabel(timestamp)', app));
  }
});
