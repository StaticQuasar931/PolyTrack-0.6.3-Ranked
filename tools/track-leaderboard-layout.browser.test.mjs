import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('./verifier/package.json', import.meta.url));
let chromium = null;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const source = fs.readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const cssFragments = [...source.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\\\])*?")/g)];
assert.ok(cssFragments.length > 1, 'native UI CSS injection remains discoverable');
const rankedCss = cssFragments.map(fragment => JSON.parse(fragment[1])).join('\n');
const homeCss = fs.readFileSync(new URL('../home-ui.css', import.meta.url), 'utf8');
const eventsCss = fs.readFileSync(new URL('../events/events.css', import.meta.url), 'utf8');

const viewports = [
  [320, 720],
  [390, 844],
  [600, 960],
  [600, 400],
  [820, 1180],
  [1920, 1080],
  [2800, 1920],
];

test('owned mobile layout explicitly places all native footer controls', () => {
  assert.match(homeCss, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*1\.4fr\)\s+44px\s*!important;/);
  assert.match(homeCss, /> \.only-verified\s*\{[^}]*grid-column:\s*3;[^}]*grid-row:\s*1;/s);
  assert.match(homeCss, /> \.icon-button\.first\s*\{[^}]*grid-column:\s*4;[^}]*grid-row:\s*1;/s);
  assert.match(homeCss, /> \.back\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;/s);
  assert.match(homeCss, /> \[data-personal-filter-button\]\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/s);
  assert.match(homeCss, /> \.icon-button\.first\s*\{[^}]*grid-column:\s*3;[^}]*grid-row:\s*1;/s);
  assert.match(homeCss, /> \.only-verified\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*grid-row:\s*2;/s);
});

function bounds(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
    width: rect.width, height: rect.height, rendered: style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0 };
}

function assertInside(rect, box, label) {
  assert.ok(rect.rendered && rect.width > 0 && rect.height > 0, `${label} is rendered: ${JSON.stringify(rect)}`);
  assert.ok(rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1,
    `${label} stays inside ${JSON.stringify(box)}: ${JSON.stringify(rect)}`);
}

async function assertNoHorizontalOverflow(page, selectors, label, width, height) {
  const measures = await page.evaluate(selectors => selectors.map(selector => {
    const element = document.querySelector(selector);
    return element ? { selector, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth } : null;
  }), selectors);
  for (const measure of measures) {
    assert.ok(measure, `${label} ${selectors[measures.indexOf(measure)]} exists`);
    assert.ok(measure.scrollWidth <= measure.clientWidth + 2,
      `${label} has no horizontal overflow at ${width}x${height}: ${JSON.stringify(measure)}`);
  }
}

