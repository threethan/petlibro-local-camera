import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('copies Home Assistant theme variables into the ingress UI tokens', () => {
  const applied = {};
  const root = { style: { setProperty: (name, value) => { applied[name] = value; } } };
  const haRoot = {};
  const hostDocument = {
    documentElement: {},
    body: {},
    head: {},
    querySelector: selector => selector === 'home-assistant' ? haRoot : null,
  };
  const theme = new Map([
    ['--primary-background-color', '#102030'],
    ['--ha-card-background', '#203040'],
    ['--ha-card-box-shadow', '0 1px 2px #000'],
    ['--ha-card-border-width', '0'],
    ['--ha-card-border-color', 'transparent'],
    ['--ha-card-border-radius', '16px'],
    ['--secondary-background-color', '#304050'],
    ['--divider-color', '#405060'],
    ['--primary-color', '#506070'],
    ['--primary-text-color', '#f0f0f0'],
    ['--secondary-text-color', '#b0b0b0'],
    ['--error-color', '#f00'],
    ['--success-color', '#0f0'],
    ['--warning-color', '#ff0'],
    ['--primary-font-family', 'Theme Font'],
    ['--wa-color-fill-loud', '#123456'],
    ['--wa-color-on-loud', '#ffffff'],
    ['--wa-form-control-height', '44px'],
    ['--ha-space-4', '16px'],
    ['--ha-border-radius-pill', '9999px'],
    ['--ha-color-fill-primary-loud-resting', 'var(--ha-color-primary-40)'],
    ['--ha-color-primary-40', '#1479bc'],
    ['--ha-color-on-primary-loud', '#fefefe'],
  ]);
  const scope = vm.createContext({
    document: { documentElement: root },
    window: { parent: { document: hostDocument }, MutationObserver: null },
    getComputedStyle: element => ({ getPropertyValue: name => element === haRoot ? (theme.get(name) || '') : '' }),
    setTimeout: () => 0,
    MutationObserver: null,
    Map,
    Object,
  });
  vm.runInContext(readFileSync(new URL('../addon/app/theme.js', import.meta.url), 'utf8'), scope);
  assert.equal(applied['--pl-bg'], '#102030');
  assert.equal(applied['--pl-surface'], '#203040');
  assert.equal(applied['--pl-accent'], '#506070');
  assert.equal(applied['--pl-accent-dim'], '#506070');
  assert.equal(applied['--ha-card-background'], '#203040');
  assert.equal(applied['--ha-card-box-shadow'], '0 1px 2px #000');
  assert.equal(applied['--ha-card-border-width'], '0');
  assert.equal(applied['--ha-card-border-color'], 'transparent');
  assert.equal(applied['--ha-card-border-radius'], '16px');
  assert.equal(applied['--primary-font-family'], 'Theme Font');
  assert.equal(applied['--wa-color-fill-loud'], '#123456');
  assert.equal(applied['--wa-color-on-loud'], '#ffffff');
  assert.equal(applied['--wa-form-control-height'], '44px');
  assert.equal(applied['--pl-button-padding-inline'], '16px');
  assert.equal(applied['--pl-button-radius'], '9999px');
  assert.equal(applied['--pl-button-accent-bg'], '#1479bc');
  assert.equal(applied['--pl-button-accent-text'], '#fefefe');
});
