import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup() {
  const elements = new Map();
  function element() {
    return {
      value: '', textContent: '', dataset: {}, style: {}, options: [],
      classList: { add() {}, remove() {} },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      replaceChildren() { this.options = []; this.value = ''; },
      append(option) { this.options.push(option); this.value ||= option.value; },
    };
  }
  const calls = [];
  const timers = [];
  const context = vm.createContext({
    URL,
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element,
    },
    api: async (method, path, body) => {
      calls.push({ method, path, body: body && { ...body } });
      if (path === '/api/settings/local-audio-url-suggestion') return { url: 'http://192.168.1.10:8765' };
      if (path === '/api/provision/scan') return { devices: [{ address: 'AA:BB:CC:DD:EE:FF', name: '<script>', rssi: -45 }] };
      return { status: 'capturing', detail: 'Connecting to Wi-Fi…' };
    },
    setInterval(callback) { timers.push(callback); return timers.length; },
    clearInterval() {}, alert() {}, _capturePolling: null,
  });
  vm.runInContext(readFileSync(new URL('../addon/app/modal-add.js', import.meta.url), 'utf8'), context);
  return { context, elements, calls, run: code => vm.runInContext(code, context) };
}

test('new-device view and radio scan display names as text', async () => {
  const { run, elements, calls } = setup();
  await run('showAddView("new")');
  assert.equal(elements.get('add-new-flow').style.display, '');
  assert.equal(elements.get('add-auto-flow').style.display, 'none');
  await run('scanNewDevices()');
  assert.ok(calls.some(call => call.path === '/api/provision/scan'));
  const option = elements.get('n-device').options[0];
  assert.equal(option.value, 'AA:BB:CC:DD:EE:FF');
  assert.match(option.textContent, /<script>/);
  assert.equal(option.innerHTML, undefined);
});

test('device selection gates the Wi-Fi step and Back preserves entered settings', async () => {
  const { run, elements } = setup();
  run('showNewDeviceStep(0); nextNewDeviceStep()');
  assert.equal(elements.get('new-step-0').style.display, '');
  assert.equal(elements.get('new-step-1').style.display, 'none');
  await run('scanNewDevices()');
  assert.equal(elements.get('btn-new-next').disabled, false);
  run('nextNewDeviceStep()');
  assert.equal(elements.get('new-step-0').style.display, 'none');
  assert.equal(elements.get('new-step-1').style.display, '');
  assert.equal(elements.get('new-progress-0').className, 'wizard-step done');
  assert.equal(elements.get('new-progress-1')['aria-current'], 'step');
  run("document.getElementById('n-ssid').value = 'My Wi-Fi'; showNewDeviceStep(0)");
  assert.equal(elements.get('n-ssid').value, 'My Wi-Fi');
  assert.equal(elements.get('n-device').value, 'AA:BB:CC:DD:EE:FF');
  assert.equal(elements.get('new-progress-0').className, 'wizard-step active');
  assert.equal(elements.get('new-progress-1')['aria-current'], undefined);
});

test('an empty rescan disables Next and prevents advancing with the old device', async () => {
  const { run, elements, context } = setup();
  await run('scanNewDevices()');
  context.api = async () => ({ devices: [] });
  await run('scanNewDevices()');
  assert.equal(elements.get('btn-new-next').disabled, true);
  run('showNewDeviceStep(0); nextNewDeviceStep()');
  assert.equal(elements.get('new-step-1').style.display, 'none');
});

test('opening new-device setup fills the HA LAN IPv4 from the host lookup', async () => {
  const { run, elements } = setup();
  await run('showAddView("new")');
  assert.equal(elements.get('n-broker').value, '192.168.1.10');
});

test('address autofill preserves an existing value without requesting a lookup', async () => {
  const { run, elements, calls } = setup();
  run("document.getElementById('n-broker').value = '192.168.2.20'");
  await run('showAddView("new")');
  assert.equal(elements.get('n-broker').value, '192.168.2.20');
  assert.equal(calls.length, 0);
});

test('a delayed lookup preserves an address entered while detection is pending', async () => {
  const { run, elements, context } = setup();
  let resolve;
  context.api = () => new Promise(done => { resolve = done; });
  const pending = run('showAddView("new")');
  elements.get('n-broker').value = '192.168.2.30';
  resolve({ url: 'http://192.168.1.10:8765' });
  await pending;
  assert.equal(elements.get('n-broker').value, '192.168.2.30');
});

test('failed address detection leaves manual entry available and retries on reopening', async () => {
  const { run, elements, context } = setup();
  context.api = async () => { throw new Error('Unavailable'); };
  await run('showAddView("new")');
  assert.equal(elements.get('n-broker').value, '');
  assert.equal(elements.get('add-new-flow').style.display, '');
  context.api = async () => ({ url: 'http://192.168.1.20:8765' });
  await run('showAddView("new")');
  assert.equal(elements.get('n-broker').value, '192.168.1.20');
});

