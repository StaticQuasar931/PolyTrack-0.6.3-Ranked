import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const browserSkip = !chromium && 'Set PLAYWRIGHT_MODULE to the bundled Playwright package to run this browser test.';
const moduleSource = fs.readFileSync(new URL('./catalog-ui.mjs', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./catalog.css', import.meta.url), 'utf8');
const catalog = JSON.parse(fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));

test('Extra Tracks nested dialogs contain focus, close correctly, and restore their launchers', {skip: browserSkip}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    const requested = [];
    await page.route('**/*', async route => {
      const url = route.request().url();
      requested.push(url);
      if (url === 'http://extra-tracks.test/catalog-ui.mjs') {
        await route.fulfill({contentType: 'text/javascript', body: moduleSource});
      } else if (url === 'http://extra-tracks.test/') {
        await route.fulfill({contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><button id="launcher">Open catalog</button><main id="root"></main>'});
      } else {
        await route.abort();
      }
    });
    await page.goto('http://extra-tracks.test/');
    await page.addStyleTag({content: css});
    await page.evaluate(async () => {
      const {mountExtraTracks} = await import('/catalog-ui.mjs');
      const entry = {id: 'browser-track', trackId: 'a'.repeat(64), name: 'Browser Track', author: 'Tester', tags: ['technical'], source: 'Local'};
      window.played = [];
      window.catalog = mountExtraTracks({
        document,
        root: document.querySelector('#root'),
        entries: [entry],
        onPlay: async item => window.played.push(item.id),
        onReport: async () => {},
        onSubmit: async payload => { window.submittedName = payload.name; }
      });
      document.querySelector('#launcher').addEventListener('click', () => window.catalog.open());
    });

    await page.getByRole('button', {name: 'Open catalog'}).click();
    const more = page.getByRole('button', {name: 'More actions for Browser Track'});
    await more.click();
    await page.getByRole('button', {name: 'Report track'}).click();
    const report = page.getByRole('dialog', {name: 'Report a track'});
    await assert.doesNotReject(() => report.waitFor({state: 'visible'}));
    await assert.doesNotReject(() => page.getByRole('button', {name: 'Close'}).last().evaluate(el => el === document.activeElement));

    const reportClose = page.getByRole('dialog', {name: 'Report a track'}).getByRole('button', {name: 'Close'});
    const reportSend = page.getByRole('button', {name: 'Send report'});
    await reportSend.focus();
    await page.keyboard.press('Tab');
    assert.equal(await reportClose.evaluate(el => el === document.activeElement), true, 'Tab from the last report control wraps to the first');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await reportSend.evaluate(el => el === document.activeElement), true, 'Shift+Tab from the first report control wraps to the last');
    await page.keyboard.press('Escape');
    await report.waitFor({state: 'hidden'});
    assert.equal(await more.evaluate(el => el === document.activeElement), true, 'closing report restores focus to its card action');
    await more.click();
    await page.getByRole('button', {name: 'Report track'}).click();
    await report.getByRole('button', {name: 'Close'}).click();
    assert.equal(await more.evaluate(el => el === document.activeElement), true, 'report Close restores focus to its launcher');
    await more.click();
    await page.getByRole('button', {name: 'Report track'}).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.getByRole('button', {name: 'Open catalog'}).click();
    await report.waitFor({state: 'hidden'});
    assert.equal(await report.isVisible(), false, 'closed report dialog stays hidden when catalog is reopened');

    await page.getByRole('button', {name: 'Submit a track'}).click();
    const submission = page.getByRole('dialog', {name: 'Submit an Extra Track'});
    await submission.waitFor({state: 'visible'});
    const submitClose = submission.getByRole('button', {name: 'Close'});
    const fallback = submission.getByRole('link', {name: 'Use Google Form instead'});
    await fallback.focus();
    await page.keyboard.press('Tab');
    assert.equal(await submitClose.evaluate(el => el === document.activeElement), true, 'submission Tab wraps within the modal');
    await submitClose.click();
    assert.equal(await page.getByRole('button', {name: 'Submit a track'}).evaluate(el => el === document.activeElement), true, 'submission Close restores focus to its launcher');
    await page.getByRole('button', {name: 'Submit a track'}).click();
    await submission.waitFor({state: 'visible'});
    await page.keyboard.press('Escape');
    await submission.waitFor({state: 'hidden'});
    assert.equal(await page.getByRole('button', {name: 'Submit a track'}).evaluate(el => el === document.activeElement), true, 'submission Escape restores focus to its launcher');

    await page.getByRole('button', {name: 'Import and play'}).click();
    await page.getByRole('dialog', {name: 'Extra Tracks'}).waitFor({state: 'hidden'});
    assert.deepEqual(await page.evaluate(() => window.played), ['browser-track'], 'import/play uses the provided offline stub and closes on success');
    assert.deepEqual(requested, ['http://extra-tracks.test/','http://extra-tracks.test/catalog-ui.mjs'], 'test performs no external or backend requests');
  } finally {
    await browser.close();
  }
});

