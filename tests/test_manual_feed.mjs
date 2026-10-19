import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const device_type of ['one_rfid', 'granary', 'camera_feeder']) {
  test(`${device_type} manual feed picker defaults to half a cup and can be uncapped`, () => {
    const scope = vm.createContext({
      window: { __BASE__: '', addEventListener() {} }, navigator: {}, document: {},
      t: key => key, escHtml: value => String(value),
      filterDaysRemaining: () => null, cleaningDaysRemaining: () => null,
      lastFedLabel: () => '', nextMealLabel: () => '',
    });
    vm.runInContext(readFileSync(new URL('../addon/app/util.js', import.meta.url), 'utf8'), scope);
    vm.runInContext(readFileSync(new URL('../addon/app/modal-device.js', import.meta.url), 'utf8'), scope);
    scope.buildFeedTimingStats = () => '';
    for (const [settings, maximum] of [[{}, 6], [{ manual_feed_half_cup_limit: true }, 6], [{ manual_feed_half_cup_limit: false }, 48]]) {
      vm.runInContext(`_settings = ${JSON.stringify(settings)}`, scope);
      const html = scope.buildOverviewTab({ device_type, feed_unit: 'cup' });
      const picker = html.match(/id="feeder-portions">([\s\S]*?)<\/select>/)[1];
      const values = [...picker.matchAll(/value="(\d+)"/g)].map(match => Number(match[1]));
      assert.equal(values.length, maximum);
      assert.equal(values.at(-1), maximum);
      assert.match(picker, /1\/2 cup/);
    }
  });
}


