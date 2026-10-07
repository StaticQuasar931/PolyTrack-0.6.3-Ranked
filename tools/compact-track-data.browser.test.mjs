import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('./verifier/package.json', import.meta.url));
let chromium = null;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const css = fs.readFileSync(new URL('../home-ui.css', import.meta.url), 'utf8');
const viewports = [[320, 720], [390, 844], [600, 400], [1920, 1080], [2800, 1920]];

test('inline freshness panel flows before leaderboard pages at compact sizes and UI scales', {
  skip: !chromium && 'Set PLAYWRIGHT_MODULE to the bundled Playwright package to run this browser test.'
}, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html class="sq-compact-track-data"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
      <main class="track-info-ui"><section class="leaderboard-ui">
        <div id="polytrackTrackFreshness" class="polytrack-track-freshness sq-track-data-inline" data-source="snapshot">
          <strong>Snapshot + local personal best</strong><span>Snapshot captured two days ago</span>
          <span>Live refresh unlocks in fourteen minutes</span><span>Your saved finish updates here</span>
          <button data-sq-snapshot-refresh-lock disabled>Refresh locked</button>
        </div>
        <div class="pages">Leaderboard pages</div>
        <div class="button-wrapper"><button class="back">Back</button><button>Personal filter</button><button>Verified</button></div>
      </section></main></body></html>`);
    await page.addStyleTag({ content: css });
    await page.addStyleTag({ content: `html,body{margin:0;font-family:sans-serif}.track-info-ui{width:min(94vw,780px);margin:20px auto}.leaderboard-ui{display:flex;flex-direction:column;gap:8px}.pages{min-height:120px}.button-wrapper{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.button-wrapper button{min-width:0;min-height:44px}.track-info-ui{--sq-ui-scale:1}` });
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      for (const scale of [1, 1.25, 1.5]) {
        await page.locator('.track-info-ui').evaluate((node, value) => node.style.setProperty('--sq-ui-scale', value), scale);
        const result = await page.evaluate(() => {
          const panel = document.querySelector('#polytrackTrackFreshness');
          const pages = document.querySelector('.pages');
          const back = document.querySelector('.back');
          const rect = element => { const r = element.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
          return { panel:rect(panel), pages:rect(pages), back:rect(back), panelStyle:getComputedStyle(panel),
            panelScroll:panel.scrollHeight, panelClient:panel.clientHeight, viewport:{width:innerWidth,height:innerHeight} };
        });
        const label = `${width}x${height} scale ${scale}: ${JSON.stringify({panel:result.panel,pages:result.pages,back:result.back})}`;
        assert.equal(result.panelStyle.position, 'relative', `hosted panel must flow inline at ${label}`);
        assert.ok(result.panel.left >= -1 && result.panel.right <= width + 1, `panel stays in viewport at ${label}`);
        assert.ok(result.panel.bottom <= result.pages.top + 1, `panel remains above pages at ${label}`);
        assert.ok(result.panel.bottom <= result.back.top + 1, `panel and native Back control do not overlap at ${label}`);
        assert.ok(result.panel.width <= result.pages.width + 1, `panel fits leaderboard width at ${label}`);
        assert.ok(result.panelScroll <= result.panelClient + 2, `inline panel has no clipped content at ${label}`);
      }
    }
  } finally { await browser.close(); }
});

test('source states and locked refresh styling are present and interaction-neutral', async () => {
  for (const source of ['snapshot', 'mixed', 'cache', 'live', 'local', 'error']) assert.match(css, new RegExp(`data-source="${source}"`));
  assert.match(css, /\[data-sq-snapshot-refresh-lock\]:hover/);
  assert.match(css, /\[data-sq-snapshot-refresh-lock\][\s\S]*?cursor:\s*default\s*!important/);
  assert.match(css, /\[data-sq-snapshot-refresh-lock\][\s\S]*?transform:\s*none\s*!important/);
});