test('Wi-Fi settings go to HA and progress uses existing auto-capture polling', async () => {
  const { run, elements, calls } = setup();
  await run('scanNewDevices()');
  run(`document.getElementById('n-ssid').value = ' network ';
       document.getElementById('n-password').value = ' password ';
       document.getElementById('n-broker').value = '192.168.1.10';`);
  await run('startNewDevice()');
  const body = calls.find(call => call.path === '/api/provision/start').body;
  assert.equal(body.ssid, ' network ');
  assert.equal(body.password, ' password ');
  assert.equal(Object.hasOwn(body, 'owner_id'), false);
  assert.equal(elements.get('n-password').value, '');
  assert.equal(elements.get('new-step-2').style.display, '');
  assert.equal(elements.get('new-step-1').style.display, 'none');
  assert.equal(elements.get('new-progress-0').className, 'wizard-step done');
  assert.equal(elements.get('new-progress-1').className, 'wizard-step done');
  assert.equal(elements.get('new-progress-2')['aria-current'], 'step');
  await run('pollAutoCapture()');
  assert.equal(elements.get('new-connection-status').textContent, 'Connecting to Wi-Fi…');
  await run('cancelDeviceSetup()');
  assert.equal(calls.at(-1).path, '/api/capture/cancel');
  assert.equal(run('_capturePolling'), null);
});

test('provisioning failure returns to Wi-Fi form with actionable error', async () => {
  const { run, elements, context } = setup();
  run(`_newDeviceSetup = true; showAddView('new'); showNewDeviceStep(2);`);
  context.api = async () => ({ status: 'error', detail: 'Device rejected Wi-Fi connection (code 3).' });
  await run('pollAutoCapture()');
  assert.equal(elements.get('add-new-flow').style.display, '');
  assert.equal(elements.get('new-step-1').style.display, '');
  assert.equal(elements.get('new-step-2').style.display, 'none');
  assert.match(elements.get('new-wifi-status').textContent, /rejected Wi-Fi/);
  assert.equal(elements.get('setup-error').hidden, true);
});

test('successful connection opens captured credentials after the third step', async () => {
  const { run, elements, context } = setup();
  Object.assign(context, {
    detectFromClientId: () => ({ serial: 'WF031234', device_type: 'dockstream2' }),
    detectVariantFromSerial: () => '',
    populateVariantSelect() {}, populateRoomSelect() {}, populatePetSection() {},
  });
  run("_newDeviceSetup = true; showAddView('new'); showNewDeviceStep(2)");
  context.api = async () => ({ status: 'captured', result: {
    client_id: 'WF031234', username: 'device-user', password: 'device-pass',
  } });
  await run('pollAutoCapture()');
  assert.equal(elements.get('add-new-flow').style.display, 'none');
  assert.equal(elements.get('add-auto-flow').style.display, '');
  assert.equal(elements.get('auto-step-2').style.display, '');
  assert.equal(elements.get('a-cred-user').value, 'device-user');
  assert.equal(run('_newDeviceSetup'), false);
});

test('actual error is visible during broker restoration and remains after it finishes', async () => {
  const { run, elements, context } = setup();
  const detail = 'Device rejected Wi-Fi settings write (ATT 0x0e).';
  run("_newDeviceSetup = true; showAddView('new'); showNewDeviceStep(2)");
  context.api = async () => ({ status: 'capturing', detail: 'Restoring Mosquitto…', error: detail });
  await run('pollAutoCapture()');
  assert.equal(elements.get('new-connection-status').textContent, 'Restoring Mosquitto…');
  assert.equal(elements.get('setup-error').hidden, false);
  assert.equal(elements.get('setup-error').textContent, `Setup failed: ${detail}`);
  assert.equal(elements.get('add-new-flow').style.display, '');
  context.api = async () => ({ status: 'error', detail });
  await run('pollAutoCapture()');
  assert.equal(elements.get('setup-error').hidden, true);
  assert.equal(elements.get('new-wifi-status').textContent, detail);
  assert.equal(elements.get('add-new-flow').style.display, '');
});

test('polling errors are visible and polling can recover automatically', async () => {
  const { run, elements, context } = setup();
  context.api = async () => { throw new Error('Network unavailable'); };
  await run('pollAutoCapture()');
  assert.equal(elements.get('setup-error').hidden, false);
  assert.match(elements.get('setup-error').textContent, /Network unavailable.*Retrying automatically/);
  context.api = async () => ({ status: 'capturing', detail: 'Working…' });
  await run('pollAutoCapture()');
  assert.equal(elements.get('setup-error').hidden, true);
});

test('timeout without server detail shows an error and errors are rendered as text', async () => {
  const { run, elements, context } = setup();
  context.api = async () => ({ status: 'timeout' });
  await run('pollAutoCapture()');
  assert.match(elements.get('setup-error').textContent, /Timed out/);
  run('setSetupError("<script>alert(1)</script>")');
  assert.equal(elements.get('setup-error').innerHTML, undefined);
  assert.match(elements.get('setup-error').textContent, /<script>/);
});
