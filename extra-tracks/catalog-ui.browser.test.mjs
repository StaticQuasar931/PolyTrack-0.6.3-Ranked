import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const browserSkip = !chromium && 'Set PLAYWRIGHT_MODULE to the bundled Playwright package to run this browser test.';
const moduleSource = fs.readFileSync(new URL('./catalog-ui.mjs', import.meta.url), 'utf8');
const reviewSource = fs.readFileSync(new URL('./review.mjs', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./catalog.css', import.meta.url), 'utf8');
const catalog = JSON.parse(fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
const homeCss = fs.readFileSync(new URL('../home-ui.css', import.meta.url), 'utf8');
const eventsCss = fs.readFileSync(new URL('../events/events.css', import.meta.url), 'utf8');
const rankedSource = fs.readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const rankedCssFragments = [...rankedSource.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\\\])*?")/g)];
const rankedCss = rankedCssFragments.map(fragment => JSON.parse(fragment[1])).join('\n');

test('Extra Tracks nested dialogs contain focus, close correctly, and restore their launchers', {skip: browserSkip}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    const requested = [];
    await page.route('**/*', async route => {
      const url = route.request().url();
      requested.push(url);
      if (url === 'http://extra-tracks.test/review.mjs') {
        await route.fulfill({contentType: 'text/javascript', body: reviewSource});
      } else if (url === 'http://extra-tracks.test/catalog-ui.mjs') {
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
    assert.deepEqual(requested, ['http://extra-tracks.test/','http://extra-tracks.test/catalog-ui.mjs','http://extra-tracks.test/review.mjs'], 'test loads only the local UI and review helper');
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
      if (url === 'http://extra-tracks.test/review.mjs') await route.fulfill({contentType: 'text/javascript', body: reviewSource});
      else if (url === 'http://extra-tracks.test/catalog-ui.mjs') await route.fulfill({contentType: 'text/javascript', body: moduleSource});
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
    await more.scrollIntoViewIfNeeded();
    await page.waitForTimeout(80);
    const cardBoundsBeforeMenu = await page.locator('.sq-extra-card').evaluateAll(cards => cards.map(card => [card.offsetLeft,card.offsetTop,card.offsetWidth,card.offsetHeight]));
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    await more.click();
    assert.equal(await more.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Helpful', 'opening the disclosure moves focus into the floating controls');
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
    await page.getByLabel('My rating for Preview Track').selectOption('8');
    assert.equal(await page.evaluate(() => window.feedback.rating), 8, 'native dropdown keeps rating callbacks working');
    await page.getByLabel('My rating for Preview Track').focus();
    await page.keyboard.press('0');
    assert.equal(await page.evaluate(() => window.feedback.rating), 10, 'zero quick-rates ten while the rating select is focused');
    const difficultyRating = page.getByLabel('My difficulty rating for Preview Track');
    await difficultyRating.selectOption('7');
    assert.equal(await page.evaluate(() => window.feedback.difficultyRating), 7);
    assert.equal(await page.evaluate(() => window.feedback.rating), 10, 'difficulty does not overwrite quality');
    await difficultyRating.focus();
    await page.keyboard.press('0');
    assert.equal(await page.evaluate(() => window.feedback.difficultyRating), 10, 'focused difficulty uses its own quick rating');
    const menuFavorite = menu.getByRole('button', {name: 'Remove from favorites'});
    await menuFavorite.click();
    assert.equal(await page.evaluate(() => window.feedback.favorite), false, 'favorite toggle is available inside the open menu');
    await page.getByText('Edit tags', {exact: true}).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const expandedBounds = await menu.boundingBox();
    assert.ok(expandedBounds && expandedBounds.x >= 8 && expandedBounds.y >= 8 && expandedBounds.x + expandedBounds.width <= 952 && expandedBounds.y + expandedBounds.height <= 892, `expanded tag picker stays inside the viewport: ${JSON.stringify(expandedBounds)}`);
    await page.getByRole('button', {name: 'Add Scenic'}).click();
    assert.deepEqual(await page.evaluate(() => window.feedback.addedTags), ['scenic'], 'unused valid tags can be added locally');
    assert.equal(await previewCard.locator('.sq-extra-tags').getByText('Scenic', {exact: true}).isVisible(), true, 'added tags appear immediately on the track card');
    const tagSearch = page.getByRole('searchbox', {name: 'Search tags to add or remove'});
    await tagSearch.fill('mini');
    assert.equal(await page.getByRole('button', {name: 'Add Mini', exact: true}).isVisible(), true);
    assert.equal(await page.getByRole('button', {name: 'Remove Scenic', exact: true}).isVisible(), false);
    await tagSearch.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.feedback.addedTags), ['scenic', 'mini']);
    await tagSearch.fill('7');
    assert.equal(await page.evaluate(() => window.feedback.rating), 10, 'tag search does not change the quick rating');
    assert.equal(await page.getByText('No matching tags.', {exact: true}).isVisible(), true);
    await tagSearch.fill('');
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
      if (route.request().url() === 'http://extra-tracks.test/review.mjs') await route.fulfill({contentType: 'text/javascript', body: reviewSource});
      else if (route.request().url() === 'http://extra-tracks.test/catalog-ui.mjs') await route.fulfill({contentType: 'text/javascript', body: moduleSource});
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
      if (url === 'http://extra-tracks.test/review.mjs') await route.fulfill({contentType: 'text/javascript', body: reviewSource});
      else if (url === 'http://extra-tracks.test/catalog-ui.mjs') await route.fulfill({contentType: 'text/javascript', body: moduleSource});
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
      if (url === 'http://extra-tracks.test/review.mjs') await route.fulfill({contentType: 'text/javascript', body: reviewSource});
      else if (url === 'http://extra-tracks.test/catalog-ui.mjs') await route.fulfill({contentType: 'text/javascript', body: moduleSource});
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

test('real catalog previews stay uncropped in desktop and portrait game layouts', {skip: browserSkip}, async () => {
  const browser = await chromium.launch({headless: true});
  const entries = catalog.filter(entry => entry.thumbnailUrl?.startsWith('extra-tracks/thumbnails/')).slice(0, 12);
  assert.ok(entries.length >= 8, 'real catalog thumbnail fixtures are available');
  try {
    const page = await browser.newPage({viewport: {width: 1365, height: 900}});
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.href === 'http://extra-tracks.test/review.mjs') {
        await route.fulfill({contentType: 'text/javascript', body: reviewSource});
      } else if (url.href === 'http://extra-tracks.test/catalog-ui.mjs') {
        await route.fulfill({contentType: 'text/javascript', body: moduleSource});
      } else if (url.href === 'http://extra-tracks.test/') {
        await route.fulfill({contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><main id="root"></main>'});
      } else if (url.pathname.startsWith('/extra-tracks/thumbnails/')) {
        await route.fulfill({contentType: 'image/png', body: fs.readFileSync(new URL(`../${url.pathname.slice(1)}`, import.meta.url))});
      } else {
        await route.abort();
      }
    });
    await page.goto('http://extra-tracks.test/');
    await page.addStyleTag({content: eventsCss});
    await page.addStyleTag({content: homeCss});
    await page.addStyleTag({content: rankedCss});
    await page.addStyleTag({content: css});
    await page.evaluate(async entries => {
      const host = document.createElement('div');
      host.id = 'ui';
      host.innerHTML = '<div class="track-selection-ui"><div class="tracks-container"><div class="wrapper"></div></div></div>';
      document.body.append(host);
      const {mountExtraTracks} = await import('/catalog-ui.mjs');
      window.catalog = mountExtraTracks({document, root: document.body, entries});
      window.catalog.open();
    }, entries);

    const inspectLayout = async (width, height, screenshotName) => {
      await page.setViewportSize({width, height});
      const images = page.locator('.sq-extra-visual img');
      await images.first().waitFor({state: 'visible'});
      const reports = [];
      for (let index = 0; index < await images.count(); index++) {
        const image = images.nth(index);
        await image.scrollIntoViewIfNeeded();
        await image.evaluate(img => img.decode());
        const pixelTarget = await image.evaluate(img => {
          const source = document.createElement('canvas');
          source.width = img.naturalWidth;
          source.height = img.naturalHeight;
          const sourceContext = source.getContext('2d', {willReadFrequently: true});
          sourceContext.drawImage(img, 0, 0);
          const sourcePixels = sourceContext.getImageData(0, 0, source.width, source.height).data;
          let point = null, score = -1;
          for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
            const offset = (y * source.width + x) * 4;
            if (sourcePixels[offset + 3] !== 255) continue;
            const saturation = Math.max(sourcePixels[offset], sourcePixels[offset + 1], sourcePixels[offset + 2]) - Math.min(sourcePixels[offset], sourcePixels[offset + 1], sourcePixels[offset + 2]);
            const candidate = saturation * 2 + Math.max(sourcePixels[offset], sourcePixels[offset + 1], sourcePixels[offset + 2]);
            if (candidate > score) { score = candidate; point = {x, y, color: [...sourcePixels.slice(offset, offset + 3)]}; }
          }
          const bounds = img.getBoundingClientRect();
          const scale = Math.min(bounds.width / img.naturalWidth, bounds.height / img.naturalHeight);
          return {left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
            x: (bounds.width - img.naturalWidth * scale) / 2 + (point.x + .5) * scale,
            y: (bounds.height - img.naturalHeight * scale) / 2 + (point.y + .5) * scale,
            sourceColor: point.color};
        });
        const visualSample = await page.screenshot({clip: {x: pixelTarget.left, y: pixelTarget.top, width: pixelTarget.width, height: pixelTarget.height}});
        const renderedColor = await page.evaluate(async ({png, x, y, sourceColor}) => {
          const decoded = new Image();
          decoded.src = `data:image/png;base64,${png}`;
          await decoded.decode();
          const canvas = document.createElement('canvas');
          canvas.width = decoded.naturalWidth;
          canvas.height = decoded.naturalHeight;
          const context = canvas.getContext('2d', {willReadFrequently: true});
          context.drawImage(decoded, 0, 0);
          // Fractional contain scaling and screenshot clipping can round by one
          // device pixel. Check that small neighborhood, not a large crop escape.
          let best=null,bestDelta=Infinity;
          for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
            const px=Math.max(0,Math.min(canvas.width-1,Math.floor(x)+dx));
            const py=Math.max(0,Math.min(canvas.height-1,Math.floor(y)+dy));
            const color=[...context.getImageData(px,py,1,1).data].slice(0,3);
            const delta=Math.max(...color.map((channel,index)=>Math.abs(channel-sourceColor[index])));
            if(delta<bestDelta){bestDelta=delta;best=color;}
          }
          return best;
        }, {png: visualSample.toString('base64'), x: pixelTarget.x, y: pixelTarget.y,sourceColor:pixelTarget.sourceColor});
        const pixelDelta = Math.max(...renderedColor.map((channel, channelIndex) => Math.abs(channel - pixelTarget.sourceColor[channelIndex])));
        assert.ok(pixelDelta <= 40, `${await image.getAttribute('alt') || `catalog image ${index + 1}`} PNG pixel is visible at its contain-scaled position: expected ${pixelTarget.sourceColor}, got ${renderedColor}`);
        const report = await image.evaluate(img => {
          const bounds = img.getBoundingClientRect();
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const context = canvas.getContext('2d', {willReadFrequently: true});
          context.drawImage(img, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            if (pixels[(y * canvas.width + x) * 4 + 3] === 0) continue;
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x); bottom = Math.max(bottom, y);
          }
          const clipped = [];
          for (let parent = img.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            const clipsOverflow = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX) || ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY);
            if (clipsOverflow) {
              const rect = parent.getBoundingClientRect();
              const clip = {left: rect.left + parent.clientLeft, top: rect.top + parent.clientTop,
                right: rect.left + parent.clientLeft + parent.clientWidth,
                bottom: rect.top + parent.clientTop + parent.clientHeight};
              if (bounds.left < clip.left - 1 || bounds.top < clip.top - 1 || bounds.right > clip.right + 1 || bounds.bottom > clip.bottom + 1) {
                clipped.push({selector: parent.className, overflowX: style.overflowX, overflowY: style.overflowY});
              }
            }
            if (style.clipPath !== 'none' || style.maskImage !== 'none') clipped.push({selector: parent.className, clipPath: style.clipPath, maskImage: style.maskImage});
          }
          const card = img.closest('.sq-extra-card');
          const style = getComputedStyle(img);
          const frame = img.parentElement.getBoundingClientRect();
          const frameStyle = getComputedStyle(img.parentElement);
          return {name: card?.querySelector('h3')?.textContent, natural: [img.naturalWidth, img.naturalHeight],
            alphaBounds: [left, top, right, bottom], box: [bounds.width, bounds.height], frame: [frame.width, frame.height],
            objectFit: style.objectFit, objectPosition: style.objectPosition, transform: style.transform,
            inset: [bounds.left - frame.left - parseFloat(frameStyle.borderLeftWidth),
              bounds.top - frame.top - parseFloat(frameStyle.borderTopWidth),
              frame.right - bounds.right - parseFloat(frameStyle.borderRightWidth),
              frame.bottom - bounds.bottom - parseFloat(frameStyle.borderBottomWidth)],
            clipped, hasNativeFrameAncestor: !!img.closest('.thumbnail, .profile-track-image-frame, .image-container')};
        });
        assert.ok(report.natural[0] > 0 && report.natural[1] > 0, `${report.name} loaded its real catalog PNG`);
        assert.ok(report.alphaBounds[2] >= report.alphaBounds[0] && report.alphaBounds[3] >= report.alphaBounds[1], `${report.name} PNG has visible alpha bounds`);
        assert.equal(report.objectFit, 'contain', `${report.name} uses contain in the actual page cascade`);
        assert.equal(report.objectPosition, '50% 50%', `${report.name} stays centered`);
        for (const side of report.inset) assert.ok(Math.abs(side - 10) < 0.05, `${report.name} has 10px preview breathing room: ${JSON.stringify(report.inset)}`);
        assert.ok(report.box[0] < report.frame[0] && report.box[1] < report.frame[1], `${report.name} keeps its contain-scaled map bounds inside the preview frame`);
        assert.equal(report.transform, 'none', `${report.name} has no image transform`);
        assert.deepEqual(report.clipped, [], `${report.name} has no clipping or masking ancestor`);
        assert.equal(report.hasNativeFrameAncestor, false, `${report.name} is outside native thumbnail/profile frames`);
        reports.push(report);
      }
      await page.evaluate(() => { const menu = document.querySelector('.sq-extra-menu'); if (menu) menu.scrollTop = 0; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const evidenceDir = process.env.EXTRA_TRACKS_PREVIEW_EVIDENCE_DIR;
      if (evidenceDir) {
        fs.mkdirSync(evidenceDir, {recursive: true});
        await page.screenshot({path: path.join(evidenceDir, screenshotName)});
      }
      console.log(`Extra Tracks preview evidence ${width}x${height}: ${JSON.stringify(reports)}`);
    };

    await inspectLayout(1365, 900, 'extra-tracks-previews-desktop.png');
    await inspectLayout(390, 844, 'extra-tracks-previews-portrait.png');
    await page.evaluate(() => window.catalog.destroy());
  } finally {
    await browser.close();
  }
});

test('native leaderboard inactive filter label stays on one line', {skip: browserSkip}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>
      html,body{width:100%;height:100%;margin:0} #gameRoot{position:relative;width:100%;height:100%}
      .track-info-ui{position:absolute;inset:0;display:flex;align-items:stretch;justify-content:center;gap:16px;width:100%;height:100%;padding:16px;box-sizing:border-box}
      .side-panel{width:280px;flex:none}.leaderboard-ui{display:flex;flex-direction:column;align-items:stretch;width:min(520px,100%);min-width:0;min-height:0;margin:auto}
      .leaderboard-ui>.button-wrapper{height:44px;display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;overflow:hidden}
      .leaderboard-ui>.button-wrapper>button{min-width:0;min-height:44px;padding:6px;font:16px ForcedSquare,sans-serif;box-sizing:border-box}
      .leaderboard-ui>.button-wrapper>.back{margin:10px}.leaderboard-ui>.button-wrapper>.icon-button{width:44px}
      .leaderboard-ui>.button-wrapper>.only-verified{white-space:nowrap}
    </style><div id="gameRoot"><main class="track-info-ui"><section class="side-panel"></section><section class="leaderboard-ui"><div class="button-wrapper">
      <button class="button back">Back</button><button class="button" data-personal-filter-button>Filters-Inactive</button>
      <button class="button icon-button first" aria-label="Find me">◎</button><button class="button only-verified">Only verified</button>
    </div></section></main></div>`);
    await page.addStyleTag({content: rankedCss});
    await page.addStyleTag({content: homeCss});
    for (const [width, height] of [[320, 720], [390, 844], [600, 960], [600, 400], [820, 1180], [1920, 1080]]) {
      await page.setViewportSize({width, height});
      const label = await page.locator('[data-personal-filter-button]').evaluate(button => {
        const range = document.createRange();
        range.selectNodeContents(button);
        const rects = [...range.getClientRects()];
        const box = button.getBoundingClientRect();
        return {lines: rects.length, box: [box.x, box.y, box.width, box.height], text: button.textContent};
      });
      assert.equal(label.lines, 1, `Filters-Inactive stays on one line at ${width}x${height}: ${JSON.stringify(label)}`);
    }
  } finally {
    await browser.close();
  }
});
