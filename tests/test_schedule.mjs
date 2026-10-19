import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the real editor handlers and captured API body with a small DOM fixture.
function setup(plans = []) {
  function element(dataset = {}) {
    const classes = new Set();
    return {
      dataset, value: '', checked: false, style: {}, events: {},
      classList: {
        add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name),
        toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); },
      },
      addEventListener(name, callback) { this.events[name] = callback; },
      focus() {},
      setCustomValidity(message) { this.validationMessage = message; },
      reportValidity() { this.reportedInvalid = true; },
    };
  }
  const days = [1, 2, 3, 4, 5, 6, 7].map(rday => element({ rday: String(rday) }));
  const portions = [1, 2, 3, 4, 5].map(n => element({ n: String(n) }));
  const editButtons = plans.map((_, idx) => element({ idx: String(idx) }));
  const ids = Object.fromEntries(['sched-list', 'sched-form', 'sf-time', 'sf-edit-idx',
    'sf-sound', 'sf-sound-times', 'sf-sound-times-wrap', 'sf-portions', 'sched-add-btn', 'sf-cancel', 'sf-save']
    .map(id => [id, element()]));
  const queryAll = selector => ({
    '.day-chip': days, '.day-chip.on': days.filter(c => c.classList.contains('on')),
    '.portion-chip': portions, '.sched-edit-btn': editButtons,
  }[selector] || []);
  ids['sched-list'].querySelectorAll = queryAll;
  ids['sched-form'].querySelectorAll = queryAll;
  ids['sched-form'].querySelector = () => portions.find(c => c.classList.contains('on'));
  const calls = [], alerts = [];
  const scope = vm.createContext({
    document: {
      getElementById: id => ids[id] || null, querySelectorAll: queryAll,
      createElement: () => ({ querySelector: () => null }),
    },
    _currentDevice: { serial: 'feeder' }, _settings: {},
    _utcToLocal: value => value, _localToUtc: value => value, _schedTzOffset: () => 0,
    t: (key, values) => `${key}${values ? ':' + values.n : ''}`,
    escHtml: String, fmtTime12: String, fmtPortions: String,
    alert: message => alerts.push(message),
    api: async (method, path, body) => {
      calls.push({ method, path, body: JSON.parse(JSON.stringify(body)) });
      return { status: 'ok', mqtt: true };
    },
    plans,
  });
  vm.runInContext(readFileSync(new URL('../addon/app/modal-device.js', import.meta.url), 'utf8'), scope);
  vm.runInContext('_schedPlans = plans; wireScheduleTabHandlers();', scope);
  return {
    ids, days, calls, alerts,
    open: idx => idx == null ? ids['sched-add-btn'].onclick() : editButtons[idx].onclick(),
    toggleSound(on) {
      ids['sf-sound'].checked = on;
      ids['sf-sound'].events.change({ target: ids['sf-sound'] });
    },
    save: () => ids['sf-save'].onclick(),
    html: () => vm.runInContext('buildScheduleTab(_schedPlans)', scope),
  };
}

test('new meals start with sound on, two plays, and require a repeat day', async () => {
  const editor = setup();
  editor.open();
  assert.equal(editor.ids['sf-sound'].checked, true);
  assert.equal(Number(editor.ids['sf-sound-times'].value), 2);
  assert.equal(editor.ids['sf-sound-times-wrap'].style.display, 'flex');
  assert.ok(editor.days.every(day => !day.classList.contains('on')));
  await editor.save();
  assert.equal(editor.calls.length, 0);
  assert.deepEqual(editor.alerts, ['schedule.err_no_days']);
  editor.days[0].onclick();
  await editor.save();
  const saved = editor.calls[0].body[0];
  assert.equal(saved.enableAudio, true);
  assert.equal(saved.audioTimes, 2);
  assert.deepEqual(saved.repeatDay, [1]);
});

