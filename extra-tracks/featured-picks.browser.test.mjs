import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
let chromium; try {
  const engines = require(process.env.PLAYWRIGHT_MODULE || '../tools/verifier/node_modules/playwright');
  chromium = process.env.POLYTRACK_LAYOUT_BROWSER === 'firefox' ? engines.firefox : engines.chromium;
} catch {}
const sources = new Map(['catalog-ui.mjs', 'review.mjs', 'reviewed.mjs', 'reviewed-data.mjs', 'snapshot-popularity.mjs', 'featured-picks.mjs', 'random-picker.mjs', 'builder-contact.mjs'].map(name => [name, fs.readFileSync(new URL(name, import.meta.url), 'utf8')]));
sources.set('tools/search-text.mjs', fs.readFileSync(new URL('../tools/search-text.mjs', import.meta.url), 'utf8'));
const font=fs.readFileSync(new URL('../forced_square.woff2',import.meta.url)).toString('base64');
const css = fs.readFileSync(new URL('catalog.css', import.meta.url), 'utf8')+`\n@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font})}body{font-family:ForcedSquare,sans-serif}`;
const entries = JSON.parse(fs.readFileSync(new URL('catalog.json', import.meta.url), 'utf8')).slice(0, 8);
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
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('14px ForcedSquare')), true);
    for (const [width, height] of [[1366, 900], [1024, 900], [390, 844], [320, 740], [280, 653], [320, 568], [844, 390]]) {
      await page.setViewportSize({width, height});
      await page.locator('.sq-extra-menu').evaluate(node => node.scrollTop = 0);
      if (height <= 700 && await page.locator('.sq-extra-featured-toggle').getAttribute('aria-expanded') === 'true') {
        await page.getByRole('button', {name: 'Hide spotlights', exact: true}).click();
      }
      assert.equal(await page.locator('.sq-extra-featured>.sq-extra-pick').count(), 4);
      assert.equal(await page.locator('.sq-extra-featured').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const visible = page.locator('.sq-extra-featured>.sq-extra-pick:visible');
      assert.equal(await visible.count(), height <= 700 ? 0 : width <= 600 ? 1 : 4);
      await page.locator('.sq-extra-featured img:visible').evaluateAll(nodes => Promise.all(nodes.map(image => image.decode().catch(() => {}))));
      if (height > 700) {
        const images = await visible.locator('img').evaluateAll(nodes => nodes.map(node => ({fit: getComputedStyle(node).objectFit, opacity: getComputedStyle(node).opacity, filter: getComputedStyle(node).filter, font: getComputedStyle(node.closest('.sq-extra-overlay')).fontFamily})));
        assert.ok(images.length > 0);
        for (const image of images) {assert.equal(image.fit, 'contain');assert.equal(image.opacity, '1');assert.equal(image.filter, 'none');assert.match(image.font, /ForcedSquare/);}
        assert.match(await visible.first().innerText(), /Created by/);
      }
      const grid = page.locator('.sq-extra-grid');
      await grid.scrollIntoViewIfNeeded();
      const listBox = await grid.boundingBox();
      assert.ok(listBox.y < height && listBox.y + listBox.height > 0, 'catalog is scroll-accessible at ' + width + 'x' + height);
      await page.locator('.sq-extra-menu').evaluate(node => node.scrollTop = 0);
      const search = page.getByRole('searchbox', {name: 'Search tracks'});
      await search.fill('Everlasting'); assert.equal(await page.locator('.sq-extra-featured').isHidden(), true);
      await search.fill('');
      if (process.env.EXTRA_TRACKS_SCREENSHOT_DIR) await page.screenshot({path: process.env.EXTRA_TRACKS_SCREENSHOT_DIR + '/featured-' + width + 'x' + height + '.png'});
      if (height <= 700) {
        await page.getByRole('button', {name: 'Show spotlights', exact: true}).click();
        assert.equal(await page.locator('.sq-extra-featured>.sq-extra-pick:visible').count(), width <= 600 ? 1 : 4);
        await page.locator('.sq-extra-featured img:visible').evaluateAll(nodes => Promise.all(nodes.map(image => image.decode().catch(() => {}))));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.EXTRA_TRACKS_SCREENSHOT_DIR) await page.screenshot({path: process.env.EXTRA_TRACKS_SCREENSHOT_DIR + '/featured-expanded-' + width + 'x' + height + '.png'});
        await page.getByRole('button', {name: 'Hide spotlights', exact: true}).click();
      }
      if (width <= 600) {
        if (height <= 700) await page.getByRole('button', {name: 'Show spotlights', exact: true}).click();
        for (const [kind, label] of [['daily', 'Creator'], ['weekly', 'Discover'], ['critics', 'Critics'], ['roulette', 'Roulette']]) {
          await page.getByRole('tab', {name: label, exact: true}).click();
          const tile = page.locator('.sq-extra-pick-' + kind);
          await tile.scrollIntoViewIfNeeded();
          assert.equal(await visible.count(), 1, 'exactly the selected phone lane is visible');
          const bounds = await tile.evaluate(node => {
            const rect = node.getBoundingClientRect(), art = node.querySelector('figure').getBoundingClientRect();
            return {left: rect.left, right: rect.right, height: rect.height, imageHeight: art.height,
              overflow: [...node.querySelectorAll('h3,p,button,time')].some(child => child.scrollWidth > child.clientWidth + 1)};
          });
          assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.height <= height, kind + ' selected card fits ' + width + 'x' + height);
          assert.ok(bounds.imageHeight >= 96 && bounds.imageHeight <= 100, kind + ' has a compact contained phone preview');
          assert.equal(bounds.overflow, false, kind + ' details do not overflow horizontally');
          assert.match(await tile.innerText(), /Created by/);
          await tile.locator('img').evaluateAll(nodes => Promise.all(nodes.map(image => image.decode().catch(() => {}))));
          if (process.env.EXTRA_TRACKS_SCREENSHOT_DIR) await page.screenshot({path: process.env.EXTRA_TRACKS_SCREENSHOT_DIR + '/selected-' + kind + '-' + width + 'x' + height + '.png'});
        }
        await page.getByRole('tab', {name: 'Creator', exact: true}).click();
        if (height <= 700) await page.getByRole('button', {name: 'Hide spotlights', exact: true}).click();
      } else {
        if (height <= 700) await page.getByRole('button', {name: 'Show spotlights', exact: true}).click();
        assert.equal(await visible.count(), 4);
        const cards = await visible.evaluateAll(nodes => nodes.map(node => {
          const rect = node.getBoundingClientRect(), art = node.querySelector('figure').getBoundingClientRect();
          return {left: rect.left, right: rect.right, width: rect.width, artWidth: art.width, artHeight: art.height};
        }));
        for (const card of cards) {
          assert.ok(card.left >= 0 && card.right <= width, 'all four desktop/tablet cards fit horizontally');
          assert.ok(card.artWidth >= card.width - 4 && card.artHeight >= 112 && card.artHeight <= 116, 'desktop/tablet art is full-width, contained and compact');
        }
        if (height <= 700) await page.getByRole('button', {name: 'Hide spotlights', exact: true}).click();
      }
      await page.locator('.sq-extra-menu').evaluate(node => node.scrollTop = 0);
    }
    await page.setViewportSize({width:390,height:844});
    assert.match(await page.locator('.sq-extra-featured').innerText(), /CREATOR SPOTLIGHT/);
    assert.doesNotMatch(await page.locator('.sq-extra-featured').innerText(), /Catalog fallback/);
    await page.evaluate(() => window.catalog.setSnapshotStatistics({generation: 1, statistics: {schemaVersion: 1,
      tracks: Object.fromEntries(window.fixtureEntries.map(entry => [entry.trackId, {complete: true, players: 0, count: 0, totalEntries: 0}]))}}));
    assert.match(await page.locator('.sq-extra-featured').innerText(), /0 players/);
    await page.evaluate(() => window.catalog.setSnapshotStatistics({generation: 2, statistics: {schemaVersion: 1, tracks: {}}}));
    assert.equal(await page.locator('.sq-extra-featured-note').innerText(), 'Featured picks');
    assert.doesNotMatch(await page.locator('.sq-extra-featured').innerText(), /Player count unknown|Rating unknown/);
    assert.doesNotMatch(await page.locator('.sq-extra-featured').innerText(), /0 players|undefined|NaN/);
    if (process.env.EXTRA_TRACKS_SCREENSHOT) await page.screenshot({path: process.env.EXTRA_TRACKS_SCREENSHOT});
    await page.setViewportSize({width: 320, height: 568});
    assert.equal(await page.locator('.sq-extra-featured>.sq-extra-pick:visible').count(), 0, 'short phones default to collapsed spotlights');
    await page.getByRole('button', {name: 'Show spotlights', exact: true}).click();
    assert.equal(await page.locator('.sq-extra-featured>.sq-extra-pick:visible').count(), 1);
    await page.getByRole('tab', {name: 'Discover', exact: true}).click();
    assert.equal(await page.locator('.sq-extra-pick-weekly').isVisible(), true);
    assert.match(await page.locator('.sq-extra-pick-weekly').innerText(), /EDITORIAL DISCOVERY/);
    await page.getByRole('button', {name: 'Hide spotlights', exact: true}).click();
    assert.equal(await page.locator('.sq-extra-count').textContent(), `${entries.length} of ${entries.length} tracks`);
    if (process.env.EXTRA_TRACKS_SCREENSHOT_DIR) await page.screenshot({path: process.env.EXTRA_TRACKS_SCREENSHOT_DIR + '/featured-short-320x568.png'});
    await page.setViewportSize({width: 280, height: 844});
    await page.getByRole('tab', {name: 'Creator', exact: true}).click();
    await page.getByRole('button', {name: /^Play track:.*\(creator spotlight\)$/}).click();
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


