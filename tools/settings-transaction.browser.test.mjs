import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {installedSettingsSources} from './settings-transaction.mjs';

const require = createRequire(new URL('./verifier/package.json', import.meta.url));
const engines = require('playwright');
const engineName = process.env.POLYTRACK_SETTINGS_BROWSER || 'chromium';
if (!['chromium', 'firefox'].includes(engineName)) throw new Error('Unsupported settings browser: ' + engineName);
const captureDir = process.env.POLYTRACK_UI_CAPTURE_DIR;
async function saveEvidence(name, data) {
  if (!captureDir) return;
  await fs.mkdir(captureDir, {recursive: true});
  await fs.writeFile(captureDir + '/' + name, JSON.stringify(data, null, 2));
}
const patch = await fs.readFile(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const main = await fs.readFile(new URL('../main.bundle.js', import.meta.url), 'utf8');
const {helpers, enhance, preferences, native, nativeCss, installedCss} = installedSettingsSources(main, patch);
const responsiveCss = await fs.readFile(new URL('../responsive-ui.css', import.meta.url), 'utf8');
const font = await fs.readFile(new URL('../forced_square.woff2', import.meta.url));
const fixtureCss = nativeCss.replaceAll('__FONT__', 'data:font/woff2;base64,' + font.toString('base64')) + responsiveCss + installedCss;
let browser;
before(async () => {
  const executablePath = engineName === 'firefox' ? process.env.POLYTRACK_FIREFOX_EXECUTABLE : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  browser = await engines[engineName].launch({headless: true, timeout: 20000, ...(executablePath ? {executablePath} : {})});
  await saveEvidence('browser.json', {engine: engineName, version: browser.version(), executablePath: executablePath || engines[engineName].executablePath(), serial: true});
});
after(async () => { await browser?.close(); });

const keys = ['reduced-effects', 'pb-podiums', 'pb-podiums-verified-only', 'compact-ranked', 'show-racer-codes', 'plain-racer-themes', 'ui-font-scale', 'rp-decimals'].map(key => 'polytrack-0.6.2-' + key).concat('polytrack-0.6.3-compact-track-data','polytrack-0.6.3-unplayed-player-counts');
const credential = 'polytrack-0.6.2-turn-backup-code';
async function fixture(t, seeded = false) {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url() === 'http://localhost/') return route.fulfill({contentType: 'text/html', body: '<!doctype html><body><div id="ui"><div class="menu-ui"></div></div><p id="rp"></p>'});
    if (/^http:\/\/localhost\/images\/(cancel|reset_settings|apply)\.svg$/.test(route.request().url())) return route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>'});
    external.push(route.request().url());
    return route.abort();
  });
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); assert.deepEqual(external, [], 'no network or Firebase'); });
  await page.goto('http://localhost/');
  await page.addStyleTag({content: fixtureCss});
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
      const open=()=>{menu=new NativeSettings(document.querySelector('#ui > .menu-ui'),{}, {playUIClick(){}},{isShadowQualitySupported:()=>true},store,{refreshMeshes(){}},
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
  await page.locator('.sq-settings-advanced').evaluate(node=>{node.open=true;});
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
    else await page.locator('.settings-menu-ui > .button-wrapper > .cancel').click();
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
  await page.locator('.settings-menu-ui > .button-wrapper > .apply').click();
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
  await page.evaluate(() => { document.querySelector('#ui > .menu-ui > .hidden').className = 'settings-menu-ui'; api.enhance(); api.dispose(); api.open(); });
  assert.deepEqual(await read(page), initial);
  assert.equal(await page.locator('#sqRpDecimals').inputValue(), '3');
});
test('Cancel leaves untouched preferences and unsaved credential text alone', async t => {
  const page = await fixture(t);
  await page.locator('#sqRpDecimals').selectOption('2');
  await page.locator('.sq-settings-advanced').evaluate(node=>{node.open=true;});
  await page.locator('input[type=password]').fill('not-saved');
  await page.evaluate(() => localStorage.setItem('polytrack-0.6.2-ui-font-scale', '105'));
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), credential), 'old-code');
  assert.equal((await read(page))['polytrack-0.6.2-ui-font-scale'], '105', 'untouched keys are not restored from a whole-storage snapshot');
  assert.equal((await read(page))['polytrack-0.6.2-rp-decimals'], null);
});

