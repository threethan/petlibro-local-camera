import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup(reject = false) {
  const ids = Object.fromEntries(['sched-list', 'sched-form', 'sched-meal-call',
    'sf-sound', 'sched-add-btn', 'sf-cancel', 'sf-save'].map(id => [id, {
      className: 'toggle-switch sw-off', disabled: false,
      querySelectorAll: () => [], addEventListener() {},
    }]));
  const button = ids['sched-meal-call'];
  button.classList = { contains: name => button.className.split(' ').includes(name) };
  const device = { serial: 'feeder', device_type: 'camera_feeder', enableAudio: false };
  const calls = [], alerts = [];
  const scope = vm.createContext({
    document: { getElementById: id => ids[id] || null },
    _currentDevice: device, _devices: [device], _settings: {},
    t: key => key, escHtml: String, fmtPortions: String,
    _patchDevice: (serial, values) => Object.assign(device, values),
    alert: message => alerts.push(message),
    api: async (method, path, body) => {
      assert.equal(button.disabled, true);
      calls.push({ method, path, body: JSON.parse(JSON.stringify(body)) });
      if (reject) throw Error('Feeder rejected the feeding sound');
    },
  });
  vm.runInContext(readFileSync(new URL('../addon/app/modal-device.js', import.meta.url), 'utf8'), scope);
  vm.runInContext('wireScheduleTabHandlers()', scope);
  return { button, calls, alerts, device, scope };
}

test('meal-call toggle changes the global audio flag without resending schedules', async () => {
  const ui = setup();
  await ui.button.onclick();
  assert.equal(ui.device.enableAudio, true);
  assert.equal(ui.button.className, 'toggle-switch sw-on');
  assert.equal(ui.button.disabled, false);
  await ui.button.onclick();
  assert.equal(ui.device.enableAudio, false);
  assert.deepEqual(ui.calls, [true, false].map(enableAudio => ({
    method: 'POST', path: '/api/devices/feeder/command', body: { enableAudio },
  })));
});

test('rejected meal-call changes keep the reported setting and release the control', async () => {
  const ui = setup(true);
  await ui.button.onclick();
  assert.equal(ui.device.enableAudio, false);
  assert.equal(ui.button.className, 'toggle-switch sw-off');
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.alerts.length, 1);
});

test('PLAF203 schedule UI exposes the global meal-call control', () => {
  const ui = setup();
  const html = vm.runInContext('buildScheduleTab([])', ui.scope);
  assert.match(html, /id="sched-meal-call"/);
  assert.match(html, /schedule.meal_call_hint/);
});