test('track cards show full previews and keep feedback in an accessible three-dot disclosure', {skip: browserSkip}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 960, height: 900}});
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'http://extra-tracks.test/catalog-ui.mjs') await route.fulfill({contentType: 'text/javascript', body: moduleSource});
      else if (url === 'http://extra-tracks.test/') await route.fulfill({contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><main id="root"></main>'});
      else if (url === 'http://extra-tracks.test/extra-tracks/thumbnails/native-map.png' || url === 'http://extra-tracks.test/extra-tracks/thumbnails/itch-photo.png') await route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="41" height="76"><rect width="41" height="76" fill="green"/></svg>'});
      else await route.abort();
    });
    await page.goto('http://extra-tracks.test/');
    await page.addStyleTag({content: css});
    await page.evaluate(async () => {
      const {mountExtraTracks} = await import('/catalog-ui.mjs');
      const entry = {id: 'preview-track', trackId: 'p'.repeat(64), name: 'Preview Track', author: 'Tester', trackPath: 'extra-tracks/track-data/kacky/preview.track', thumbnailUrl: '/extra-tracks/thumbnails/native-map.png'};
      const neighbor = {id: 'neighbor-track', name: 'Neighbor Track', author: 'Tester', trackPath: 'extra-tracks/track-data/itch/itch-photo.track', thumbnailUrl: '/extra-tracks/thumbnails/itch-photo.png', thumbnailKind: 'artwork'};
      window.feedback = {};
      window.catalog = mountExtraTracks({document, root: document.querySelector('#root'), entries: [entry, neighbor], getFeedback: () => window.feedback, onFeedback: (_entry, change) => { window.feedback = {...window.feedback, ...change}; }, onReport: async (_entry, reason) => { window.reportReason = reason; }});
      window.catalog.open();
    });
    const previewCard = page.locator('.sq-extra-card').filter({has: page.getByRole('heading', {name: 'Preview Track', exact: true})});
    const photoCard = page.locator('.sq-extra-card').filter({has: page.getByRole('heading', {name: 'Neighbor Track', exact: true})});
    const image = previewCard.locator('.sq-extra-visual img');
    await image.waitFor({state: 'visible'});
    await page.waitForFunction(() => {
      const card = [...document.querySelectorAll('.sq-extra-card')].find(item => item.querySelector('h3')?.textContent === 'Preview Track');
      const image = card?.querySelector('.sq-extra-visual img');
      return image?.complete && image.naturalWidth > 0;
    });
    assert.equal(await image.evaluate(img => img.naturalWidth), 41);
    assert.equal(await image.evaluate(img => img.naturalHeight), 76);
    assert.equal(await image.evaluate(img => getComputedStyle(img).objectFit), 'contain');
    assert.equal(await image.evaluate(img => getComputedStyle(img).imageRendering), 'pixelated');
    const photo = photoCard.locator('.sq-extra-visual img');
    await photo.waitFor({state: 'visible'});
    await page.waitForFunction(() => {
      const card = [...document.querySelectorAll('.sq-extra-card')].find(item => item.querySelector('h3')?.textContent === 'Neighbor Track');
      const image = card?.querySelector('.sq-extra-visual img');
      return image?.complete && image.naturalWidth > 0;
    });
    assert.equal(await photo.evaluate(img => getComputedStyle(img).objectFit), 'contain');
    assert.equal(await photo.evaluate(img => getComputedStyle(img).imageRendering), 'auto', 'photographic artwork keeps smooth resampling');
    assert.equal(await image.evaluate(img => getComputedStyle(img).transform), 'none');
    assert.equal(await image.evaluate(img => {
      const bounds = img.getBoundingClientRect();
      const scale = Math.min(bounds.width / img.naturalWidth, bounds.height / img.naturalHeight);
      const previewWidth = img.naturalWidth * scale, previewHeight = img.naturalHeight * scale;
      return Math.abs(previewWidth / previewHeight - img.naturalWidth / img.naturalHeight) < 0.02 && scale > 1 && bounds.width > img.naturalWidth;
    }), true, 'preview preserves its native aspect ratio with crisp upscaling');
    const favorite = previewCard.getByRole('button', {name: 'Add to favorites'});
    assert.equal(await favorite.getAttribute('aria-pressed'), 'false');
    await favorite.click();
    assert.equal(await previewCard.getByRole('button', {name: 'Remove from favorites'}).getAttribute('aria-pressed'), 'true');
    const more = page.getByRole('button', {name: 'More actions for Preview Track'});
    const cardBoundsBeforeMenu = await page.locator('.sq-extra-card').evaluateAll(cards => cards.map(card => [card.offsetLeft,card.offsetTop,card.offsetWidth,card.offsetHeight]));
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    await more.click();
    assert.equal(await more.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Helpful', 'opening the disclosure moves focus into the floating controls');
    const menu = page.locator('.sq-extra-more-menu');
    assert.equal(await more.getAttribute('aria-controls'), await menu.getAttribute('id'));
    assert.equal(await menu.evaluate(el => el.parentElement.classList.contains('sq-extra-card-menu-layer')), true);
    assert.equal(await menu.evaluate(el => getComputedStyle(el).position), 'fixed');
    assert.equal(await menu.getAttribute('role'), 'dialog');
    assert.equal(await more.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(await menu.getAttribute('aria-modal'), null, 'the popup dialog does not claim modality');
    assert.deepEqual(await page.locator('.sq-extra-card').evaluateAll(cards => cards.map(card => [card.offsetLeft,card.offsetTop,card.offsetWidth,card.offsetHeight])), cardBoundsBeforeMenu, 'opening the dropdown does not reflow either card');
    const menuBounds = await menu.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(menuBounds && menuBounds.x >= 8 && menuBounds.y >= 8 && menuBounds.x + menuBounds.width <= viewport.width - 8 && menuBounds.y + menuBounds.height <= viewport.height - 8, `dropdown stays inside viewport: ${JSON.stringify(menuBounds)}`);
    assert.equal(await page.getByRole('button', {name: 'Helpful'}).isVisible(), true);
    assert.equal(await page.getByRole('button', {name: 'Not for me'}).isVisible(), true);
    assert.equal(await page.getByLabel('My rating for Preview Track').isVisible(), true);
    assert.equal(await page.getByRole('button', {name: 'Favorite', exact: true}).count(), 0);
    await more.focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', {name: 'Helpful'}).evaluate(el => el === document.activeElement), true, 'Tab enters the expanded dropdown');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await more.evaluate(el => el === document.activeElement), true, 'Shift+Tab returns to the dropdown trigger');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    assert.equal(await more.evaluate(el => el === document.activeElement), true, 'Escape closes the disclosure and restores focus to its trigger');
    assert.equal(await page.getByRole('dialog', {name: 'Extra Tracks'}).isVisible(), true, 'Escape leaves the catalog open');
    await more.click();
    await page.locator('.sq-extra-header h2').click();
    assert.equal(await menu.isHidden(), true, 'outside click closes the floating dropdown');

    await more.click();
    await page.getByRole('button', {name: 'Helpful'}).click();
    assert.equal(await page.evaluate(() => window.feedback.vote), 1, 'native dropdown keeps vote callbacks working');
    await more.click();
    await page.getByLabel('My rating for Preview Track').selectOption('8');
    assert.equal(await page.evaluate(() => window.feedback.rating), 8, 'native dropdown keeps rating callbacks working');
    await more.click();
    await page.getByRole('button', {name: 'Report track'}).click();
    const report = page.getByRole('dialog', {name: 'Report a track'});
    await report.waitFor({state: 'visible'});
    await page.getByLabel('Broken or unplayable').check();
    await page.getByRole('button', {name: 'Send report'}).click();
    await page.waitForFunction(() => document.querySelector('.sq-extra-report-status')?.textContent.includes('Report received.'));
    assert.equal(await page.evaluate(() => window.reportReason), 'broken', 'floating dropdown keeps the report callback working');
    await report.getByRole('button', {name: 'Close'}).click();

    await page.setViewportSize({width: 360, height: 740});
    const bounds = await previewCard.boundingBox();
    assert.ok(bounds && bounds.width <= 360 && bounds.x >= 0, `card fits narrow viewport: ${JSON.stringify(bounds)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => window.catalog.destroy());
  } finally {
    await browser.close();
  }
});

test('Extra Tracks dialogs fit narrow portrait and short landscape viewports and keep bottom actions reachable', {skip: browserSkip}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 320, height: 568}});
    await page.route('**/*', async route => {
      if (route.request().url() === 'http://extra-tracks.test/catalog-ui.mjs') await route.fulfill({contentType: 'text/javascript', body: moduleSource});
      else if (route.request().url() === 'http://extra-tracks.test/') await route.fulfill({contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><main id="root"></main>'});
      else await route.abort();
    });
    await page.goto('http://extra-tracks.test/');
    await page.addStyleTag({content: css});
    await page.evaluate(async () => {
      const {mountExtraTracks} = await import('/catalog-ui.mjs');
      window.catalog = mountExtraTracks({document, root: document.querySelector('#root'), entries: [{id: 'mobile-track', name: 'Mobile track with a deliberately long title to exercise wrapping', author: 'Tester'}]});
      window.catalog.open();
    });
    const overlay = page.locator('.sq-extra-overlay');
    for (const [width, height] of [[320, 568], [568, 320]]) {
      await page.setViewportSize({width, height});
      const bounds = await overlay.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.width <= width, `catalog overlay fits ${width}x${height}: ${JSON.stringify(bounds)}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `catalog has no horizontal page overflow at ${width}x${height}`);

      await page.getByRole('button', {name: 'Submit a track'}).click();
      const form = page.locator('.sq-extra-submission');
      const formBounds = await form.boundingBox();
      assert.ok(formBounds && formBounds.x >= 0 && formBounds.x + formBounds.width <= width, `submission form fits ${width}x${height}: ${JSON.stringify(formBounds)}`);
      assert.equal(await form.evaluate(el => el.scrollWidth <= el.clientWidth), true, `submission form has no horizontal overflow at ${width}x${height}`);
      const formReachability = await form.evaluate(el => {
        el.scrollTop = el.scrollHeight;
        const container = el.getBoundingClientRect();
        const action = el.querySelector('.sq-extra-send').getBoundingClientRect();
        return {scrollable: el.scrollHeight > el.clientHeight, actionInside: action.top >= container.top && action.bottom <= container.bottom};
      });
      assert.equal(formReachability.scrollable, true, `submission content scrolls internally at ${width}x${height}`);
      assert.equal(formReachability.actionInside, true, `submission send action is reachable at ${width}x${height}`);
      await page.keyboard.press('Escape');

      await page.getByRole('button', {name: 'More actions for Mobile track with a deliberately long title to exercise wrapping'}).click();
      await page.getByRole('button', {name: 'Report track'}).click();
      const report = page.locator('.sq-extra-report');
      const reportBounds = await report.boundingBox();
      assert.ok(reportBounds && reportBounds.x >= 0 && reportBounds.x + reportBounds.width <= width, `report dialog fits ${width}x${height}: ${JSON.stringify(reportBounds)}`);
      const reportReachability = await report.evaluate(el => {
        const send = el.querySelector('.sq-extra-report-send');
        if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
        const container = el.getBoundingClientRect();
        const bounds = send.getBoundingClientRect();
        return {
          scrollable: el.scrollHeight > el.clientHeight,
          actionInside: bounds.top >= container.top && bounds.bottom <= container.bottom,
          actionOnScreen: bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth
        };
      });
      if (height <= 360) assert.equal(reportReachability.scrollable, true, `report content scrolls internally at ${width}x${height}`);
      assert.equal(reportReachability.actionInside, true, `report send action is reachable inside its dialog at ${width}x${height}`);
      assert.equal(reportReachability.actionOnScreen, true, `report send action remains on-screen at ${width}x${height}`);
      await page.keyboard.press('Escape');
    }
    await page.evaluate(() => window.catalog.destroy());
  } finally {
    await browser.close();
  }
});

