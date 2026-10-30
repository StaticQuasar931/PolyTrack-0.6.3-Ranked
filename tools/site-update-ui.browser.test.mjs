import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
const require = createRequire(new URL('./verifier/package.json', import.meta.url));
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = await readFile(new URL('./site-updates.mjs', import.meta.url), 'utf8');
const nativeBundle = await readFile(new URL('../main.bundle.js', import.meta.url), 'utf8');
const controlStart = nativeBundle.lastIndexOf('.button {');
const controlEnd = nativeBundle.indexOf('.button > img.button-icon', controlStart);
assert.ok(controlStart > 0 && controlEnd > controlStart);
const nativeControls = nativeBundle.slice(controlStart, controlEnd).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
const font = await readFile(new URL('../forced_square.woff2', import.meta.url));
const release = {number: 241, revision: 209, preparedAt: '2026-10-01T12:00:00.000Z',
  notes: ['Play a focused racer with Space.', 'Clearer update information.']};

test('release UI keeps native hover, keyboard acknowledgement, live local age and phone fit', {timeout: 90000}, async t => {
  const browser = await chromium.launch({headless: true}); t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1366, height: 768}, serviceWorkers: 'block'});
  const external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.href === 'https://update-ui.test/') return route.fulfill({contentType: 'text/html', body: '<button id="play">Play</button><time id="help-age"></time>'});
    if (url.href === 'https://update-ui.test/tools/site-updates.mjs') return route.fulfill({contentType: 'text/javascript', body: source});
    external.push(url.href); return route.abort();
  });
  await page.goto('https://update-ui.test/');
  await page.addStyleTag({content: `@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font.toString('base64')})}
    :root{--button-color:#112052;--button-hover-color:#334b77;--button-active-color:#151f41;--text-color:#fff}
    body{background:#101a35;color:#fff;font:22px ForcedSquare,sans-serif}${nativeControls}`});
  await page.evaluate(async release => {
    const api = await import('/tools/site-updates.mjs'); window.updateAPI = api;
    window.publicationDate = '2026-10-02T12:00:00.000Z';
    window.localNow = Date.parse(publicationDate); window.ageTimers = new Map(); let next = 0;
    window.ageOptions = {verifiedReleasePointer:{schemaVersion:1,repository:'StaticQuasar931/PolyTrack-0.6.3-Ranked',
      commit:'a'.repeat(40),indexSha256:'b'.repeat(64),snapshotDirectory:'public-snapshots70',publishedAt:publicationDate},
      installedCommit:'a'.repeat(40),now: () => localNow, setTimeout: (fn, delay) => { ageTimers.set(++next, {fn, delay}); return next; },
      clearTimeout: id => ageTimers.delete(id)};
    window.advance = elapsed => {
      window.localNow = Date.parse(publicationDate) + elapsed;
      for (const [id, {fn}] of [...ageTimers]) { ageTimers.delete(id); fn(); }
    };
    window.racing = true; window.nativeKeys = [];
    document.addEventListener('keydown', event => nativeKeys.push(event.key), true);
    document.addEventListener('keyup', event => nativeKeys.push(event.key), true);
    document.getElementById('play').focus();
    window.notice = api.installInstalledRevisionNotice({revision: 209, release, isReady: () => true,
      isIdle: () => !racing, ...ageOptions});
    window.helpAge = api.bindReleaseUpdateAge(document.getElementById('help-age'), {release, ...ageOptions});
  }, release);
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await page.evaluate(() => ageTimers.size), 1, 'Help API works without mounting a notice');
  await page.evaluate(() => { racing = false; notice.resume(); });
  const dialog = page.getByRole('dialog', {name: 'PolyTrack Ranked - Update 241'}), age = dialog.locator('time');
  assert.doesNotMatch(await dialog.innerText(), /209|client revision|saved runs/i);
  assert.equal(await age.getAttribute('datetime'), '2026-10-02T12:00:00.000Z');
  assert.equal(await age.getAttribute('title'), await page.evaluate(() => `Updated: ${new Date(publicationDate).toLocaleString()}`));
  for (const [elapsed, text] of [[60000, '1 minute'], [3600000, '1 hour'], [86400000, '1 day'], [604800000, '7 days']]) {
    await page.evaluate(elapsed => advance(elapsed), elapsed);
    assert.equal(await age.textContent(), `Updated ${text} ago`);
    assert.equal(await page.locator('#help-age').textContent(), await age.textContent());
    assert.equal(await page.evaluate(() => ageTimers.size), 2);
  }
  const ok = dialog.getByRole('button', {name: 'OK', exact: true});
  await page.mouse.move(0, 0);
  const idleWidth = await ok.evaluate(node => getComputedStyle(node, '::after').width);
  await ok.hover(); await page.waitForTimeout(160);
  assert.notEqual(await ok.evaluate(node => getComputedStyle(node, '::after').width), idleWidth, 'native hover fill expands');
  await page.keyboard.press('Tab');
  assert.equal(await ok.evaluate(node => node === document.activeElement), true);
  assert.equal(await ok.evaluate(node => getComputedStyle(node).textDecorationLine), 'underline');
  const evidence = process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR;
  if (evidence) await mkdir(evidence, {recursive: true});
  for (const [width, height] of [[1366, 768], [320, 568], [844, 320]]) {
    await page.setViewportSize({width, height});
    assert.equal(await dialog.evaluate(node => {
      const box = node.getBoundingClientRect();
      return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && node.scrollWidth <= node.clientWidth;
    }), true, `${width}x${height}`);
    if (evidence) await page.screenshot({path: join(evidence, `update-notice-${width}.png`)});
  }
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await dialog.count(), 0); assert.equal(await page.evaluate(() => ageTimers.size), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('polytrack-site-update-ack-release-v1:241')), null);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await dialog.count(), 1);
  await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('polytrack-site-update-ack-release-v1:241')), 'acknowledged');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'play');
  assert.deepEqual(await page.evaluate(() => nativeKeys), [], 'dialog keys never reach gameplay');
  await page.evaluate(() => { notice.dispose(); helpAge.dispose(); });
  assert.equal(await page.evaluate(() => ageTimers.size), 0);
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});

