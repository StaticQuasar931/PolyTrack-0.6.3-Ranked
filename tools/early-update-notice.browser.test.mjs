import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {RELEASE_INFO} from './release-info.mjs';
const require = createRequire(new URL('./verifier/package.json', import.meta.url));
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../', import.meta.url);

test('real index shows one readable notice before deferred game boot, then respects run and acknowledgement guards', {timeout:45000}, async t => {
  const browser = await chromium.launch({headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:320,height:568}, serviceWorkers:'block'});
  const errors = [], external = [], delayed = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://early-notice.test') {external.push(url.href); return route.abort();}
    if (/\/(main\.bundle|polytrack_062_patch|error_screen\.bundle|public-name-policy)\.js$/.test(url.pathname)) {
      delayed.push(route); return;
    }
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try {
      const body = await readFile(new URL(path, root));
      const ext = path.split('.').at(-1);
      const contentType = {html:'text/html',mjs:'text/javascript',js:'text/javascript',css:'text/css',svg:'image/svg+xml',woff2:'font/woff2'}[ext] || 'application/octet-stream';
      return route.fulfill({body, contentType});
    } catch {return route.abort();}
  });
  await page.goto('https://early-notice.test/', {waitUntil:'commit'});
  const notice = page.locator('dialog[data-site-installed-revision][open]');
  await notice.waitFor({timeout:15000});
  assert.ok(delayed.length >= 2, 'game scripts are still withheld');
  assert.equal(await page.evaluate(() => document.readyState), 'interactive');
  assert.equal(await page.locator('.main-buttons-container').count(), 0);
  assert.equal(await notice.locator('h2').textContent(), `PolyTrack Ranked - Update ${RELEASE_INFO.number}`);
  assert.equal(await notice.evaluate(node => {
    const box = node.getBoundingClientRect();
    return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && node.scrollWidth <= node.clientWidth;
  }), true, 'loading notice fits a narrow phone');
  await page.evaluate(async revision => {
    const api = await import(`/tools/site-updates.mjs?v=${revision}`);
    const release = (await import(`/tools/release-info.mjs?v=${revision}`)).RELEASE_INFO;
    const options = {document, revision:release.revision, release, isReady:() => false};
    window.lateNotice = api.installInstalledRevisionNotice(options);
    if (window.lateNotice !== api.installInstalledRevisionNotice(options)) throw Error('duplicate notice installation');
    document.getElementById('ui').innerHTML = '<div class="loading-screen-ui"></div>';
  }, RELEASE_INFO.revision);
  assert.equal(await notice.count(), 1);
  await page.evaluate(() => {
    document.getElementById('ui').innerHTML = '<div class="game-ui" hidden></div><div class="menu-ui"><div class="main-buttons-container">Play</div></div>';
  });
  await notice.waitFor({state:'detached'});
  await page.evaluate(() => {document.getElementById('ui').innerHTML = '<div class="loading-screen-ui"></div>'; lateNotice.resume();});
  assert.equal(await notice.count(), 0, 'later track loading cannot reuse boot exception');
  await page.evaluate(() => {
    document.getElementById('ui').innerHTML = '<div class="menu-ui" style="width:200px;height:100px"><div class="main-buttons-container">Play</div></div>';
  });
  await notice.waitFor();
  assert.equal(await notice.count(), 1);
  await notice.getByRole('button', {name:'OK', exact:true}).click();
  assert.equal(await notice.count(), 0);
  assert.equal(await page.evaluate(number => localStorage.getItem('polytrack-site-update-ack-release-v1:' + number), RELEASE_INFO.number), 'acknowledged');
  await page.evaluate(() => {lateNotice.resume(); dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));});
  assert.equal(await notice.count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], 'early notice performs no external requests');
  for (const route of delayed) await route.fulfill({contentType:'text/javascript', body:''});
  await page.reload({waitUntil:'commit'});
  await page.waitForFunction(revision => [...performance.getEntriesByType('resource')].some(entry => entry.name.includes(`site-update-menu-state.mjs?v=${revision}`)), RELEASE_INFO.revision);
  await page.evaluate(async revision => {await import(`/tools/early-update-notice.mjs?v=${revision}`);}, RELEASE_INFO.revision);
  assert.equal(await notice.count(), 0, 'acknowledged release stays hidden across reload');
});

