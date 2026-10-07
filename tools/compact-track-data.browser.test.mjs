import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('./verifier/package.json', import.meta.url));
let chromium = null;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const css = fs.readFileSync(new URL('../home-ui.css', import.meta.url), 'utf8');
const patchSource = fs.readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const cssFragments = [...patchSource.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)];
const rankedCss = cssFragments.map(fragment => JSON.parse(fragment[1])).join('\n');
const positionHelper = patchSource.match(/  function positionTrackFreshnessBanner\(banner,leaderboard\)\{([\s\S]*?)\r?\n  \}\r?\n  function updateTrackFreshnessBanner\(\)/);
assert.ok(positionHelper, 'freshness sidecar positioning helper remains discoverable');
const viewports = [[320, 720], [390, 844], [600, 400], [1920, 1080], [2800, 1920]];

test('freshness sidecar stays outside the leaderboard and avoids native controls at compact sizes and UI scales', {
  skip: !chromium && 'Set PLAYWRIGHT_MODULE to the bundled Playwright package to run this browser test.'
}, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html class="sq-compact-track-data"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      html,body{width:100%;height:100%;margin:0}.track-info-ui{position:fixed;inset:0;display:grid;place-items:center}
      .leaderboard-ui{width:min(520px,100%);height:min(520px,100%);display:flex;flex-direction:column;justify-content:flex-end;position:relative}
      .pages{height:54px;flex:none}.button-wrapper{height:48px;display:flex;justify-content:space-between;align-items:center;flex:none}
    </style></head><body>
      <main class="track-info-ui"><section class="leaderboard-ui">
        <div class="pages">Leaderboard pages</div><div class="button-wrapper"><button class="back">Back</button><button>Filter</button></div>
      </section></main>
      <div id="polytrackTrackFreshness" class="polytrack-track-freshness" data-source="snapshot">
          <strong>Snapshot + local personal best</strong><span>Snapshot captured two days ago</span>
          <span>Live refresh unlocks in fourteen minutes</span><span>Your saved finish updates here</span>
      </div></body></html>`);
    await page.addStyleTag({ content: rankedCss });
    await page.addStyleTag({ content: css });
    await page.addStyleTag({ content: `html,body{font-family:sans-serif}.button-wrapper button{min-width:0;min-height:44px}` });
    await page.evaluate((body) => { window.positionTrackFreshnessBanner = new Function('banner','leaderboard',body); }, positionHelper[1]);
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      for (const scale of [1, 1.25, 1.5, 2]) {
        await page.locator('#polytrackTrackFreshness').evaluate((node, value) => node.style.setProperty('--sq-ui-scale', value), scale);
        await page.evaluate(() => window.positionTrackFreshnessBanner(document.querySelector('#polytrackTrackFreshness'), document.querySelector('.leaderboard-ui')));
        const result = await page.evaluate(() => {
          const panel = document.querySelector('#polytrackTrackFreshness');
          const pages = document.querySelector('.pages');
          const back = document.querySelector('.back');
          const rect = element => { const r = element.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
          const intersects=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
          const countdown = panel.querySelector('span:nth-of-type(2)');
          return { panel:rect(panel), pages:rect(pages), back:rect(back), countdown:rect(countdown), panelStyle:getComputedStyle(panel), insideLeaderboard:document.querySelector('.leaderboard-ui').contains(panel),
            overlapsPages:intersects(panel.getBoundingClientRect(),pages.getBoundingClientRect()),overlapsBack:intersects(panel.getBoundingClientRect(),back.getBoundingClientRect()),
            panelScroll:panel.scrollHeight, panelClient:panel.clientHeight, viewport:{width:innerWidth,height:innerHeight} };
        });
        const label = `${width}x${height} scale ${scale}: ${JSON.stringify({panel:result.panel,pages:result.pages,back:result.back})}`;
        assert.equal(result.panelStyle.position, 'fixed', `sidecar remains fixed outside leaderboard flow at ${label}`);
        assert.equal(result.insideLeaderboard, false, `sidecar is not nested in the leaderboard at ${label}`);
        assert.ok(result.panel.left >= -1 && result.panel.right <= width + 1, `panel stays in viewport at ${label}`);
        assert.equal(result.overlapsPages, false, `panel avoids leaderboard pages at ${label}`);
        assert.equal(result.overlapsBack, false, `panel and native Back control do not overlap at ${label}`);
        assert.ok(result.panel.width <= 300, `sidecar stays compact at ${label}`);
        assert.ok(result.panelScroll <= result.panelClient + 2, `sidecar has no clipped content at ${label}`);
        assert.ok(result.countdown.top >= result.panel.top && result.countdown.bottom <= result.panel.bottom,
          `lock countdown remains fully visible at ${label}`);
      }
    }
  } finally { await browser.close(); }
});

test('source states and locked refresh styling are present and interaction-neutral', async () => {
  for (const source of ['snapshot', 'mixed', 'cache', 'live', 'local', 'error']) assert.match(css, new RegExp(`data-source="${source}"`));
  assert.match(css, /position:\s*fixed\s*!important/);
  assert.doesNotMatch(css, /\.sq-track-data-inline\s*\{/);
  assert.match(css, /--sq-track-data-bg:\s*#253a75/);
  assert.match(css, /data-source="snapshot"[\s\S]*?--sq-track-data-bg:\s*#344763/);
  assert.match(css, /border-left:\s*4px solid #7ee7ff/);
  assert.match(css, /clip-path:\s*polygon\(0 0, 100% 0, calc\(100% - 7px\) 100%, 0 100%\)/);
  assert.match(css, /box-shadow:\s*0 8px 24px rgba\(0, 0, 0, \.3\)/);
  assert.match(css, /font-size:\s*clamp\(11px, calc\(12px \* var\(--sq-ui-scale, 1\)\), 14px\)/);
  assert.match(css, /border-radius:\s*0/);
  assert.match(css, /\[data-sq-snapshot-refresh-lock\]:hover/);
  assert.match(css, /\[data-sq-snapshot-refresh-lock\][\s\S]*?cursor:\s*default\s*!important/);
  assert.match(css, /\[data-sq-snapshot-refresh-lock\][\s\S]*?transform:\s*none\s*!important/);
});
