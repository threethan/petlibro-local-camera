import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup(pingEnabled = false) {
  const badge = {};
  const tabs = [];
  let cameraStops = 0;
  const scope = vm.createContext({
    console,
    document: { hidden: false, getElementById: id => id === 'detail-status-badge' ? badge : null },
    _currentDevice: { serial: 'feeder', online: true },
    _devices: [],
    _settings: { device_ping_enabled: pingEnabled },
    renderDevices() {}, renderPets() {}, renderSettings() {},
    syncBackgroundCameras() {},
    lastFedLabel: () => '', nextMealLabel: () => '',
    stopCameraTalk() {},
    checkAlerts() {}, checkPetSetup() {},
    t: key => key,
  });
  const source = name => readFileSync(new URL(`../addon/app/${name}`, import.meta.url), 'utf8');
  vm.runInContext(source('modal-device.js'), scope);
  // Load refresh handlers without running the page's DOM initialization.
  vm.runInContext(source('init.js').split('(async () => {')[0], scope);
  scope.renderDeviceTab = tab => tabs.push(tab);
  scope.stopLiveCamera = () => cameraStops++;
  scope.loadAll = async () => { scope._devices = [scope.nextDevice]; };
  scope.api = async () => [scope.nextDevice];
  return { scope, badge, tabs, cameraStops: () => cameraStops };
}

for (const handler of ['pollRefresh', 'refresh', 'pingVisibleDevices']) {
  test(`${handler} updates an open dialog through disconnect and reconnect`, async () => {
    const { scope, badge, tabs, cameraStops } = setup(handler === 'pingVisibleDevices');
    scope.nextDevice = { serial: 'feeder', online: false };
    await scope[handler]();
    assert.equal(badge.textContent, 'device.offline');
    assert.equal(badge.className, 'status-badge offline');
    assert.deepEqual(tabs, ['offline']);
    assert.equal(cameraStops(), 1);

    scope.nextDevice = { serial: 'feeder', online: true, currentWeight: 500 };
    await scope[handler]();
    assert.equal(badge.textContent, 'device.online');
    assert.equal(badge.className, 'status-badge online');
    assert.deepEqual(tabs, ['offline', 'overview']);
    assert.equal(scope._currentDevice.currentWeight, 500);

    // Unchanged connectivity must preserve the user's active tab and inputs.
    scope.nextDevice = { ...scope.nextDevice, currentWeight: 450 };
    await scope[handler]();
    assert.deepEqual(tabs, ['offline', 'overview']);
    assert.equal(scope._currentDevice.currentWeight, 450);
  });
}

test('refresh handles a closed dialog or a removed device', async () => {
  const { scope, tabs } = setup();
  scope.nextDevice = { serial: 'other', online: true };
  await scope.pollRefresh();
  assert.deepEqual(tabs, []);
  scope._currentDevice = null;
  await scope.pollRefresh();
  assert.deepEqual(tabs, []);
});
