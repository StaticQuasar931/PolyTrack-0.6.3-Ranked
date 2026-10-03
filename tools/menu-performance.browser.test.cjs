const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const assert = require('node:assert/strict');

const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'polytrack_062_patch.js'), 'utf8');
const start = source.indexOf('  const overallCarRenderCache = new Map();');
const end = source.indexOf('  function isLocalApiCapableHost(){', start);
assert.ok(start >= 0 && end > start);
const requireFromVerifier = createRequire(path.join(repo, 'tools/verifier/package.json'));
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? require(process.env.PLAYWRIGHT_MODULE)
  : requireFromVerifier('playwright');

test('cancelled native leaderboard renders never assign a Symbol to HTMLImageElement.src', async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setContent('<main id="root"><span class="overall-car-model image-container" data-renderarg="skin" data-userid="racer"><img src="placeholder.png"><img id="rendered"></span></main>');
    await page.evaluate(() => {
      window.rendererCalls = 0;
      window.BT = () => { window.rendererCalls++; return 'data:image/png;base64,thumb'; };
      window.__pt062NormalizeStyle = value => value;
      window.__pt062GetRememberedStyle = () => '';
      window.normalizeCarColorId = () => 'default';
      window.cleanUserId = value => value;
      window.normalizeThumbResult = value => value;
    });
    await page.addScriptTag({ content: source.slice(start, end) });
    await page.evaluate(() => {
      hydrateOverallCarModels(document.querySelector('#root'));
      document.querySelector('#root').style.display = 'none';
    });
    await page.waitForTimeout(30);
    assert.equal(await page.evaluate(() => window.rendererCalls), 0);
    assert.equal(await page.locator('#rendered').getAttribute('src'), null);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
