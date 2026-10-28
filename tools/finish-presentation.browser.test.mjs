import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';

const require = createRequire(new URL('./verifier/package.json', import.meta.url));
const {chromium} = require('playwright');
const bundle = await fs.readFile(new URL('../main.bundle.js', import.meta.url), 'utf8');
const eventSource = await fs.readFile(new URL('../events/client.mjs', import.meta.url), 'utf8');
const slice = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `native extraction anchors: ${start}`);
  return source.slice(a, b);
};
// Extract literals and the real formatter/NT DOM renderer, never the game bootstrap.
const literal = bundle.match(/s\.push\(\[e\.id,('(?:\\.|[^'\\])*\.time-announcer-ui(?:\\.|[^'\\])*'),""\]\)/);
assert.ok(literal, 'native finish CSS is discoverable');
const nativeCSS = vm.runInNewContext(literal[1], Object.create(null), {timeout: 1000});
const globalLiteral = [...bundle.matchAll(/`(?:\\.|[^`\\])*`/g)].find(match => match[0].includes('@font-face'));
assert.ok(globalLiteral, 'native global CSS is discoverable');
const globalCSS = vm.runInNewContext(globalLiteral[0], {
  f: '/forced_square.woff2', p: '/forced_square.woff', g: '/forced_square.ttf',
}, {timeout: 1000});
const renderer = slice(bundle, 'function qe(e){return Qe(e)+Je(e)}', ';var it,rt,at,st,ot,lt');
const eventHelpers = slice(eventSource, 'export function eventOrdinal(', 'export function eventTrackName(').replace(/^export /, '')
  + slice(eventSource, '  function syncFinishPlace(){', '  function tick(');
const sheets = ['/events/events.css', '/home-ui.css', '/responsive-ui.css', '/practice-responsive.css', '/help-controls.css'];
const position = '.time-announcer-ui > .current > .position';
let browser, server;
before(async () => {
  server = await startResponsiveServer();
  browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
});
after(async () => {
  try { await browser?.close(); } finally { await server?.close(); }
});
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const finishAnimations = page => page.evaluate(() => {
  for (const animation of document.getAnimations()) animation.finish();
});

async function openPair(t, {reducedMotion = 'no-preference', enhance = true} = {}) {
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, reducedMotion, serviceWorkers: 'block'});
  const unexpected = [], errors = [];
  const allowed = new Set([...sheets, '/tools/finish-presentation.mjs', '/forced_square.woff2']);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === server.url && ['/native.html', '/production.html'].includes(url.pathname)) {
      const production = url.pathname === '/production.html';
      return route.fulfill({contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>${globalCSS}\n${nativeCSS}</style>
        ${production ? sheets.map(href => `<link rel="stylesheet" href="${href}">`).join('') : ''}
        </head><body><div id="ui"></div></body></html>`});
    }
    if (url.origin === server.url && allowed.has(url.pathname) && route.request().method() === 'GET') return route.continue();
    unexpected.push(url.href);
    return route.abort();
  });
  t.after(async () => {
    await context.close();
    assert.deepEqual(unexpected, [], 'no Firebase, game bootstrap, or external requests');
    assert.deepEqual(errors, [], 'no browser errors');
  });
  const pages = [];
  for (const kind of ['native', 'production']) {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}/${kind}.html`);
    await page.evaluate(async ({renderer, eventHelpers, production, enhance}) => {
      const R = {gn: (self, store, kind, method) => kind === 'm' ? method : store.get(self),
        GG: (self, store, value) => {store.set(self, value); return value;}};
      const {NativeAnnouncer, format} = new Function('R', 'He', renderer + ';return {NativeAnnouncer:nt,format:qe};')(
        R, {A: {formatTimeString: value => value.text}});
      window.nativeFormat = format;
      const time = {text: '00:24.531', difference: previous => ({text: previous.delta, isNegative: () => previous.negative})};
      window.announcer = new NativeAnnouncer(document.querySelector('#ui'), {get: key => key}, {getBuffer: () => null},
        'Rolling Hills Racer', time, {delta: '-00:00.123', negative: true}, 'personal-best',
        {record: {delta: '+00:00.456', negative: false}, nickname: 'Previous racer'},
        new Promise(resolve => {window.resolveRank = resolve;}));
      window.nativeRanks = [];
      new MutationObserver(() => window.nativeRanks.push(document.querySelector('.position').textContent))
        .observe(document.querySelector('.position'), {childList:true, characterData:true, subtree:true});
      window.eventPlace = {rank: 3, fieldSize: 64, provisional: true};
      if (production) {
        window.finish = await import('/tools/finish-presentation.mjs');
        window.syncEvent = new Function('place', `
          const latestFinish = {periodId:'daily',accountId:'fixture'};
          const sessions = {current: () => ({periodId:'daily'})};
          const bridge = {accountId: () => 'fixture'};
          const finishPlace = () => place;
          ${eventHelpers}
          return syncFinishPlace;
        `)(window.eventPlace);
        if (enhance) window.finish.enhanceFinishAnnouncers(document);
      }
      await document.fonts.ready;
      if (!document.fonts.check('48px ForcedSquare')) throw Error('native ForcedSquare did not load');
    }, {renderer, eventHelpers, production: kind === 'production', enhance});
    await finishAnimations(page);
    pages.push(page);
  }
  return pages;
}

async function snapshot(page) {
  return page.evaluate(() => {
    const properties = ['fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontFeatureSettings', 'fontVariantLigatures',
      'letterSpacing', 'lineHeight', 'textTransform', 'textAlign', 'position', 'display', 'overflow', 'opacity', 'transform',
      'transformOrigin', 'transitionProperty', 'transitionDelay', 'transitionDuration', 'transitionTimingFunction',
      'animationName', 'animationDelay', 'animationDuration', 'animationTimingFunction', 'animationFillMode'];
    const root = document.querySelector('.time-announcer-ui');
    return [root, ...root.querySelectorAll('*')].map(node => {
      const style = getComputedStyle(node), r = node.getBoundingClientRect();
      return {tag: node.tagName, className: node.className, text: node.children.length ? null : node.textContent,
        box: {x: r.x, y: r.y, width: r.width, height: r.height},
        style: Object.fromEntries(properties.map(key => [key, style[key]]))};
    });
  });
}
async function parity(native, production, label) {
  assert.deepEqual(await snapshot(production), await snapshot(native), label);
  assert.equal(await production.locator(position).locator('*').count(), 0, `${label}: native plain-text rank, no suffix spans`);
}
async function reveal(pages, previousPosition = 3) {
  for (const page of pages) await page.evaluate(previousPosition => window.resolveRank({newPosition: 3, previousPosition}), previousPosition);
  for (const page of pages) {
    await page.waitForFunction(() => document.querySelector('.current').classList.contains('show-position'));
    await finishAnimations(page);
  }
  if (previousPosition !== 3) {
    for (const page of pages) {
      await page.waitForFunction(() => document.querySelector('.position').textContent === '3rd');
      const ranks = await page.evaluate(() => window.nativeRanks);
      assert.equal(ranks[0], '15th', 'actual native reveal begins at previous place');
      assert.equal(ranks.at(-1), '3rd', 'actual native countdown finishes at new place');
      assert.ok(ranks.some(value => parseInt(value, 10) > 3 && parseInt(value, 10) < 15), 'native countdown paints intermediate ranks');
      await finishAnimations(page);
    }
  }
}
async function rank(page, value, event = false) {
  await page.evaluate(({value, event}) => {
    if (event) {window.eventPlace.rank = value; window.syncEvent();}
    else document.querySelector('.position').textContent = window.nativeFormat(value);
  }, {value, event});
  await settle(page);
}
async function fontAudit(page) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const {root} = await client.send('DOM.getDocument');
    const {nodeId} = await client.send('DOM.querySelector', {nodeId: root.nodeId, selector: position});
    const {fonts} = await client.send('CSS.getPlatformFontsForNode', {nodeId});
    return fonts.map(({familyName, isCustomFont, glyphCount}) => ({familyName, isCustomFont, glyphCount}));
  } finally { await client.detach(); }
}
async function capture(pages, label) {
  const output = process.env.POLYTRACK_FINISH_SCREENSHOTS;
  if (!output) return;
  await fs.mkdir(output, {recursive: true});
  for (let i = 0; i < pages.length; i++) {
    await pages[i].screenshot({path: path.join(output, `${label}-${i ? 'production' : 'native-baseline'}.png`), animations: 'disabled'});
  }
}

const viewports = [[1920,1080,1], [1366,768,1.25], [320,568,1], [390,844,.8], [390,844,1.25], [844,390,1], [667,375,1.25]];
test('actual native PB and event finish retain native typography, geometry, glyphs and reveal timings', {timeout: 45000}, async t => {
  const pages = await openPair(t), [native, production] = pages;
  await parity(native, production, 'pending native rank');
  assert.equal(await production.locator(position).textContent(), '');
  await reveal(pages, 15);
  await parity(native, production, 'actual NT asynchronous 15th-to-3rd reveal and countdown');
  const nativeFonts = await fontAudit(native), productionFonts = await fontAudit(production);
  assert.ok(nativeFonts.length && nativeFonts.every(font => font.isCustomFont), 'native rank uses loaded custom ForcedSquare glyphs');
  t.diagnostic('Native rendered ordinal glyph audit: ' + JSON.stringify(nativeFonts));
  assert.deepEqual(productionFonts, nativeFonts, 'production uses the same rendered font and ligature glyph counts');
  let cases = 0;
  for (const [width, height, scale] of viewports) {
    for (const page of pages) {
      await page.setViewportSize({width, height});
      await page.evaluate(scale => {
        const ui = document.querySelector('#ui');
        document.documentElement.style.setProperty('--ui-scale-factor', String(scale));
        document.documentElement.style.setProperty('--sq-ui-scale', String(scale));
        ui.style.width = `${100 / scale}%`; ui.style.height = `${100 / scale}%`;
        ui.style.transform = `scale(${scale})`;
      }, scale);
    }
    for (const owner of ['PB', 'event']) {
      await production.evaluate(owner => {
        document.body.classList.toggle('sq-event-active', owner === 'event');
        if (owner === 'PB') document.querySelector('.position').removeAttribute('title');
      }, owner);
      for (const value of [1, 3, 11, 22, 113, 1003, 9999999]) {
        await rank(native, value);
        await rank(production, value, owner === 'event');
        await parity(native, production, `${owner} ${value}: ${width}x${height}, UI scale ${scale}`);
        assert.equal(await production.locator(position).getAttribute('aria-label'), owner === 'event'
          ? `Event place ${value} of 64 (provisional)` : `${value}${value === 1 ? 'st' : value === 3 || value === 1003 ? 'rd' : value === 22 ? 'nd' : 'th'} place`);
        cases++;
      }
      if (width === 1920 || width === 844 || (width === 390 && scale === .8)) await capture(pages, `${owner}-${width}x${height}-scale${scale}`);
    }
  }
  t.diagnostic(`${cases} exact native/production comparisons; screenshots ${process.env.POLYTRACK_FINISH_SCREENSHOTS || 'disabled (set POLYTRACK_FINISH_SCREENSHOTS)'}`);
});

test('repeated syncs and late accessibility updates do not rewrite native text or mutate layout', {timeout: 20000}, async t => {
  for (const attachFirst of [false, true]) {
    const pages = await openPair(t, {enhance: attachFirst}), [native, production] = pages;
    await reveal(pages);
    await rank(native, 1003);
    await rank(production, 1003, true);
    await production.evaluate(() => window.finish.enhanceFinishAnnouncers(document));
    await settle(production);
    await parity(native, production, 'event sync before/after enhancer attachment');
    await production.evaluate(() => {
      const root = document.querySelector('.time-announcer-ui');
      window.originalText = root.querySelector('.position').firstChild;
      window.mutations = [];
      window.audit = new MutationObserver(records => window.mutations.push(...records.map(record => ({type:record.type, name:record.attributeName}))));
      window.audit.observe(root, {subtree:true, childList:true, characterData:true, attributes:true});
      for (let i = 0; i < 30; i++) {window.syncEvent(); window.finish.enhanceFinishAnnouncers(document);}
    });
    await settle(production);
    assert.deepEqual(await production.evaluate(() => window.mutations), [], 'unchanged ticks/enhancement perform zero DOM mutations');
    const before = await snapshot(production);
    await production.evaluate(() => {
      window.eventPlace.fieldSize = 65; window.eventPlace.provisional = false; window.syncEvent();
    });
    await settle(production);
    assert.equal(await production.locator(position).getAttribute('aria-label'), 'Event place 1003 of 65');
    assert.equal(await production.locator(position).getAttribute('title'), 'Event place 1003 of 65');
    assert.deepEqual(await snapshot(production), before, 'late title/aria updates leave all layout and typography unchanged');
    assert.equal(await production.evaluate(() => document.querySelector('.position').firstChild === window.originalText), true);
    assert.deepEqual(await production.evaluate(() => window.mutations), [
      {type:'attributes',name:'title'}, {type:'attributes',name:'aria-label'},
    ], 'only accessibility attributes change, without feedback');
    await production.evaluate(() => {
      window.mutations.length = 0;
      const node = document.querySelector('.position');
      node.removeAttribute('title'); node.firstChild.data = window.nativeFormat(23);
    });
    await settle(production);
    await rank(native, 23);
    await parity(native, production, 'late native character-data rank update');
    assert.equal(await production.locator(position).getAttribute('aria-label'), '23rd place');
    assert.equal(await production.evaluate(() => document.querySelector('.position').firstChild === window.originalText), true);
    const settled = await production.evaluate(() => window.mutations.length);
    await settle(production);
    assert.equal(await production.evaluate(() => window.mutations.length), settled, 'observer settles without a mutation loop');
  }
});

test('reduced motion is the intentional native reveal transition exception, not a typography exception', {timeout: 15000}, async t => {
  const pages = await openPair(t, {reducedMotion:'reduce'}), [native, production] = pages;
  const compare = async label => {
    const a = await snapshot(native), b = await snapshot(production);
    for (let i = 0; i < a.length; i++) {
      if (['time', 'position-dash', 'position'].includes(a[i].className)) {
        assert.equal(a[i].style.transitionDuration, '0.5s, 0.5s', 'native transition is retained in the reference');
        assert.equal(b[i].style.transitionDuration, '0s', 'production respects reduced motion');
        assert.equal(b[i].style.transitionProperty, 'none');
        for (const key of ['transitionProperty', 'transitionDuration', 'transitionDelay', 'transitionTimingFunction']) {
          delete a[i].style[key]; delete b[i].style[key];
        }
      }
    }
    assert.deepEqual(b, a, label);
  };
  await compare('reduced-motion pending state otherwise matches native');
  await reveal(pages);
  await compare('reduced-motion revealed state otherwise matches native');
  assert.equal(await production.locator(position).evaluate(node => getComputedStyle(node).opacity), '1');
});