test('5,000-entry offline catalog interaction benchmark', {skip: browserSkip}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'http://extra-tracks.test/catalog-ui.mjs') await route.fulfill({contentType: 'text/javascript', body: moduleSource});
      else if (url === 'http://extra-tracks.test/') await route.fulfill({contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><main id="root"></main>'});
      else await route.abort();
    });
    await page.goto('http://extra-tracks.test/');
    const timings = await page.evaluate(async ({baseEntries}) => {
      const {mountExtraTracks} = await import('/catalog-ui.mjs');
      const entries = Array.from({length: 5000}, (_, index) => {
        const base = baseEntries[index % baseEntries.length];
        return {...base, id: `bench-${index}`, trackId: `track-hash-${index}`, name: `Track ${String(index).padStart(4, '0')} ${base.name}`, thumbnailUrl: undefined};
      });
      const root = document.querySelector('#root');
      const mountStart = performance.now();
      window.catalog = mountExtraTracks({document, root, entries});
      const mountMs = performance.now() - mountStart;
      const openStart = performance.now();
      window.catalog.open();
      const openMs = performance.now() - openStart;
      const measure = callback => {
        const start = performance.now();
        callback();
        return performance.now() - start;
      };
      const search = root.querySelector('input[type="search"]');
      const searchMs = [];
      for (const query of ['T', 'Tr', 'Tra', 'Trac', 'Track', 'Track ', 'Track 0', 'Track 00', 'Track 000', 'Track 0001', 'Track']) {
        search.value = query;
        searchMs.push(measure(() => search.dispatchEvent(new Event('input', {bubbles: true}))));
      }
      search.value = '';
      search.dispatchEvent(new Event('input', {bubbles: true}));
      const sort = root.querySelectorAll('.sq-extra-field select')[4];
      const sortMs = [];
      const sortValues = Array.from({length: 35}, (_, index) => index % 2 ? 'size-smallest' : 'size-largest');
      for (const value of sortValues.slice(0, 5)) {
        sort.value = value;
        sort.dispatchEvent(new Event('change', {bubbles: true}));
      }
      for (const value of sortValues.slice(5)) {
        sort.value = value;
        sortMs.push(measure(() => sort.dispatchEvent(new Event('change', {bubbles: true}))));
      }
      sort.value = 'recommended';
      sort.dispatchEvent(new Event('change', {bubbles: true}));
      const pageMs = [];
      for (let index = 0; index < 5; index++) root.querySelector('.sq-extra-pagination button:last-child').click();
      for (let index = 0; index < 5; index++) root.querySelector('.sq-extra-pagination button:first-child').click();
      for (let index = 0; index < 30; index++) pageMs.push(measure(() => root.querySelector('.sq-extra-pagination button:last-child').click()));
      window.catalog.destroy();
      const summary = values => {
        const sorted = [...values].sort((a, b) => a - b);
        return {samples: values.length, medianMs: +sorted[Math.floor(sorted.length * 0.5)].toFixed(2), p95Ms: +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(2), maxMs: +sorted.at(-1).toFixed(2)};
      };
      return {entries: entries.length, mountMs: +mountMs.toFixed(2), openMs: +openMs.toFixed(2), searchPerKeystroke: summary(searchMs), sort: summary(sortMs), pageNavigation: summary(pageMs)};
    }, {baseEntries: catalog});
    console.log(`Extra Tracks benchmark UTC ${new Date().toISOString()}: ${JSON.stringify(timings)}`);
  } finally {
    await browser.close();
  }
});