test('Builder contact stays local until a user chooses a link, fits phones and preserves search on Back and Escape', {skip: !chromium}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    const unexpected = [], errors = [], moduleRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url()), name = url.pathname.slice(1);
      if (url.origin !== 'http://featured.test') {unexpected.push(url.href);return route.abort();}
      if (sources.has(name)) {moduleRequests.push(name);return route.fulfill({contentType:'text/javascript',body:sources.get(name)});}
      if (!name) return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><main id="root"></main>'});
      if (thumbnails.has(name)) return route.fulfill({contentType:name.endsWith('.webp')?'image/webp':'image/png',body:thumbnails.get(name)});
      unexpected.push(url.href);return route.abort();
    });
    await page.goto('http://featured.test/');await page.addStyleTag({content:css});
    await page.evaluate(async entries => {
      const {mountExtraTracks}=await import('/catalog-ui.mjs');
      window.catalog=mountExtraTracks({document,root:document.querySelector('#root'),entries});window.catalog.open();
    },entries);
    await page.evaluate(()=>document.fonts.ready);
    assert.equal(moduleRequests.includes('builder-contact.mjs'),false,'contact code is not loaded before user action');
    const search=page.getByRole('searchbox',{name:'Search tracks'});await search.fill('Everlasting');
    const initialDialogs=await page.getByRole('dialog').count();
    if(!await page.locator('.sq-extra-contribute').evaluate(el=>el.open))await page.locator('.sq-extra-contribute > summary').click();
    await page.locator('.sq-extra-builder-submenu > summary').click();
    const contact=page.locator('.sq-builder-contact');await contact.waitFor({state:'visible'});
    assert.equal(moduleRequests.filter(name=>name==='builder-contact.mjs').length,1);
    assert.equal(await page.getByRole('dialog').count(),initialDialogs,'contact uses the existing dialog');
    assert.equal(await page.getByRole('link',{name:'Contact on Discord',exact:true}).getAttribute('href'),'https://discord.gg/jW2az4AQUH');
    const email=new URL(await page.getByRole('link',{name:/^Email backup:/}).getAttribute('href'));
    assert.equal(email.protocol,'mailto:');assert.equal(email.pathname,'StaticQuasar931Games@gmail.com');
    assert.match(email.searchParams.get('body'),/Original creator/);assert.equal(email.searchParams.has('cc'),false);assert.equal(email.searchParams.has('bcc'),false);
    assert.equal(await contact.locator('details').getAttribute('open'),null);
    assert.equal(await contact.locator('.sq-builder-review-note').innerText(),'Credits and featuring are reviewed. Ports must credit original creators.');
    for(const [width,height] of [[1366,900],[390,844],[280,653],[320,568]]){
      await page.setViewportSize({width,height});
      const bounds=await contact.evaluate(node=>({right:node.getBoundingClientRect().right,width:node.getBoundingClientRect().width,overflow:node.scrollWidth>node.clientWidth+1,font:getComputedStyle(node).fontFamily}));
      assert.ok(bounds.right<=width+1&&bounds.width<=width&& !bounds.overflow,'contact fits '+width+'x'+height);
      assert.match(bounds.font,/ForcedSquare/);
      if(process.env.EXTRA_TRACKS_SCREENSHOT_DIR)await page.screenshot({path:process.env.EXTRA_TRACKS_SCREENSHOT_DIR+'/builder-contact-'+width+'x'+height+'.png'});
    }
    const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download message checklist',exact:true}).click()]);
    assert.equal(download.suggestedFilename(),'polytrack-builder-contact-checklist.txt');
    assert.match(fs.readFileSync(await download.path(),'utf8'),/Permissions and original credits/);
    await page.getByRole('button',{name:'Back to tracks',exact:true}).click();
    assert.equal(await search.inputValue(),'Everlasting');assert.equal(await page.locator('.sq-extra-card').count(),1);
    if(!await page.locator('.sq-extra-contribute').evaluate(el=>el.open))await page.locator('.sq-extra-contribute > summary').click();
    await page.locator('.sq-extra-builder-submenu > summary').click();await contact.waitFor({state:'visible'});
    await page.keyboard.press('Escape');assert.equal(await contact.isHidden(),true);assert.equal(await search.inputValue(),'Everlasting');
    assert.equal(await page.locator('.sq-extra-overlay').isVisible(),true);
    assert.deepEqual(unexpected,[],'no contact, Firebase or other external fetch is made');assert.deepEqual(errors,[]);
    await page.evaluate(()=>window.catalog.destroy());
  } finally {await browser.close();}
});