test('native track footer, Ranked Find me/filter, and event filters render within small and fullscreen viewports', {
  skip: !chromium && 'Set PLAYWRIGHT_MODULE to the bundled Playwright package to run this browser test.'
}, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    const checkViewport = async (width, height, selectors, boundarySelector, label) => {
      await page.setViewportSize({ width, height });
      const boxes = await page.evaluate(({ selectors, boundarySelector }) => {
        const measure = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            width: rect.width, height: rect.height, rendered: style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0 };
        };
        const boundary = document.querySelector(boundarySelector);
        if (!boundary) return null;
        return { boundary: measure(boundary), controls: selectors.map(selector => {
          const node = document.querySelector(selector);
          return node ? measure(node) : null;
        }), viewport: { left: 0, top: 0, right: innerWidth, bottom: innerHeight } };
      }, { selectors, boundarySelector });
      assert.ok(boxes, `${label} boundary exists at ${width}x${height}`);
      assertInside(boxes.boundary, boxes.viewport, `${label} boundary at ${width}x${height}`);
      for (const [index, rect] of boxes.controls.entries()) {
        assert.ok(rect, `${label} control ${selectors[index]} exists at ${width}x${height}`);
        assertInside(rect, boxes.boundary, `${label} control ${selectors[index]} at ${width}x${height}`);
      }
      return boxes;
    };

    // This mirrors the native menu hierarchy and the four footer buttons created by
    // the game bundle plus the injected personal filter: Back, Filters, Find me, Only verified.
    await page.setContent(`<style>
      html,body{width:100%;height:100%;margin:0}
      #gameRoot{position:relative;width:100%;height:100%}
      .menu-ui{position:fixed;inset:0;pointer-events:none}
      .track-info-ui{position:absolute;inset:0;display:flex;align-items:stretch;justify-content:center;gap:16px;width:100%;height:100%;padding:16px;box-sizing:border-box;pointer-events:auto}
      .track-info-ui>.side-panel{width:280px;flex:none;min-height:0}
      .leaderboard-ui{display:flex;flex-direction:column;align-items:stretch;width:min(520px,100%);min-width:0;min-height:0;margin:auto}
      .leaderboard-ui>.container{width:100%;flex:1;min-height:0;overflow:auto}
      .leaderboard-ui>.pages{height:44px;display:flex;gap:4px}
      .leaderboard-ui>.button-wrapper{height:44px;display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;overflow:hidden}
      .leaderboard-ui>.button-wrapper>button{min-width:0;min-height:44px;padding:6px;font:16px ForcedSquare,sans-serif;box-sizing:border-box}
      .leaderboard-ui>.button-wrapper>.back{margin:10px}
      .leaderboard-ui>.button-wrapper>.icon-button{width:44px}
      .leaderboard-ui>.button-wrapper>.only-verified{white-space:nowrap}
    </style>
    <div id="gameRoot"><div class="menu-ui"><main class="track-info-ui">
      <section class="side-panel"><h2>Track info</h2><div class="thumbnail"></div><button class="button play">Play</button></section>
      <section class="leaderboard-ui"><h2>Leaderboard</h2><h3>Best times</h3><div class="total-players">12 racers</div>
        <div class="container"><button class="main">Racer row</button></div><div class="pages"><button class="page selected">1</button></div>
        <div class="button-wrapper"><button class="button back">Back</button>
          <button class="button personal-filter-toggle" data-personal-filter-button>Filters</button>
          <button class="button icon-button first" aria-label="Find me"><img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='8' fill='%23fff'/%3E%3C/svg%3E"></button>
          <button class="button only-verified">Only verified <img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='8' fill='%23fff'/%3E%3C/svg%3E"></button>
        </div>
      </section>
    </main></div></div>`);
    await page.addStyleTag({ content: rankedCss });
    await page.addStyleTag({ content: homeCss });

    for (const [width, height] of viewports) {
      for (const filterLabel of ['Filters-Active', 'Filters-Inactive']) {
        await page.locator('.track-info-ui [data-personal-filter-button]').evaluate((button, label) => { button.textContent = label; }, filterLabel);
        const result = await checkViewport(width, height, [
          '.track-info-ui .button-wrapper > .back',
          '.track-info-ui .button-wrapper > [data-personal-filter-button]',
          '.track-info-ui .button-wrapper > .icon-button.first',
          '.track-info-ui .button-wrapper > .only-verified',
        ], '.track-info-ui .leaderboard-ui > .button-wrapper', `track footer ${filterLabel}`);
        assert.ok(result.boundary.left >= 0 && result.boundary.right <= width + 1,
          `footer itself is within the viewport at ${width}x${height}`);
        const rows = await page.locator('.track-info-ui .button-wrapper > button').evaluateAll(nodes => nodes.map(node => ({
          label: node.getAttribute('aria-label') || node.textContent.trim(), top: node.getBoundingClientRect().top,
          left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
        })));
        assert.ok(rows.find(row => row.label === 'Back').right <= rows.find(row => row.label === filterLabel).left + 1,
          `Filters remains immediately to the right of Back at ${width}x${height}: ${JSON.stringify(rows)}`);
        const firstRow = rows.filter(row => row.label !== 'Only verified').map(row => Math.round(row.top));
        assert.equal(new Set(firstRow).size, 1, `Back, Filters, and Find me share the first row at ${width}x${height}`);
        const onlyVerifiedTop = Math.round(rows.find(row => row.label === 'Only verified').top);
        if (width <= 600 && height > width) {
          assert.ok(onlyVerifiedTop > firstRow[0], `Only verified occupies the second row at ${width}x${height}`);
        } else {
          assert.equal(onlyVerifiedTop, firstRow[0], `all four native controls share the row at ${width}x${height}`);
          assert.ok(rows.find(row => row.label === 'Only verified').right <= rows.find(row => row.label === 'Find me').left + 1,
            `Only verified has a wide track before the Find me icon at ${width}x${height}`);
        }
        await assertNoHorizontalOverflow(page, ['.track-info-ui .button-wrapper', '.track-info-ui .leaderboard-ui', '.track-info-ui', '#gameRoot'], 'track footer', width, height);
      }
    }

    await page.setContent(`<style>html,body{width:100%;height:100%;margin:0}</style>
      <div id="overallLeaderboardPanel" style="display:flex"><section class="overall-shell">
        <header class="overall-top"><div class="overall-title-group"><h2>Ranked</h2></div>
          <div id="overallFilterPanel" class="overall-filter-host"><details class="ranked-filter-panel"><summary>Filters</summary></details></div>
          <div class="overall-actions"><button id="overallFindMeBtn" class="button overall-action-btn">Find me</button><button class="button overall-action-btn">Help</button><button class="button overall-action-btn">Close</button></div>
        </header><div class="overall-columns"><span>Place</span><span>Driver</span><span>Score</span></div><div id="overallLeaderboardList"></div>
      </section></div>`);
    await page.addStyleTag({ content: rankedCss });
    await page.addStyleTag({ content: homeCss });
    await page.addStyleTag({ content: '#overallLeaderboardPanel .overall-shell{animation:none!important}' });
    for (const [width, height] of viewports) {
      await checkViewport(width, height, ['#overallFindMeBtn', '#overallFilterPanel .ranked-filter-panel > summary'], '.overall-shell', 'Ranked header');
      await assertNoHorizontalOverflow(page, ['.overall-shell', '.overall-top', '#overallFilterPanel', '.overall-actions'], 'Ranked header', width, height);
    }

    await page.setContent(`<style>html,body{width:100%;height:100%;margin:0}</style>
      <div class="sq-events-overlay"><section class="sq-events-dialog"><header><h2>Event standings</h2><button class="button">Close</button></header>
        <main><div class="sq-event-actions"><button class="button" data-event-race>Race</button><button class="button" data-personal-filter-button>Event filters</button></div>
          <ol class="sq-event-results"><li>Racer</li></ol></main></section></div>`);
    await page.addStyleTag({ content: eventsCss });
    for (const [width, height] of viewports) {
      await checkViewport(width, height, ['[data-event-race]', '.sq-event-actions [data-personal-filter-button]'], '.sq-events-dialog', 'event actions');
      await assertNoHorizontalOverflow(page, ['.sq-events-dialog', '.sq-events-dialog main', '.sq-event-actions'], 'event actions', width, height);
    }
  } finally {
    await browser.close();
  }
});
