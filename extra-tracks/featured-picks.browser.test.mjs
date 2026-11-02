import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
let chromium; try { ({chromium} = require(process.env.PLAYWRIGHT_MODULE || '../tools/verifier/node_modules/playwright')); } catch {}
const sources = new Map(['catalog-ui.mjs', 'review.mjs', 'reviewed.mjs', 'reviewed-data.mjs', 'snapshot-popularity.mjs', 'featured-picks.mjs'].map(name => [name, fs.readFileSync(new URL(name, import.meta.url), 'utf8')]));
sources.set('tools/search-text.mjs', fs.readFileSync(new URL('../tools/search-text.mjs', import.meta.url), 'utf8'));
const font=fs.readFileSync(new URL('../forced_square.woff2',import.meta.url)).toString('base64');
const css = fs.readFileSync(new URL('catalog.css', import.meta.url), 'utf8')+`\n@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font})}body{font-family:ForcedSquare,sans-serif}`;
const entries = JSON.parse(fs.readFileSync(new URL('catalog.json', import.meta.url), 'utf8')).slice(0, 4);
const thumbnails = new Map(entries.filter(entry => entry.thumbnailUrl).map(entry => [entry.thumbnailUrl, fs.readFileSync(new URL('../' + entry.thumbnailUrl, import.meta.url))]));

test('featured discovery fits desktop and phone, uses existing callback and never downloads track bytes', {skip: !chromium}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    const unexpected = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url()), name = url.pathname.slice(1);
      if (url.origin !== 'http://featured.test') { unexpected.push(url.href); return route.abort(); }
      if (sources.has(name)) return route.fulfill({contentType: 'text/javascript', body: sources.get(name)});
      if (!name) return route.fulfill({contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><main id="root"></main>'});
      if (thumbnails.has(name)) return route.fulfill({contentType: name.endsWith('.webp') ? 'image/webp' : 'image/png', body: thumbnails.get(name)});
      if (/\.(png|webp)$/.test(name)) return route.abort();
      unexpected.push(url.href); return route.abort();
    });
    await page.goto('http://featured.test/'); await page.addStyleTag({content: css});
    await page.evaluate(async entries => {
      const {mountExtraTracks} = await import('/catalog-ui.mjs');
      window.played = [];
      window.fixtureEntries = entries;
      window.catalog = mountExtraTracks({document, root: document.querySelector('#root'), entries,
        now: () => Date.parse('2026-11-02T12:00:00Z'), onPlay: entry => window.played.push(entry.trackId)});
      window.catalog.open();
    }, entries);
    for (const [width, height] of [[1366, 900], [390, 844], [320, 740], [280, 653]]) {
      await page.setViewportSize({width, height});
      const showPicks=height>650&&(width>600||height>740);
      assert.equal(await page.locator('.sq-extra-pick').count(), 2);
      assert.equal(await page.locator('.sq-extra-featured').isVisible(), showPicks);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const search = page.getByRole('searchbox', {name: 'Search tracks'});
      await search.fill('Everlasting'); assert.equal(await page.locator('.sq-extra-featured').isHidden(), true);
      await search.fill('');
      assert.equal(await page.locator('.sq-extra-featured').isVisible(), showPicks);
      const listBox=await page.locator('.sq-extra-grid').boundingBox();
      assert.ok(listBox.y<height-100,'catalog remains visible at '+width+'x'+height);
      if(showPicks&&width>340){
        const buttons=await page.locator('.sq-extra-pick button').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().bottom));
        assert.ok(Math.abs(buttons[0]-buttons[1])<=1,'pick buttons align');
      }
      if (process.env.EXTRA_TRACKS_SCREENSHOT_DIR) await page.screenshot({path: process.env.EXTRA_TRACKS_SCREENSHOT_DIR + '/featured-' + width + 'x' + height + '.png'});
    }
    await page.setViewportSize({width:390,height:844});
    assert.match(await page.locator('.sq-extra-featured').innerText(), /Curated selection/);
    assert.doesNotMatch(await page.locator('.sq-extra-featured').innerText(), /Catalog fallback/);
    await page.evaluate(() => window.catalog.setSnapshotStatistics({generation: 1, statistics: {schemaVersion: 1,
      tracks: Object.fromEntries(window.fixtureEntries.map(entry => [entry.trackId, {complete: true, players: 0, count: 0, totalEntries: 0}]))}}));
    assert.match(await page.locator('.sq-extra-featured').innerText(), /0 players/);
    await page.evaluate(() => window.catalog.setSnapshotStatistics({generation: 2, statistics: {schemaVersion: 1, tracks: {}}}));
    assert.match(await page.locator('.sq-extra-featured').innerText(), /Player count unavailable/);
    assert.doesNotMatch(await page.locator('.sq-extra-featured').innerText(), /0 players|undefined|NaN/);
    if (process.env.EXTRA_TRACKS_SCREENSHOT) await page.screenshot({path: process.env.EXTRA_TRACKS_SCREENSHOT});
    await page.setViewportSize({width: 320, height: 568});
    assert.equal(await page.locator('.sq-extra-featured').isHidden(), true, 'short phones retain room for the catalog');
    assert.equal(await page.locator('.sq-extra-count').textContent(), '4 of 4 tracks');
    if (process.env.EXTRA_TRACKS_SCREENSHOT_DIR) await page.screenshot({path: process.env.EXTRA_TRACKS_SCREENSHOT_DIR + '/featured-short-320x568.png'});
    await page.setViewportSize({width: 280, height: 844});
    await page.getByRole('button', {name: 'Play daily pick', exact: true}).click();
    assert.equal(await page.evaluate(() => window.played.length), 1);
    assert.ok(entries.some(entry => entry.trackId === undefined) === false);
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    await page.evaluate(async () => {
      window.catalog.destroy();
      const {mountExtraTracks} = await import('/catalog-ui.mjs');
      window.catalog = mountExtraTracks({document, root: document.querySelector('#root'), entries: []});
      window.catalog.open();
    });
    assert.equal(await page.locator('.sq-extra-featured').isHidden(), true, 'empty catalogs have no empty spotlights');
    assert.equal(await page.locator('.sq-extra-count').textContent(), '0 of 0 tracks');
    assert.equal(await page.locator('.sq-extra-empty h3').textContent(), 'No extra tracks are available');
    assert.doesNotMatch(await page.locator('.sq-extra-menu').innerText(), /undefined|NaN|0 players/);
    await page.evaluate(() => window.catalog.destroy());
  } finally { await browser.close(); }
});