test('Google automatic launcher update reloads locally, bypasses its pointer cache and never opens GitHub', {timeout: 45000}, async t => {
  const browser = await chromium.launch({headless: true}); t.after(() => browser.close());
  const page = await browser.newPage({serviceWorkers: 'block'}), external = [];
  const commit = 'a'.repeat(40), indexSha256 = 'b'.repeat(64);
  const base = `https://cdn.jsdelivr.net/gh/StaticQuasar931/PolyTrack-0.6.3-Ranked@${commit}/`;
  let visits = 0;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.href === 'https://script.googleusercontent.com/userCodeAppPanel') {
      visits++;
      return route.fulfill({contentType: 'text/html', body: `<base href="${base}"><button id="play">Play</button>`});
    }
    external.push(url.href); return route.abort();
  });
  await page.goto('https://script.googleusercontent.com/userCodeAppPanel');
  await page.addScriptTag({content: source.replace(/\bexport /g, '') + '\nwindow.updateAPI={installSiteUpdates};'});
  await page.evaluate(async ({commit, indexSha256}) => {
    window.__polytrackAutomaticLoad = Promise.resolve(); window.safeToUpdate = false; window.fetchCount = 0;
    localStorage.setItem('saved-run', 'unchanged');
    localStorage.setItem('polytrack-automatic-release-v2', JSON.stringify({sha: commit, indexSha256, checkedAt: 12345}));
    window.updater = updateAPI.installSiteUpdates({revision: 209, isIdle: () => true, canReload: () => safeToUpdate,
      fetch: async () => { fetchCount++; return {ok: true, json: async () => ({revision: 210})}; }});
    await updater.check();
  }, {commit, indexSha256});
  const offer = page.getByRole('button', {name: 'Update available. Reload to update.', exact: true});
  assert.equal(await offer.count(), 1); assert.equal(await page.locator('a[data-site-update]').count(), 0);
  await offer.click(); assert.equal(visits, 1);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('polytrack-automatic-release-v2')).checkedAt), 12345);
  assert.equal(await page.evaluate(() => fetchCount), 1);
  await page.evaluate(() => { safeToUpdate = true; });
  await Promise.all([page.waitForNavigation({waitUntil: 'domcontentloaded'}), offer.click()]);
  assert.equal(visits, 2); assert.equal(page.url(), 'https://script.googleusercontent.com/userCodeAppPanel');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('polytrack-automatic-release-v2')).checkedAt), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('saved-run')), 'unchanged');
  assert.deepEqual(external, []);
});
