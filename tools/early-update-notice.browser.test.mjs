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
