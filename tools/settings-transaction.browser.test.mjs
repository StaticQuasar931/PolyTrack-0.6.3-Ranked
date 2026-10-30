import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';

const require = createRequire(new URL('./verifier/package.json', import.meta.url));
const {chromium} = require('playwright');
const patch = await fs.readFile(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const main = await fs.readFile(new URL('../main.bundle.js', import.meta.url), 'utf8');
function block(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const helpers = block(patch, '  let settingsPreferenceTransaction=', '  async function currentUserIsModerator(');
const enhance = block(patch, '  function ensureSettingsEnhancements(', '  function lobbyShortcutButtons(');
const preferences = block(patch, '  let lastPlacementUpdateAt=', '  let settingsPreferenceTransaction=');
const native = block(main, 'var qs,Qs,Js,', ';var wo=');
let browser;
before(async () => { browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})}); });
after(async () => { await browser?.close(); });

const keys = ['reduced-effects', 'pb-podiums', 'pb-podiums-verified-only', 'compact-ranked', 'show-racer-codes', 'plain-racer-themes', 'ui-font-scale', 'rp-decimals'].map(key => 'polytrack-0.6.2-' + key).concat('polytrack-0.6.3-compact-track-data','polytrack-0.6.3-unplayed-player-counts');
const credential = 'polytrack-0.6.2-turn-backup-code';
async function fixture(t, seeded = false) {
  const page = await browser.newPage();
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url() === 'http://localhost/') return route.fulfill({contentType: 'text/html', body: '<!doctype html><body><div id="ui"></div><p id="rp"></p>'});
    if (/^http:\/\/localhost\/images\/(cancel|reset_settings|apply)\.svg$/.test(route.request().url())) return route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>'});
    external.push(route.request().url());
    return route.abort();
  });
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); assert.deepEqual(external, [], 'no network or Firebase'); });
  await page.goto('http://localhost/');
  await page.evaluate(({helpers, enhance, preferences, native, keys, credential, seeded}) => {
    const initial = Object.fromEntries(keys.map(key => [key, seeded ? key.endsWith('ui-font-scale') ? '95' : key.endsWith('rp-decimals') ? '4' : '0' : null]));
    for (const [key, value] of Object.entries(initial)) if (value !== null) localStorage.setItem(key, value);
    localStorage.setItem(credential, 'old-code');
    // Throw on unrelated reads or storage enumeration, not just unexpected writes.
    const allowed = new Set([...keys, credential]);
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    for (const [name, original] of [['getItem', get], ['setItem', set], ['removeItem', remove]]) Storage.prototype[name] = function(key, ...args) {
      if (!allowed.has(key)) throw Error('Unrelated storage access: ' + key);
      return original.call(this, key, ...args);
    };
    Storage.prototype.key = () => { throw Error('Storage enumeration forbidden'); };
    Object.defineProperty(window, 'firebase', {get() { throw Error('Firebase forbidden'); }});
    const NativeObserver = window.MutationObserver;
    window.liveSettingsObservers = 0;
    window.MutationObserver = class extends NativeObserver {
      observe(target, options) {
        super.observe(target, options);
        // Ignore Playwright's own DOM observers when checking transaction cleanup.
        if (target === document.body && options.childList && options.subtree && Object.keys(options).length === 2) {
          if (!this.active) window.liveSettingsObservers++;
          this.active = true;
        }
      }
      disconnect() { super.disconnect(); if (this.active) window.liveSettingsObservers--; this.active = false; }
    };
    window.expected = initial;
    const api = new Function('native', `
      const recordPlacementUi=null;
      const renderEntries=()=>document.querySelector('#rp').textContent=formatRp(1.23456);
      const openDeveloperInformation=async()=>{};
      const saveMultiplayerBackupCode=async(input,button)=>{localStorage.setItem('${credential}',input.value);button.textContent='Verified';return true;};
      ${preferences}
      ${helpers}
      ${enhance}
      const R={gn:(self,state,kind,method)=>kind==='m'?method:state.get(self),GG:(self,state,value)=>{state.set(self,value);return value;}};
      const P={A:new Proxy({}, {get:(_,key)=>key})},ge={A:new Proxy({}, {get:(_,key)=>key})};
      const Ks={languageNames:[{name:'English',code:'en-US'}],getFromLanguage:(_,text)=>text};
      const ve=key=>key||'';
      const NativeSettings=new Function('R','P','ge','Ks','ve',native+';return bo;')(R,P,ge,Ks,ve);
      const values=new Map([['Language','en-US']]);
      const store={getSetting:key=>values.get(key)??'false',getSettingBoolean:()=>false,getSettingNumber:()=>50,
        getSettings:()=>values,getKeyBindings:()=>new Map(),getKeyBinding:()=>[null,null],
        updateSettings:rows=>{for(const [key,value] of rows)values.set(key,value);},saveSettings(){},setKeyBindings(){},
        defaultSettings:()=>new Map([['Language','en-US']]),defaultKeyBindings:()=>new Map()};
      let menu;
      const open=()=>{menu=new NativeSettings(document.querySelector('#ui'),{}, {playUIClick(){}},{isShadowQualitySupported:()=>true},store,{refreshMeshes(){}},
        {showConfirm(){},hide(){}},()=>menu.dispose());ensureSettingsEnhancements();applyUiPreferences();renderEntries();};
      return {open,enhance:ensureSettingsEnhancements,dispose:()=>menu.dispose(),write:(key,value)=>settingsPreferenceTransaction.write(key,value)};
    `)(native);
    window.api = api;
    api.open();
  }, {helpers, enhance, preferences, native, keys, credential, seeded});
  assert.deepEqual(await read(page), await page.evaluate(() => expected), 'opening does not write defaults');
  return page;
}
async function read(page) { return page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), keys); }
async function change(page) {
  for (const button of await page.locator('#sqRankedSettings .sq-setting-row:not(.sq-setting-secret) button').all()) await button.click();
  await page.locator('#sqRpDecimals').selectOption('2');
  await page.getByRole('slider', {name: 'UI text size'}).fill('120');
  assert.equal(await page.locator('html').evaluate(node => node.style.getPropertyValue('--sq-ui-scale')), '1.2');
  assert.equal(await page.locator('#rp').textContent(), '1.23');
}
for (const seeded of [false, true]) for (const close of ['cancel', 'escape', 'dispose']) {
  test(`native ${close} restores ${seeded ? 'saved' : 'absent'} preferences and reopening`, async t => {
    const page = await fixture(t, seeded), initial = await read(page);
    await change(page);
    assert.notDeepEqual(await read(page), initial, 'live preview writes');
    if (close === 'escape') await page.keyboard.press('Escape');
    else if (close === 'dispose') await page.evaluate(() => api.dispose());
    else await page.locator('.settings-menu-ui > .button-wrapper > .cancel img').click();
    await page.waitForFunction(() => !document.querySelector('.settings-menu-ui'));
    assert.equal(await page.evaluate(() => liveSettingsObservers), 0, 'observer disposed on close');
    assert.deepEqual(await read(page), initial);
    assert.equal(await page.locator('html').evaluate(node => node.style.getPropertyValue('--sq-ui-scale')), seeded ? '0.95' : '1');
    assert.equal(await page.locator('#rp').textContent(), seeded ? '1.2346' : '1.235');
    await page.evaluate(() => api.open());
    assert.deepEqual(await read(page), initial, 'opening must not materialize default keys');
    assert.equal(await page.locator('#sqRpDecimals').inputValue(), seeded ? '4' : '3');
    assert.equal(await page.getByRole('slider', {name: 'UI text size'}).inputValue(), seeded ? '95' : '100');
  });
}
test('native Apply commits preview; later Cancel restores the applied baseline', async t => {
  const page = await fixture(t);
  await change(page);
  const applied = await read(page);
  await page.locator('.settings-menu-ui > .button-wrapper > .apply img').click();
  assert.equal(await page.evaluate(() => liveSettingsObservers), 0, 'observer disposed on Apply');
  assert.deepEqual(await read(page), applied);
  await page.evaluate(() => api.open());
  await page.locator('#sqRpDecimals').selectOption('4');
  await page.keyboard.press('Escape');
  assert.deepEqual(await read(page), applied);
});
test('native Reset rebuild preserves transaction; saved credential is independent', async t => {
  const page = await fixture(t), initial = await read(page);
  await change(page);
  await page.locator('input[type=password]').fill('explicitly-saved-code');
  await page.locator('.sq-setting-secret button').click();
  await page.locator('.settings-menu-ui > .button-wrapper > .reset').click();
  await page.evaluate(() => api.enhance());
  assert.equal(await page.locator('#sqRpDecimals').inputValue(), '2');
  await page.getByRole('slider', {name: 'UI text size'}).fill('110');
  await page.keyboard.press('Escape');
  assert.deepEqual(await read(page), initial);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), credential), 'explicitly-saved-code');
});
test('temporary native hiding does not cancel; same-task disposal/reopen rolls back first', async t => {
  const page = await fixture(t), initial = await read(page);
  await change(page);
  const preview = await read(page);
  await page.evaluate(() => { const menu = document.querySelector('.settings-menu-ui'); menu.className = 'hidden'; });
  assert.deepEqual(await read(page), preview);
  await page.evaluate(() => { document.querySelector('#ui > .hidden').className = 'settings-menu-ui'; api.enhance(); api.dispose(); api.open(); });
  assert.deepEqual(await read(page), initial);
  assert.equal(await page.locator('#sqRpDecimals').inputValue(), '3');
});
test('Cancel leaves untouched preferences and unsaved credential text alone', async t => {
  const page = await fixture(t);
  await page.locator('#sqRpDecimals').selectOption('2');
  await page.locator('input[type=password]').fill('not-saved');
  await page.evaluate(() => localStorage.setItem('polytrack-0.6.2-ui-font-scale', '105'));
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), credential), 'old-code');
  assert.equal((await read(page))['polytrack-0.6.2-ui-font-scale'], '105', 'untouched keys are not restored from a whole-storage snapshot');
  assert.equal((await read(page))['polytrack-0.6.2-rp-decimals'], null);
});
test('transaction rejects credential and arbitrary keys before storage access', async t => {
  const page = await fixture(t);
  for (const key of [credential, 'unrelated-origin-key']) {
    await assert.rejects(page.evaluate(key => api.write(key, 'forbidden'), key), /Unsupported settings preference/);
  }
  assert.equal(await page.evaluate(key => localStorage.getItem(key), credential), 'old-code');
});
