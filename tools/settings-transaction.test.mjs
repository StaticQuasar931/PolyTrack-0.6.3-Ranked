import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {installedSettingsSources} from './settings-transaction.mjs';

const main = fs.readFileSync(new URL('../main.bundle.js', import.meta.url), 'utf8');
const patch = fs.readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const sources = installedSettingsSources(main, patch);
const precision = 'polytrack-0.6.2-rp-decimals', scale = 'polytrack-0.6.2-ui-font-scale';
function fixture(initial = []) {
  const data = new Map(initial), reads = [], callbacks = [];
  let applied = 0, rendered = 0;
  const storage = {getItem(key) { reads.push(key); return data.get(key) ?? null; }, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key)};
  class Observer { constructor(callback) {this.callback = callback; callbacks.push(this);} observe() {this.active = true;} disconnect() {this.active = false;} }
  const api = new Function('localStorage', 'MutationObserver', 'document', 'applyUiPreferences', 'renderEntries', sources.helpers + `;return {begin:beginSettingsPreferenceTransaction,write:writeSettingsPreference,current:()=>settingsPreferenceTransaction};`)(storage, Observer, {body: {}}, () => applied++, () => rendered++);
  function menu() {
    const listeners = new Map(), footer = {};
    return {isConnected: true, footer, listeners, querySelector: () => footer,
      addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: type => listeners.delete(type)};
  }
  const settings = menu();
  settings.contains = row => row.menu === settings;
  api.begin(settings);
  const click = name => settings.listeners.get('click')?.({target: {closest: () => ({parentElement: settings.footer, classList: {contains: value => value === name}})}});
  return {data, reads, api, settings, callbacks, click, effects: () => ({applied, rendered})};
}

test('fixture reads native colors and all runtime-injected settings style layers', () => {
  assert.match(sources.nativeCss, /--surface-secondary-color: #212b58/);
  assert.match(sources.nativeCss, /\.settings-menu-ui > \.container/);
  assert.match(sources.installedCss, /\.sq-setting-secret\.is-verified/);
  assert.match(sources.installedCss, /\.sq-settings-grid \.sq-setting-wide/);
});
test('opening and rebuilding do not materialize defaults or duplicate observers', () => {
  const f = fixture(); f.api.begin(f.settings);
  assert.deepEqual([...f.data], []); assert.deepEqual(f.reads, []);
  assert.equal(f.callbacks.length, 1);
});
test('Cancel restores absent keys and refreshes precision preview', () => {
  const f = fixture(); f.api.write({menu: f.settings}, precision, '2'); f.click('cancel');
  assert.equal(f.data.has(precision), false); assert.equal(f.api.current(), null);
  assert.deepEqual(f.effects(), {applied: 1, rendered: 1});
  assert.equal(f.callbacks[0].active, false); assert.equal(f.settings.listeners.size, 0);
});
test('multiple preview writes restore the original saved value only', () => {
  const f = fixture([[scale, '95']]);
  f.api.write({menu: f.settings}, scale, '110'); f.api.write({menu: f.settings}, scale, '125'); f.click('cancel');
  assert.equal(f.data.get(scale), '95'); assert.deepEqual(f.effects(), {applied: 1, rendered: 0});
});
test('Apply commits preview and later Cancel uses that new baseline', () => {
  const f = fixture(); f.api.write({menu: f.settings}, precision, '2'); f.click('apply');
  assert.equal(f.data.get(precision), '2'); assert.deepEqual(f.effects(), {applied: 0, rendered: 0});
  f.api.begin(f.settings); f.api.write({menu: f.settings}, precision, '4'); f.click('cancel');
  assert.equal(f.data.get(precision), '2');
});
test('native Reset rebuild keeps the original transaction baseline', () => {
  const f = fixture([[precision, '4']]); f.api.write({menu: f.settings}, precision, '2');
  const transaction = f.api.current(); f.api.begin(f.settings);
  assert.equal(f.api.current(), transaction); f.click('cancel'); assert.equal(f.data.get(precision), '4');
});
test('temporary hiding is harmless; disposal cancels the preview', () => {
  const f = fixture(); f.api.write({menu: f.settings}, precision, '2'); f.callbacks[0].callback();
  assert.equal(f.data.get(precision), '2'); f.settings.isConnected = false; f.callbacks[0].callback();
  assert.equal(f.data.has(precision), false);
});
test('credential and arbitrary keys are rejected before reads; outside rows ignored', () => {
  const f = fixture();
  for (const key of ['polytrack-0.6.2-turn-backup-code', 'unrelated']) assert.throws(() => f.api.current().write(key, 'x'), /Unsupported settings preference/);
  f.api.write({}, precision, '2'); assert.deepEqual(f.reads, []); assert.equal(f.data.size, 0);
});
test('Cancel leaves credentials and untouched preferences alone', () => {
  const f = fixture(); f.api.write({menu: f.settings}, precision, '2');
  f.data.set(scale, '105'); f.data.set('polytrack-0.6.2-turn-backup-code', 'explicitly-saved'); f.click('cancel');
  assert.equal(f.data.get(scale), '105'); assert.equal(f.data.get('polytrack-0.6.2-turn-backup-code'), 'explicitly-saved');
});
test('settings-only CSS uses native colors, cancels card decoration and full-width range overrides', () => {
  const css = fs.readFileSync(new URL('../responsive-ui.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('.settings-menu-ui #sqRankedSettings{'), css.indexOf('/* Menu coordinates'));
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(|gradient\(/i);
  assert.match(block, /background:transparent!important;box-shadow:none!important/);
  assert.match(block, /grid-column:auto!important/);
  assert.match(block, /margin:8px 0!important/);
  assert.match(block, /\.button\.selected\{background-color:var\(--button-hover-color\)!important/);
  assert.match(block, /min-height:44px/);
});
