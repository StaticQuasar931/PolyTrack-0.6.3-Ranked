import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const logoUrl = 'https://cdn.jsdelivr.net/gh/StaticQuasar931/Images@main/squarestaticquasar931logo.jpg';
const modules = new Map(['catalog-ui.mjs', 'review.mjs', 'reviewed.mjs', 'reviewed-data.mjs', 'snapshot-popularity.mjs', 'featured-picks.mjs', 'random-picker.mjs'].map(name => [name, fs.readFileSync(new URL(name, import.meta.url), 'utf8')]));
modules.set('tools/search-text.mjs', fs.readFileSync(new URL('../tools/search-text.mjs', import.meta.url), 'utf8'));
const css = fs.readFileSync(new URL('./catalog.css', import.meta.url), 'utf8');
const font = fs.readFileSync(new URL('../forced_square.woff2', import.meta.url)).toString('base64');

test('Static artwork, fallback and credit searches stay accessible on desktop and phone', {skip: !chromium}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    for (const failed of [false, true]) {
      const page = await browser.newPage();
      const requests = [];
      await page.route('**/*', route => {
        const url = route.request().url();
        const name = new URL(url).pathname.slice(1);
        if (modules.has(name)) return route.fulfill({contentType: 'text/javascript', body: modules.get(name)});
        if (url === logoUrl) {
          requests.push(url);
          return failed ? route.abort() : route.continue();
        }
        if (url === 'http://credit.test/') return route.fulfill({contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="root"></main>'});
        return route.abort();
      });
      await page.goto('http://credit.test/');
      await page.addStyleTag({content: `@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font})}body{margin:0;font-family:ForcedSquare,sans-serif}` + css});
      await page.evaluate(async () => {
        const {mountExtraTracks} = await import('/catalog-ui.mjs');
        window.catalog = mountExtraTracks({document, root: document.querySelector('#root'), entries: []});
        window.catalog.open();
      });
      assert.deepEqual(requests, [], 'no artwork is requested during normal catalog use');
      const search = page.getByRole('searchbox', {name: 'Search tracks'});
      const credit = page.locator('.sq-extra-static');
      for (const [width, height] of [[1366, 900], [390, 844]]) {
        await page.setViewportSize({width, height});
        await search.fill('STATIC');
        await credit.scrollIntoViewIfNeeded();
        await page.waitForFunction(() => {
          const img = document.querySelector('.sq-extra-static-logo');
          return img?.complete && (img.hidden || img.naturalWidth > 0);
        });
        assert.equal(await credit.locator('figcaption').innerText(), 'Static\n\nI build and maintain Ranked. Thanks for playing.');
        assert.equal(await credit.locator('img').getAttribute('alt'), '');
        assert.equal(await credit.locator('img').isHidden(), failed);
        if (!failed) assert.equal(await credit.locator('img').evaluate(img => img.naturalWidth === img.naturalHeight), true);
        assert.equal(await search.evaluate(el => el === document.activeElement), true, 'typing does not move keyboard focus');
        assert.equal(await page.locator('.sq-extra-empty').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const box = await credit.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height);
        if (process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR) {
          fs.mkdirSync(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR, {recursive: true});
          await page.screenshot({path: path.join(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR, `static-credit-${failed ? 'fallback' : 'artwork'}-${width}.png`)});
        }
        await search.fill('credits');
        assert.equal(await credit.isVisible(), true);
        assert.equal(await page.locator('.sq-extra-cleaner').isVisible(), true);
        await search.fill('windowcleaner');
        assert.equal(await credit.isHidden(), true);
        assert.equal(await page.locator('.sq-extra-cleaner').isVisible(), true);
        await search.fill('static noise');
        assert.equal(await credit.isHidden(), true);
        assert.equal(await page.locator('.sq-extra-empty').count(), 1);
      }
      assert.deepEqual(requests, [logoUrl], 'a reveal loads the artwork only once, including after failure');
      await page.close();
    }
  } finally { await browser.close(); }
});