test('incomplete existing plans stay silent in both the list and editor', async () => {
  const editor = setup([{ planId: 12, executionTime: '08:00', repeatDay: [1], grainNum: 1 }]);
  editor.open(0);
  assert.equal(editor.ids['sf-sound'].checked, false);
  assert.equal(Number(editor.ids['sf-sound-times'].value), 2);
  assert.equal(editor.ids['sf-sound-times-wrap'].style.display, 'none');
  assert.ok(!editor.html().includes('schedule.sound_times:'));
  await editor.save();
  assert.equal(editor.calls[0].body[0].enableAudio, false);
  assert.equal(editor.calls[0].body[0].audioTimes, 2);
});

test('an enabled plan missing its count displays and edits two plays', () => {
  const editor = setup([{ enableAudio: true, executionTime: '08:00', repeatDay: [1] }]);
  assert.ok(editor.html().includes('schedule.sound_times:2'));
  editor.open(0);
  assert.equal(Number(editor.ids['sf-sound-times'].value), 2);
});

for (const count of [1, 2, 5]) {
  test(`sound off/on and saving retain ${count} total plays and existing plan settings`, async () => {
    const plan = { planId: 12, executionTime: '08:00', repeatDay: [1, 3], grainNum: 8,
      enableAudio: true, audioTimes: count, _enabled: false, skipEndTime: 9999999999999, label: 'Dinner' };
    const editor = setup([plan]);
    editor.open(0);
    editor.toggleSound(false);
    assert.equal(editor.ids['sf-sound-times-wrap'].style.display, 'none');
    editor.toggleSound(true);
    assert.equal(Number(editor.ids['sf-sound-times'].value), count);
    editor.toggleSound(false);
    await editor.save();
    const saved = editor.calls[0].body[0];
    assert.equal(saved.enableAudio, false);
    assert.equal(saved.audioTimes, count);
    for (const key of ['planId', 'grainNum', '_enabled', 'skipEndTime', 'label']) {
      assert.equal(saved[key], plan[key], key);
    }
    assert.deepEqual(saved.repeatDay, plan.repeatDay);
  });
}

test('invalid enabled playback counts cannot be saved', async () => {
  for (const value of ['', '0', '6', '1.5']) {
    const editor = setup([{ enableAudio: true, repeatDay: [1], audioTimes: 2 }]);
    editor.open(0);
    editor.ids['sf-sound-times'].value = value;
    await editor.save();
    assert.equal(editor.calls.length, 0, value);
    assert.equal(editor.ids['sf-sound-times'].validationMessage, 'schedule.err_sound_repetitions');
    editor.toggleSound(false);
    await editor.save();
    assert.equal(editor.calls[0].body[0].audioTimes, 2);
  }
});

test('playback picker offers exactly one through five with two selected', () => {
  const html = setup().html();
  const select = html.match(/<select[^>]*id="sf-sound-times"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...select.matchAll(/<option value="(\d+)"/g)].map(m => Number(m[1])), [1, 2, 3, 4, 5]);
  assert.match(select, /<option value="2" selected>/);
});

for (const count of [32, 48]) {
  test(`captured ${count}-portion schedules can be edited without losing their amount`, async () => {
    const editor = setup([{planId: 6229292, executionTime: '17:10', repeatDay: [7,1,0,0,0,0,0],
      grainNum: count, enableAudio: true, audioTimes: 5}]);
    assert.ok(!editor.html().includes('schedule.daily'));
    editor.open(0);
    assert.equal(Number(editor.ids['sf-portions'].value), count);
    await editor.save();
    const saved = editor.calls[0].body[0];
    assert.equal(saved.grainNum, count);
    assert.equal(saved.audioTimes, 5);
    assert.equal(saved.planId, 6229292);
    assert.deepEqual(saved.repeatDay, [1,7]);
    assert.ok(saved.syncTime > 0);
  });
}

test('food amount picker offers 1 through 48 portions and rejects invalid input', async () => {
  const editor = setup();
  const select = editor.html().match(/<select[^>]*id="sf-portions"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...select.matchAll(/<option value="(\d+)"/g)].map(m => Number(m[1])), Array.from({length:48}, (_,i)=>i+1));
  editor.open();
  editor.days[0].onclick();
  for (const value of ['', '0', '49', '1.5']) {
    editor.ids['sf-portions'].value = value;
    await editor.save();
    assert.equal(editor.calls.length, 0);
    assert.equal(editor.alerts.at(-1), 'schedule.err_portions');
  }
});