test('an open menu rolls locally across UTC day and week without rerendering reviews', {skip: !chromium}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 844}});
    const unexpected = [];
    await page.route('**/*', route => {
      const url = new URL(route.request().url()), name = url.pathname.slice(1);
      if (url.origin !== 'http://featured.test') { unexpected.push(url.href); return route.abort(); }
      if (sources.has(name)) return route.fulfill({contentType: 'text/javascript', body: sources.get(name)});
      if (!name) return route.fulfill({contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="root"></main>'});
      if (thumbnails.has(name)) return route.fulfill({contentType: name.endsWith('.webp') ? 'image/webp' : 'image/png', body: thumbnails.get(name)});
      if (/\.(png|webp)$/.test(name)) return route.abort();
      unexpected.push(url.href); return route.abort();
    });
    await page.clock.install({time: new Date('2026-11-01T23:59:59Z')});
    await page.goto('http://featured.test/'); await page.addStyleTag({content: css});
    await page.evaluate(async entries => {
      const {mountExtraTracks} = await import('/catalog-ui.mjs');
      window.catalog = mountExtraTracks({document, root: document.querySelector('#root'), entries});
      window.catalog.open();
      window.originalCard = document.querySelector('.sq-extra-card');
      window.fakeHidden = false;
      Object.defineProperty(document, 'hidden', {configurable: true, get: () => window.fakeHidden});
    }, entries);
    const nextPick=kind=>page.locator('.sq-extra-pick-'+kind+' time').getAttribute('datetime');
    assert.equal(await nextPick('daily'),'2026-11-02T00:00:00.000Z');
    assert.equal(await nextPick('weekly'),'2026-11-02T00:00:00.000Z');
    await page.clock.fastForward(1100);
    assert.equal(await nextPick('daily'),'2026-11-03T00:00:00.000Z');
    assert.equal(await nextPick('weekly'),'2026-11-09T00:00:00.000Z');
    assert.equal(await page.evaluate(() => window.originalCard === document.querySelector('.sq-extra-card')), true);
    await page.evaluate(() => {window.fakeHidden = true; document.dispatchEvent(new Event('visibilitychange'));});
    await page.clock.fastForward(2 * 86400000);
    await page.evaluate(() => {window.fakeHidden = false; document.dispatchEvent(new Event('visibilitychange'));});
    assert.equal(await nextPick('daily'),'2026-11-05T00:00:00.000Z');
    await page.evaluate(() => window.catalog.close());
    await page.clock.fastForward(86400000);
    assert.equal(await page.locator('.sq-extra-overlay').isHidden(), true);
    await page.evaluate(() => window.catalog.open());
    assert.equal(await nextPick('daily'),'2026-11-06T00:00:00.000Z');
    await page.evaluate(() => window.catalog.destroy());
    await page.clock.fastForward(86400000);
    assert.equal(await page.locator('.sq-extra-overlay').count(), 0);
    assert.deepEqual(unexpected, []);
  } finally { await browser.close(); }
});