test('common settings fill every grid row and keep technical controls collapsed',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.locator('.sq-settings-advanced').evaluate(node=>node.open),false);
  assert.equal(await page.locator('#sqRankedSettings>.sq-settings-grid>.sq-setting-row').count(),8);
  assert.equal(await page.getByRole('button',{name:'Unplayed track counts',exact:true}).getAttribute('aria-pressed'),'true');
  for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:844,height:390},{width:320,height:568}]){
    await page.setViewportSize(viewport);
    const metrics=await page.locator('#sqRankedSettings>.sq-settings-grid').evaluate(grid=>{
      const rows=new Map();
      for(const child of grid.children){const box=child.getBoundingClientRect(),y=Math.round(box.y);rows.set(y,(rows.get(y)||0)+1);}
      return {columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,rows:[...rows.values()],overflow:grid.scrollWidth>grid.clientWidth};
    });
    assert.equal(metrics.overflow,false,JSON.stringify(viewport));
    assert.ok(metrics.rows.every(count=>count===metrics.columns),JSON.stringify(metrics));
    if(process.env.POLYTRACK_UI_CAPTURE_DIR){
      await fs.mkdir(process.env.POLYTRACK_UI_CAPTURE_DIR,{recursive:true});
      await page.screenshot({path:`${process.env.POLYTRACK_UI_CAPTURE_DIR}/settings-${viewport.width}.png`});
    }
  }
});
test('settings footer reserves phone safe areas',async t=>{
  if(engineName!=='chromium'){t.skip('Safe-area inset emulation requires Chromium CDP; covered by the serial Chromium run.');return;}
  const page=await fixture(t);
  const cdp=await page.context().newCDPSession(page);
  for(const [width,height,insets]of [[390,844,{top:44,bottom:34,left:0,right:0}],[844,390,{top:0,bottom:21,left:44,right:44}]]){
    await page.setViewportSize({width,height});
    await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets});
    const padding=await page.locator('.settings-menu-ui>.button-wrapper').evaluate(node=>({bottom:parseFloat(getComputedStyle(node).paddingBottom),left:parseFloat(getComputedStyle(node).paddingLeft),right:parseFloat(getComputedStyle(node).paddingRight)}));
    for(const side of ['bottom','left','right'])assert.ok(padding[side]>=insets[side],JSON.stringify({width,height,insets,padding}));
  }
  await cdp.detach();
});
test('transaction rejects credential and arbitrary keys before storage access', async t => {
  const page = await fixture(t);
  for (const key of [credential, 'unrelated-origin-key']) {
    await assert.rejects(page.evaluate(key => api.write(key, 'forbidden'), key), /Unsupported settings preference/);
  }
  assert.equal(await page.evaluate(key => localStorage.getItem(key), credential), 'old-code');
});