for (const patchFirst of [false, true]) test(`native loading with an older acknowledgement and ${patchFirst ? 'patch-first' : 'early-first'} installation shows the notice before WASM`, {timeout:45000}, async t => {
  const browser = await chromium.launch({headless:true}); t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:320,height:568},serviceWorkers:'block'});
  const errors = [], wasm = [], calls = [];
  let menuRoute;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(previous => {
    localStorage.setItem('polytrack-site-update-ack-release-v1:'+previous, 'acknowledged');
    localStorage.setItem('polytrack-site-update-last-ack-v2', JSON.stringify({number:previous,commit:null}));
  }, RELEASE_INFO.number-1);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://native-notice.test') return route.abort();
    if (/\.wasm$/.test(url.pathname)) {wasm.push(url.pathname); return;}
    if (patchFirst && url.pathname.endsWith('/tools/site-update-menu-state.mjs')) {menuRoute=route; return;}
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try {
      let body = await readFile(new URL(relative, root));
      if (relative === 'tools/site-updates.mjs') {
        const source=body.toString();
        const anchor='  const existing = noticeInstallations.get(document);';
        assert.ok(source.includes(anchor));
        body=Buffer.from(source.replace(anchor, `  (window.__noticeCalls ||= []).push({existing:noticeInstallations.has(document),ready:String(isReady)});\n${anchor}`));
      }
      const contentType={html:'text/html',mjs:'text/javascript',js:'text/javascript',css:'text/css',svg:'image/svg+xml',woff2:'font/woff2',json:'application/json'}[relative.split('.').at(-1)]||'application/octet-stream';
      return route.fulfill({body,contentType});
    } catch {return route.abort();}
  });
  await page.goto('https://native-notice.test/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => document.querySelector('#ui > .menu-ui.loading-screen'),null,{timeout:20000});
  if (patchFirst) {
    await page.waitForFunction(() => window.__noticeCalls?.some(call => call.ready.includes('main-buttons-container')),null,{timeout:15000});
    assert.ok(menuRoute);
    await menuRoute.fulfill({body:await readFile(new URL('./site-update-menu-state.mjs',import.meta.url)),contentType:'text/javascript'});
  }
  await page.waitForFunction(() => window.__noticeCalls?.some(call => !call.ready.includes('main-buttons-container')),null,{timeout:15000});
  calls.push(...await page.evaluate(() => window.__noticeCalls));
  const notice=page.locator('dialog[data-site-installed-revision][open]');
  await notice.waitFor({timeout:3000});
  assert.equal(await notice.count(),1);
  assert.equal(await notice.getAttribute('data-site-installed-revision'),String(RELEASE_INFO.revision));
  assert.equal(await notice.locator('h2').textContent(),`PolyTrack Ranked - Update ${RELEASE_INFO.number}`);
  assert.ok(wasm.length>0,'actual native engine is still withheld');
  assert.equal(await page.locator('.main-buttons-container:not(.hidden)').count(),0);
  assert.equal(await page.evaluate(() => !!document.querySelector('.track-selection-ui.hidden')),true,'real precreated hidden menu is present');
  assert.equal(await notice.evaluate(node => {const box=node.getBoundingClientRect();return box.left>=0&&box.top>=0&&box.right<=innerWidth&&box.bottom<=innerHeight&&node.scrollWidth<=node.clientWidth;}),true);
  if (patchFirst) assert.equal(calls[0].ready.includes('main-buttons-container'),true,'native patch really installed first');
  await page.evaluate(() => document.getElementById('ui').append(Object.assign(document.createElement('div'),{className:'game-ui hidden'})));
  await notice.waitFor({state:'detached'});
  assert.equal(await page.evaluate(number => localStorage.getItem('polytrack-site-update-ack-release-v1:'+number),RELEASE_INFO.number),null,'run veto never acknowledges the notice');
  assert.deepEqual(errors,[]);
});
