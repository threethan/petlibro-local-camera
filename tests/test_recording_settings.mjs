import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function render(device, category = "sensors", settings = {}) {
  const scope = vm.createContext({
    t: key => key,
    escHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    _utcToLocal: value => value,
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    device,
    category,
    _settings: settings,
  });
  vm.runInContext(readFileSync(new URL('../addon/app/modal-device.js', import.meta.url), 'utf8'), scope);
  return vm.runInContext('buildCameraSettingsTab(device, category)', scope);
}

test('camera settings expose recording modes, hours and feeding clip parameters', () => {
  const html = render({videoRecordSwitch: true, videoRecordMode: 'MOTION_DETECTION', videoRecordAgingType: 2,
    videoRecordStartTimeUtc: '22:00', videoRecordEndTimeUtc: '06:00', feedingVideoSwitch: true});
  for (const key of ['videoRecordSwitch', 'videoRecordMode', 'videoRecordAgingType', 'videoRecordStartTime',
    'videoRecordEndTime', 'feedingVideoSwitch', 'enableVideoStartFeedingPlan', 'beforeFeedingPlanTime',
    'automaticRecording', 'enableVideoAfterManualFeeding', 'afterManualFeedingTime']) {
    assert.ok(html.includes(`data-camera-setting="${key}"`), key);
  }
  assert.ok(html.includes('value="22:00"'));
  assert.ok(html.includes('value="06:00"'));
  assert.ok(html.includes('Motion Detection to be enabled'));
  assert.match(html, /class="toggle-switch is-small sw-on" data-camera-setting="videoRecordSwitch"/);
  assert.match(html, /class="toggle-switch is-small sw-on" data-camera-setting="feedingVideoSwitch"/);
});

test('SD card facts stay read-only and escaped', () => {
  const html = render({sdCardState: '1', sdCardFileSystem: '<script>bad</script>',
    sdCardTotalCapacity: '32000', sdCardUsedCapacity: '1000'});
  assert.ok(html.includes('30.3 GB free'));
  assert.ok(html.includes('31.3 GB'));
  assert.ok(html.includes('role="progressbar"'));
  assert.ok(!html.includes('<span>Status</span>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('data-camera-setting="sdCardState"'));
  assert.ok(render({}).includes('Capacity unknown'));
});

test('missing SD card shows a message instead of storage and recording controls', () => {
  for (const sdCardState of [0, '0']) {
    const html = render({sdCardState, videoRecordSwitch: true});
    assert.ok(html.includes('No SD Card Detected'));
    assert.ok(!html.includes('class="sd-card-panel"'));
    assert.ok(!html.includes('<h3>SD card</h3>'));
    assert.ok(!html.includes('SD card recording'));
    assert.ok(!html.includes('data-camera-setting="videoRecordSwitch"'));
    assert.ok(!html.includes('Feeding video'));
    assert.ok(!html.includes('data-camera-setting="feedingVideoSwitch"'));
  }
});

test('Home Assistant camera options use checkboxes', () => {
  const html = render({camera_power_with_live_view: false, live_camera_exposed: true});
  assert.match(html, /<input type="checkbox" id="camera-power-with-live-view"/);
  assert.match(html, /<input type="checkbox" id="camera-ha-expose"[^>]*checked/);
  assert.ok(!html.includes('role="switch"'));
});

test('always-on cameras hide the power override but allow Home Assistant exposure changes', () => {
  const html = render({camera_power_with_live_view: true, live_camera_exposed: true}, 'sensors',
    {camera_stream_lifetime: 'home_assistant'});
  assert.ok(!html.includes('camera-power-with-live-view'));
  assert.match(html, /<input type="checkbox" id="camera-ha-expose"[^>]*checked/);
  assert.ok(!/<input[^>]*id="camera-ha-expose"[^>]*disabled/.test(html));
  assert.ok(!html.includes('settings.camera_power_with_live_view'));
  assert.ok(html.includes('Live Camera in Home Assistant'));
  assert.ok(!html.includes('keeps the camera on after live view closes'));
  assert.ok(!html.includes('Kept available in the background'));
  assert.ok(html.includes('data-camera-setting="resolution"'));
  const hidden = render({live_camera_exposed: false}, 'sensors', {camera_stream_lifetime: 'home_assistant'});
  assert.ok(!/<input[^>]*id="camera-ha-expose"[^>]*checked/.test(hidden));
});

test('indicator light settings display scheduled hours from UTC reports', () => {
  const html = render({lightSwitch: true, lightAgingType: 2,
    lightingStartTimeUtc: '08:00', lightingEndTimeUtc: '22:00'}, "indicators");
  for (const key of ['lightSwitch', 'lightAgingType', 'lightingStartTime', 'lightingEndTime']) {
    assert.ok(html.includes(`data-camera-setting="${key}"`), key);
  }
  assert.ok(html.includes('Indicator lights'));
  assert.ok(html.includes('value="08:00"'));
  assert.ok(html.includes('value="22:00"'));
  assert.ok(html.includes('data-schedule-times="indicators"'));
});