test('installed style cascade preserves native colors, full rows and touch targets at every text size',async t=>{
  const cases=[];
  const page=await fixture(t);
  await page.evaluate(()=>document.fonts.ready);
  for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:844,height:390},{width:320,height:568}]){
    await page.setViewportSize(viewport);
    for(const scale of [0.85,1,1.25]){
      await page.locator('html').evaluate((node,scale)=>node.style.setProperty('--sq-ui-scale',scale),scale);
      await page.locator('.sq-settings-advanced').evaluate(node=>{node.open=true;});
      const metrics=await page.locator('#sqRankedSettings').evaluate(section=>{
        const style=getComputedStyle(section),text=style.getPropertyValue('--text-color').trim();
        const reference=document.createElement('span');reference.style.color=text;section.append(reference);
        const nativeText=getComputedStyle(reference).color;reference.remove();
        const color=variable=>{reference.style.color=style.getPropertyValue(variable).trim();section.append(reference);const value=getComputedStyle(reference).color;reference.remove();return value;};
        const palette={surface:color('--surface-color'),secondary:color('--surface-secondary-color'),tertiary:color('--surface-tertiary-color'),button:color('--button-color'),selected:color('--button-hover-color'),text:nativeText};
        const actual={surface:getComputedStyle(section.closest('.settings-menu-ui')).backgroundColor,secondary:getComputedStyle(section.parentElement).backgroundColor,rangeOutput:getComputedStyle(section.querySelector('output')).color,rangeAccent:getComputedStyle(section.querySelector('input[type=range]')).accentColor,select:getComputedStyle(section.querySelector('select')).backgroundColor,secret:getComputedStyle(section.querySelector('input[type=password]')).backgroundColor,verifiedButton:getComputedStyle(section.querySelector('.sq-setting-secret button')).backgroundColor,selected:[...section.querySelectorAll('button.selected')].map(node=>getComputedStyle(node).backgroundColor)};
        return {palette,actual,nativeText,rows:[...section.querySelectorAll('.sq-setting-row')].map(row=>{
          const s=getComputedStyle(row),box=row.getBoundingClientRect();
          return {background:s.backgroundColor,shadow:s.boxShadow,width:box.width,overflow:row.scrollWidth>row.clientWidth};
        }),controls:[...section.querySelectorAll('button,select,input,summary')].map(control=>{
          const box=control.getBoundingClientRect();return {height:box.height,right:box.right,left:box.left};
        }),labels:[...section.querySelectorAll('.sq-setting-row>p,.sq-setting-row>label')].map(node=>getComputedStyle(node).color)};
      });
      cases.push({viewport,scale,metrics});
      await saveEvidence('computed-settings.json',cases);
      assert.equal(metrics.actual.surface,metrics.palette.surface);
      assert.equal(metrics.actual.secondary,metrics.palette.secondary);
      assert.equal(metrics.actual.rangeOutput,metrics.palette.text);
      assert.equal(metrics.actual.rangeAccent,metrics.palette.text);
      assert.equal(metrics.actual.select,metrics.palette.tertiary);
      assert.equal(metrics.actual.secret,metrics.palette.tertiary);
      assert.equal(metrics.actual.verifiedButton,metrics.palette.button);
      assert.ok(metrics.actual.selected.every(color=>color===metrics.palette.selected));
      if(captureDir)await page.screenshot({path:captureDir+'/settings-'+viewport.width+'-scale-'+scale+'-advanced.png'});
      for(const row of metrics.rows){assert.equal(row.background,'rgba(0, 0, 0, 0)');assert.equal(row.shadow,'none');assert.equal(row.overflow,false,JSON.stringify({viewport,scale,row}));assert.ok(row.width>0);}
      for(const control of metrics.controls){assert.ok(control.height>=44,JSON.stringify({viewport,scale,control}));assert.ok(control.left>=0&&control.right<=viewport.width,JSON.stringify({viewport,scale,control}));}
      assert.ok(metrics.labels.every(color=>color===metrics.nativeText));
      for(const control of await page.locator('#sqRankedSettings button,#sqRankedSettings select,#sqRankedSettings input,#sqRankedSettings summary,.settings-menu-ui>.button-wrapper>button').all()){
        await control.scrollIntoViewIfNeeded();
        const target=await control.evaluate(node=>{const box=node.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return {label:node.getAttribute('aria-label')||node.textContent.trim(),height:box.height,reachable:hit===node||node.contains(hit)};});
        assert.ok(target.height>=44&&target.reachable,JSON.stringify({viewport,scale,target}));
      }
      await page.locator('.sq-settings-advanced').evaluate(node=>{node.open=false;});
      const rows=await page.locator('#sqRankedSettings>.sq-settings-grid').evaluate(grid=>{
        const counts=new Map();for(const child of grid.children){const y=Math.round(child.getBoundingClientRect().y);counts.set(y,(counts.get(y)||0)+1);}return {columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,counts:[...counts.values()]};
      });
      assert.ok(rows.counts.every(count=>count===rows.columns),JSON.stringify({viewport,scale,rows}));
    }
  }
});
