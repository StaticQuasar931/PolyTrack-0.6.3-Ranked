import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {}

const filterCss = fs.readFileSync(new URL('./filter-menu.css', import.meta.url), 'utf8');
const eventsCss = fs.readFileSync(new URL('../events/events.css', import.meta.url), 'utf8');
const packCss = fs.readFileSync(new URL('../extra-tracks/pack.css', import.meta.url), 'utf8');
const viewports = [
  [844, 390, 'phone landscape'],
  [390, 844, 'phone portrait'],
  [768, 1024, 'iPad portrait'],
  [1024, 768, 'iPad landscape'],
];

function assertSafeAreaRules(css, label) {
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    assert.match(css, new RegExp(`env\\(safe-area-inset-${edge},\\s*0px\\)`), `${label} reserves the ${edge} safe area`);
  }
}

function assertInsideViewport(bounds, width, height, label) {
  assert.ok(bounds.left >= -1 && bounds.top >= -1 && bounds.right <= width + 1 && bounds.bottom <= height + 1,
    `${label} stays within ${width}x${height}: ${JSON.stringify(bounds)}`);
}

test('mobile and tablet filter, event, and pack dialogs fit real responsive CSS', {
  skip: !chromium && 'Set PLAYWRIGHT_MODULE to the installed Playwright package to run this browser test.'
}, async () => {
  assertSafeAreaRules(filterCss, 'filter overlay');
  assertSafeAreaRules(eventsCss, 'event overlay');
  assertSafeAreaRules(packCss, 'pack overlay');
  assert.match(filterCss, /@media\s*\(max-width:\s*1080px\)/);
  assert.match(eventsCss, /max-height:min\(900px,100%\)/);

  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    const fixture = async (markup, css) => {
      await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">${markup}</body></html>`);
      await page.addStyleTag({ content: css });
      await page.addStyleTag({ content: '.pt-group-filter-menu .fm-shell{animation:none!important}' });
      await page.evaluate(() => { window.measureRect = element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
      }; });
    };

    await fixture(`<div class="pt-group-filter-menu"><section class="fm-shell">
      <header class="fm-header"><div class="fm-heading"><h1>Advanced filters</h1></div><div class="fm-header-actions"><button class="fm-button">Close</button></div></header>
      <div class="fm-body"><nav class="fm-nav"><button class="fm-nav-button" aria-current="page">Rules</button><button class="fm-nav-button">Racers</button></nav>
        <main class="fm-content"><section class="fm-section"><h2>Track rules</h2><div class="fm-track-rule">
          <select aria-label="Track"><option>Track</option></select><select aria-label="Rule"><option>Rule</option></select>
          <input aria-label="Minimum" value="1"><input aria-label="Maximum" value="9"><button class="fm-button">Remove</button>
        </div></section></main></div>
      <div class="fm-status">Ready</div><footer class="fm-footer"><button class="fm-button fm-button-quiet">Cancel</button><button class="fm-button fm-button-primary">Apply filters</button></footer>
    </section></div>`, filterCss);

    for (const [width, height, label] of viewports) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => ({
        shell: window.measureRect(document.querySelector('.fm-shell')),
        footer: window.measureRect(document.querySelector('.fm-footer')),
        contentWidth: document.querySelector('.fm-content').clientWidth,
        contentScrollWidth: document.querySelector('.fm-content').scrollWidth,
        compactColumns: getComputedStyle(document.querySelector('.fm-body')).gridTemplateColumns,
        navDirection: getComputedStyle(document.querySelector('.fm-nav')).flexDirection,
      }));
      assertInsideViewport(layout.shell, width, height, `filter shell at ${label}`);
      assertInsideViewport(layout.footer, width, height, `filter footer at ${label}`);
      assert.ok(layout.contentScrollWidth <= layout.contentWidth + 1, `filter track rules fit without horizontal scroll at ${label}`);
      assert.equal(layout.navDirection, 'row', `filter navigation is compact at ${label}`);
      assert.equal(layout.compactColumns.trim().split(/\s+/).length, 1, `filter body uses one compact column at ${label}`);
    }

    await fixture(`<section class="sq-events-overlay"><article class="sq-events-dialog">
      <header><h2>Event standings</h2><button class="button">Close</button></header>
      <nav><button class="button">Live</button><button class="button">Archive</button></nav>
      <main><div class="sq-event-cards"><button class="sq-event-card"><span>Daily event</span></button><button class="sq-event-card"><span>Weekly event</span></button></div></main>
    </article></section>`, eventsCss);

    for (const [width, height, label] of viewports) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => ({
        overlay: window.measureRect(document.querySelector('.sq-events-overlay')),
        dialog: window.measureRect(document.querySelector('.sq-events-dialog')),
        close: window.measureRect(document.querySelector('.sq-events-dialog header button')),
        dialogHeight: document.querySelector('.sq-events-dialog').clientHeight,
        dialogScrollHeight: document.querySelector('.sq-events-dialog').scrollHeight,
      }));
      assertInsideViewport(layout.dialog, width, height, `event dialog at ${label}`);
      assertInsideViewport(layout.close, width, height, `event close button at ${label}`);
      assert.ok(layout.dialogHeight <= height, `event dialog height is bounded at ${label}`);
      assert.ok(layout.overlay.right <= width + 1, `event overlay stays within viewport at ${label}`);
    }

    await fixture(`<div class="pt-pack-overlay"><section class="pt-pack-dialog">
      <header class="pt-pack-header"><div class="pt-pack-heading"><h1 class="pt-pack-title">Track pack</h1></div><button class="pt-pack-close">Close</button></header>
      <div class="pt-pack-toolbar"><div class="pt-pack-selection-tools"><button class="pt-pack-secondary">Select all</button></div><p class="pt-pack-count">2 tracks</p><button class="pt-pack-import">Import selected</button></div>
      <div class="pt-pack-grid"><article class="pt-pack-card"><div class="pt-pack-preview">Preview</div><div class="pt-pack-card-details"><h2 class="pt-pack-track-name">Track one</h2></div></article>
        <article class="pt-pack-card"><div class="pt-pack-preview">Preview</div><div class="pt-pack-card-details"><h2 class="pt-pack-track-name">Track two</h2></div></article></div>
    </section></div>`, packCss);

    for (const [width, height, label] of viewports) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => ({
        dialog: window.measureRect(document.querySelector('.pt-pack-dialog')),
        close: window.measureRect(document.querySelector('.pt-pack-close')),
        import: window.measureRect(document.querySelector('.pt-pack-import')),
        scrollWidth: document.querySelector('.pt-pack-dialog').scrollWidth,
        clientWidth: document.querySelector('.pt-pack-dialog').clientWidth,
      }));
      assertInsideViewport(layout.dialog, width, height, `pack dialog at ${label}`);
      assertInsideViewport(layout.close, width, height, `pack close button at ${label}`);
      assertInsideViewport(layout.import, width, height, `pack import button at ${label}`);
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `pack dialog has no horizontal overflow at ${label}`);
    }
  } finally {
    await browser.close();
  }
});
