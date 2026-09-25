import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(new URL('./verifier/package.json', import.meta.url));
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const cssFragments = [...source.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\\\])*?")/g)];
assert.ok(cssFragments.length > 1, 'ranked CSS injection remains discoverable');
const css = cssFragments.map(fragment => JSON.parse(fragment[1])).join('\n');
const eventsCss = fs.readFileSync(new URL('../events/events.css', import.meta.url), 'utf8');

const viewports = [
  [2800, 1920, 74],
  [1920, 1080, 74],
  [390, 844, 78],
  [844, 390, 74],
  [820, 1180, 74],
  [1180, 820, 74],
];

test('injected menu footer and Ranked panel fit desktop, phone, and iPad sizes', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%}.menu-ui{position:fixed;inset:0;pointer-events:none}.menu-ui .info{height:40px}#overallLeaderboardPanel .overall-shell{animation:none!important}</style><div class="menu-ui"><div class="info"><a>Community footer</a></div></div><div id="overallLeaderboardPanel" style="display:flex"><section class="overall-shell"><header class="overall-top"><div class="overall-title-group"><h2>Ranked</h2></div><div class="overall-actions"><button class="overall-action-btn">Help</button><button class="overall-action-btn">Close</button></div></header><p class="overall-sub">Community rankings</p><div class="overall-columns"><span>Rank</span><span>Racer</span><span>Best</span><span>Score</span></div><div id="overallLeaderboardList"><div class="overall-entry"><span>1</span><span>Racer</span><span>Best</span><span>Score</span></div></div><footer class="overall-pager"><button class="button">Previous</button><span class="overall-page-status">1 / 1</span><button class="button">Next</button></footer></section></div>`);
    await page.addStyleTag({content: css});
    for (const [width, height, expectedBottom] of viewports) {
      await page.setViewportSize({width, height});
      const info = await page.locator('.menu-ui .info').boundingBox();
      assert.ok(info, `footer is laid out at ${width}x${height}`);
      assert.equal(Math.round(height - info.y - info.height), expectedBottom, `footer clearance at ${width}x${height}`);
      assert.ok(info.x >= 0 && info.x + info.width <= width, `footer stays within ${width}px viewport`);
      const panel = await page.locator('.overall-shell').boundingBox();
      assert.ok(panel, `Ranked panel is laid out at ${width}x${height}`);
      assert.ok(panel.x >= -1 && panel.y >= -1 && panel.x + panel.width <= width + 1 && panel.y + panel.height <= height + 1, `Ranked panel stays within ${width}x${height}: ${JSON.stringify(panel)}`);
    }

    const rows = Array.from({length: 45}, (_, index) => `<li><span>${index + 1}</span><span>Racer ${index + 1}</span><time>00:19.993</time><strong>1,250 RP</strong></li>`).join('');
    await page.setContent(`<div class="sq-events-overlay"><section class="sq-events-dialog"><header><h2>Community Events</h2><button class="button">Close</button></header><nav><button class="button">Current</button><button class="button">Archive</button></nav><main><div class="sq-event-status">Weekly standings</div><ul class="sq-event-results">${rows}</ul></main></section></div>`);
    await page.addStyleTag({content: eventsCss});
    for (const [width, height] of viewports) {
      await page.setViewportSize({width, height});
      const dialog = await page.locator('.sq-events-dialog').boundingBox();
      assert.ok(dialog, `Events dialog is laid out at ${width}x${height}`);
      assert.ok(dialog.x >= -1 && dialog.y >= -1 && dialog.x + dialog.width <= width + 1 && dialog.y + dialog.height <= height + 1, `Events dialog stays within ${width}x${height}`);
      const overflow = await page.locator('.sq-events-dialog main').evaluate(element => ({client: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY}));
      assert.equal(overflow.overflow, 'auto');
      assert.ok(overflow.scroll > overflow.client, `standings scroll inside dialog at ${width}x${height}`);
    }
  } finally {
    await browser.close();
  }
});

test('large track-info panel leaves the lower Back control unobscured', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 2800, height: 1920}});
    await page.setContent('<style>body{margin:0}.track-info-ui{position:absolute;inset:0;display:flex;height:100%}.track-info-ui>.side-panel{display:flex;flex-direction:column;width:400px;min-height:0;margin-left:50px;background:#192a50}.track-info-ui>.side-panel>.button.play{margin-top:auto;height:100px}.back-control{position:absolute;left:50px;bottom:0;width:180px;height:60px}</style><div class="track-info-ui"><section class="side-panel"><h2>Track info</h2><div class="thumbnail"></div><button class="button play">Play</button></section></div><button class="back-control">Back</button>');
    await page.addStyleTag({content: css});
    const panel = await page.locator('.track-info-ui>.side-panel').boundingBox();
    const back = await page.locator('.back-control').boundingBox();
    assert.ok(panel && back);
    assert.ok(panel.y + panel.height <= back.y, 'track info ends above the Back control');
  } finally {
    await browser.close();
  }
});