test('actual four UTC picks preserve cached PBs, canonical play links and keyboard tabs offline', {skip: !chromium}, async () => {
  const {featuredPicks} = await import('./featured-picks.mjs');
  const all = JSON.parse(fs.readFileSync(new URL('catalog.json', import.meta.url), 'utf8'));
  const selected = featuredPicks(all, new Map(), Date.parse('2026-11-04T12:00:00Z')).map(pick => pick.entry);
  assert.equal(selected.length, 4);
  for (const entry of selected) {
    assert.ok(fs.existsSync(new URL('../' + entry.trackPath, import.meta.url)));
    assert.equal(new URL(entry.sourceUrl).protocol, 'https:');
  }
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage(); const unexpected = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url()), name = url.pathname.slice(1);
      if (url.origin !== 'http://featured.test') {unexpected.push(url.href);return route.abort();}
      if (sources.has(name)) return route.fulfill({contentType:'text/javascript',body:sources.get(name)});
      if (!name) return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><main id="root"></main>'});
      if (all.some(entry => entry.thumbnailUrl === name)) return route.fulfill({contentType:name.endsWith('.webp')?'image/webp':'image/png',body:fs.readFileSync(new URL('../'+name,import.meta.url))});
      unexpected.push(url.href);return route.abort();
    });
    await page.goto('http://featured.test/');await page.addStyleTag({content:css});
    await page.evaluate(async ({entries, selected}) => {
      const {mountExtraTracks}=await import('/catalog-ui.mjs'); window.pbReads=0;window.played=[];
      window.catalog=mountExtraTracks({document,root:document.querySelector('#root'),entries,
        now:()=>Date.parse('2026-11-04T12:00:00Z'),
        getPersonalBest:entry=>{window.pbReads++;const index=selected.findIndex(item=>item.trackId===entry.trackId);return index===0?65432:index===1?{timeMs:54321}:null;},
        isLoaded:entry=>entry.trackId===selected[2].trackId,onPlay:entry=>window.played.push(entry.trackId)});window.catalog.open();
    },{entries:all,selected});
    await page.evaluate(()=>document.fonts.ready);
    const reads=await page.evaluate(()=>window.pbReads);
    assert.equal(reads,all.length*2);
    const layouts = [];
    for(const [width,height] of [[1366,900],[768,1024],[390,844],[280,653],[844,390]]) {
      await page.setViewportSize({width,height});
      if(height<=700&&await page.locator('.sq-extra-featured-toggle').getAttribute('aria-expanded')==='false') await page.getByRole('button',{name:'Show spotlights',exact:true}).click();
      if(width<=600) {
        const first=page.getByRole('tab',{name:'Creator',exact:true});await first.focus();await page.keyboard.press('ArrowRight');
        assert.equal(await page.getByRole('tab',{name:'Discover',exact:true}).getAttribute('aria-selected'),'true');
        assert.equal(await page.locator('.sq-extra-count').innerText(),all.length+' of '+all.length+' tracks','arrow keys select lanes, not catalog pages');
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      const cards = await page.locator('.sq-extra-featured>.sq-extra-pick:visible').evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect(), image = node.querySelector('figure').getBoundingClientRect();
        const footer = node.querySelector('.sq-extra-pick-footer'), metrics = node.querySelector('.sq-extra-pick-note');
        return {height:box.height,top:box.top,imageHeight:image.height,highlightFirst:Boolean(metrics.compareDocumentPosition(footer)&Node.DOCUMENT_POSITION_FOLLOWING)};
      }));
      assert.equal(cards.length,width<=600?1:4);
      assert.ok(cards.every(card=>card.highlightFirst),'catalog evidence is grouped above the separate play action');
      if(width===1366) {
        assert.ok(cards.every(card=>card.height<=350),'four desktop picks retain a bounded height with visible selection reasons');
        assert.ok(cards.every(card=>Math.abs(card.top-cards[0].top)<1),'all four desktop picks share one row');
      }
      layouts.push({width,height,cards});
      assert.equal(await page.locator('.sq-extra-pick-highlight .sq-extra-pick-reason').count(),4);
      assert.equal(await page.locator('.sq-extra-pick-footer .sq-extra-pick-reason').count(),0);
      assert.equal(await page.locator('.sq-extra-featured-note').count(),1);
      assert.equal(await page.locator('.sq-extra-pick-progress').filter({hasText:'Your best'}).count(),2);
      assert.equal(await page.locator('.sq-extra-pick-progress').filter({hasText:'Imported, no finish'}).count(),1);
      if(process.env.EXTRA_TRACKS_SCREENSHOT_DIR) await page.screenshot({path:process.env.EXTRA_TRACKS_SCREENSHOT_DIR+'/actual-four-'+width+'x'+height+'.png'});
    }
    if(process.env.EXTRA_TRACKS_SCREENSHOT_DIR) fs.writeFileSync(process.env.EXTRA_TRACKS_SCREENSHOT_DIR+'/compact-layout.json',JSON.stringify(layouts,null,2)+'\n');
    await page.setViewportSize({width:390,height:844});
    const firstTab=page.getByRole('tab',{name:'Creator',exact:true});
    await firstTab.focus();await page.keyboard.press('End');
    assert.equal(await page.getByRole('tab',{name:'Roulette',exact:true}).getAttribute('aria-selected'),'true');
    await page.keyboard.press('Home');
    assert.equal(await firstTab.getAttribute('aria-selected'),'true');
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.sq-extra-pick-daily .sq-extra-play').evaluate(node=>node===document.activeElement),true);
    await page.evaluate(()=>window.catalog.setSnapshotStatistics({generation:1,statistics:{schemaVersion:1,tracks:{}}}));
    assert.equal(await page.locator('.sq-extra-pick-daily .sq-extra-play').evaluate(node=>node===document.activeElement),true,'stats refresh preserves focused play action');
    assert.equal(await page.evaluate(()=>window.pbReads),reads,'tabs, resize and stats updates do not reread PBs');
    await page.setViewportSize({width:1366,height:900});
    for(let index=0;index<4;index++) {
      await page.evaluate(()=>window.catalog.open());
      await page.locator('.sq-extra-featured>.sq-extra-pick').nth(index).locator('button').click();
      await page.locator('.sq-extra-overlay').waitFor({state:'hidden'});
    }
    assert.deepEqual((await page.evaluate(()=>window.played)).sort(),selected.map(entry=>entry.trackId).sort());
    assert.deepEqual(unexpected,[],'no external services or track downloads');assert.deepEqual(errors,[]);
    await page.evaluate(()=>window.catalog.destroy());
  } finally {await browser.close();}
});