test('delayed dialog requests cannot mutate a newer close/reopen session', {skip: browserSkip}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'http://extra-tracks.test/catalog-ui.mjs') await route.fulfill({contentType: 'text/javascript', body: moduleSource});
      else if (url === 'http://extra-tracks.test/') await route.fulfill({contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><main id="root"></main>'});
      else await route.abort();
    });
    await page.goto('http://extra-tracks.test/');
    await page.evaluate(async () => {
      const {mountExtraTracks} = await import('/catalog-ui.mjs');
      window.submitResolvers = [];
      window.reportResolvers = [];
      window.catalog = mountExtraTracks({
        document,
        root: document.querySelector('#root'),
        entries: [{id: 'race-a', name: 'Race A', author: 'Tester'}, {id: 'race-b', name: 'Race B', author: 'Tester'}],
        onSubmit: () => new Promise((resolve, reject) => window.submitResolvers.push({resolve, reject})),
        onReport: entry => new Promise((resolve, reject) => window.reportResolvers.push({entryId: entry.id, resolve, reject}))
      });
      window.catalog.open();
    });
    const submission = page.getByRole('dialog', {name: 'Submit an Extra Track'});
    for (const outcome of ['resolve', 'reject']) {
      await page.getByRole('button', {name: 'Submit a track'}).click();
      await page.getByLabel('Track name').fill(`Race ${outcome}`);
      await page.getByLabel('Creator name').fill('Tester');
      await page.getByLabel('PolyTrack export code').fill(`PolyTrack${'A'.repeat(24)}`);
      await page.getByLabel('I created this track or have permission to share its code.').check();
      await page.getByRole('button', {name: 'Send for review'}).click();
      const index = outcome === 'resolve' ? 0 : 1;
      await page.waitForFunction(index => window.submitResolvers.length > index, index);
      await submission.getByRole('button', {name: 'Close'}).click();
      if (outcome === 'resolve') {
        await page.getByRole('button', {name: 'More actions for Race A'}).click();
        await page.getByRole('button', {name: 'Report track'}).click();
        const reportSend = page.getByRole('button', {name: 'Send report'});
        assert.equal(await reportSend.isDisabled(), true, 'submission in flight disables the report send control');
        assert.match(await page.locator('.sq-extra-report-status').textContent(), /Another request is still processing/);
        await page.evaluate(({index, outcome}) => window.submitResolvers[index][outcome](), {index, outcome});
        await page.waitForFunction(() => !document.querySelector('.sq-extra-report-send').disabled);
        assert.equal(await page.getByRole('dialog', {name: 'Report a track'}).isVisible(), true, 'settling the submission does not close the other dialog');
        assert.equal(await page.locator('.sq-extra-report-status').isHidden(), true, 'cross-type wait message clears after completion');
        await page.getByRole('dialog', {name: 'Report a track'}).getByRole('button', {name: 'Close'}).click();
        assert.equal(await page.getByRole('button', {name: 'Submit a track'}).isDisabled(), false, 'submission control is restored too');
      } else {
        await page.getByRole('button', {name: 'Submit a track'}).click();
        await submission.waitFor({state: 'visible'});
        assert.equal(await page.getByRole('button', {name: 'Send for review'}).isDisabled(), true, 'in-flight submission stays locked after reopening');
        await page.evaluate(({index, outcome}) => window.submitResolvers[index][outcome](), {index, outcome});
        await page.waitForFunction(() => !document.querySelector('.sq-extra-send').disabled);
        assert.equal(await submission.isVisible(), true, 'late submission result leaves the newer form open');
        assert.doesNotMatch(await page.locator('.sq-extra-submission-status').textContent(), /received for review|Could not send/);
      }
    }

    const openReport = async name => {
      await page.getByRole('button', {name: `More actions for ${name}`}).click();
      await page.getByRole('button', {name: 'Report track'}).click();
    };
    const report = page.getByRole('dialog', {name: 'Report a track'});
    await openReport('Race A');
    await page.getByLabel('Broken or unplayable').check();
    await page.getByRole('button', {name: 'Send report'}).click();
    await page.waitForFunction(() => window.reportResolvers.length === 1);
    await report.getByRole('button', {name: 'Close'}).click();
    await openReport('Race B');
    assert.equal(await page.locator('.sq-extra-report-entry').textContent(), 'Race B');
    await page.evaluate(() => window.reportResolvers[0].resolve());
    await page.waitForFunction(() => !document.querySelector('.sq-extra-report-send').disabled);
    assert.equal(await report.isVisible(), true);
    assert.equal(await page.locator('.sq-extra-report-entry').textContent(), 'Race B');
    assert.equal(await page.locator('.sq-extra-report-status').isHidden(), true, 'old success is not shown in the newer report');

    await page.getByLabel('Incorrect credit').check();
    await page.getByRole('button', {name: 'Send report'}).click();
    await page.waitForFunction(() => window.reportResolvers.length === 2);
    await report.getByRole('button', {name: 'Close'}).click();
    await openReport('Race A');
    await page.evaluate(() => window.reportResolvers[1].reject(new Error('stale report failure')));
    await page.waitForFunction(() => !document.querySelector('.sq-extra-report-send').disabled);
    assert.equal(await page.locator('.sq-extra-report-entry').textContent(), 'Race A');
    assert.doesNotMatch(await page.locator('.sq-extra-report-status').textContent(), /Could not send|stale report failure/);
  } finally {
    await browser.close();
  }
});
