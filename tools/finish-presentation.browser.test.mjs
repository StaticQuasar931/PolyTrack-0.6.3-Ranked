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
// Read only the native CSS literal, never execute the game or its network bootstrap.
const nativeLiteral = bundle.match(/s\.push\(\[e\.id,('(?:\\.|[^'\\])*\.time-announcer-ui(?:\\.|[^'\\])*'),""\]\)/);
assert.ok(nativeLiteral, 'native announcer CSS remains discoverable');
const nativeCSS = vm.runInNewContext(nativeLiteral[1], Object.create(null), {timeout: 1000});
const positionSelector = '.time-announcer-ui > .current > .position';
const fixture = `<!doctype html><html><head><meta charset="utf-8">
<style>
@font-face{font-family:ForcedSquare;src:url('/forced_square.woff2') format('woff2')}
html,body{margin:0;width:100%;height:100%;background:#111d40}
*{font-family:ForcedSquare,Arial,sans-serif;font-style:italic;line-height:1}
:root{--surface-color:#28346a;--surface-secondary-color:#19264b;--text-color:#fff}
#ui{position:absolute;inset:0;pointer-events:none;transform-origin:0 0}
.hidden{display:none}
${nativeCSS}
</style><link rel="stylesheet" href="/responsive-ui.css"></head><body><div id="ui">
<div class="time-announcer-ui">
  <div class="record personal-best">NEW PERSONAL BEST</div>
  <div class="track-name">Rolling Hills Racer</div>
  <div class="current"><div class="time">00:24.531</div><div class="position-dash">-</div><div class="position"></div></div>
  <div class="difference"><p>-00:00.123</p></div>
  <div class="difference red"><p class="title">Previous racer</p><p>+00:00.456</p></div>
</div></div></body></html>`;

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

async function openFixture(t, {width = 1280, height = 800, reducedMotion = 'no-preference'} = {}) {
  const context = await browser.newContext({viewport: {width, height}, reducedMotion, serviceWorkers: 'block'});
  const unexpected = [], errors = [];
  const allowed = new Set(['/responsive-ui.css', '/tools/finish-presentation.mjs', '/forced_square.woff2']);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === server.url && url.pathname === '/finish-fixture.html') {
      return route.fulfill({contentType: 'text/html', body: fixture});
    }
    if (url.origin === server.url && allowed.has(url.pathname) && route.request().method() === 'GET') return route.continue();
    unexpected.push(url.href);
    return route.abort();
  });
  t.after(async () => {
    await context.close();
    assert.deepEqual(unexpected, [], 'fixture must not request Firebase, the game, or external resources');
    assert.deepEqual(errors, [], 'no browser runtime errors');
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url + '/finish-fixture.html');
  await page.evaluate(async () => {
    const NativeObserver = window.MutationObserver;
    window.observerStats = {created: 0, delivered: 0, runaway: false};
    window.MutationObserver = class extends NativeObserver {
      constructor(callback) {
        let deliveries = 0;
        super((records, observer) => {
          if (!observer.finishTestTracked) return callback(records, observer);
          window.observerStats.delivered++;
          // Fail instead of hanging the renderer if enhancement recursively mutates itself.
          if (++deliveries > 200) {
            window.observerStats.runaway = true;
            observer.disconnect();
            return;
          }
          callback(records, observer);
        });
      }
      observe(node, options) {
        if (!this.finishTestTracked && node.matches?.('.time-announcer-ui > .current > .position')) {
          this.finishTestTracked = true;
          window.observerStats.created++;
        }
        return super.observe(node, options);
      }
    };
    window.finish = await import('/tools/finish-presentation.mjs');
    await document.fonts.ready;
    if (!document.fonts.check('24px ForcedSquare')) throw new Error('native font did not load');
  });
  return page;
}

async function assertRank(page, number, suffix, selector = positionSelector) {
  const actual = await page.locator(selector).evaluate(node => ({
    label: node.getAttribute('aria-label'), text: node.textContent,
    children: [...node.childNodes].map(child => ({tag: child.nodeName, className: child.className, text: child.textContent})),
  }));
  assert.deepEqual(actual, {
    label: `${number}${suffix} place`, text: `${number}${suffix}`,
    children: [
      {tag: 'SPAN', className: 'sq-finish-number', text: String(number)},
      {tag: 'SUP', className: 'sq-finish-ordinal', text: suffix},
    ],
  });
}

async function setRank(page, text) {
  await page.locator(positionSelector).evaluate((node, value) => { node.textContent = value; }, text);
  await settle(page);
}

test('native async rank updates replace text with accessible ordinals without changing siblings', {timeout: 30000}, async t => {
  const page = await openFixture(t);
  const siblingSelector = '.record, .track-name, .time, .position-dash, .difference';
  const before = await page.locator(siblingSelector).evaluateAll(nodes => nodes.map(node => node.outerHTML));
  await page.evaluate(() => window.finish.enhanceFinishAnnouncers(document));
  assert.equal(await page.locator(positionSelector).innerHTML(), '', 'initial pending rank stays empty');
  for (const [text, number, suffix] of [
    ['113th', 113, 'th'], ['112th', 112, 'th'], ['111th', 111, 'th'], ['103rd', 103, 'rd'],
    ['23rd', 23, 'rd'], ['22nd', 22, 'nd'], ['21st', 21, 'st'], ['13th', 13, 'th'],
    ['12th', 12, 'th'], ['11th', 11, 'th'], ['4th', 4, 'th'], ['3rd', 3, 'rd'],
    ['2nd', 2, 'nd'], ['1st', 1, 'st'], ['1st', 1, 'st'], ['1003', 1003, 'rd'],
    [' 1\u202f003 X ', 1003, 'rd'], ['22\u00d7', 22, 'nd'], ['23RD', 23, 'rd'],
  ]) {
    await setRank(page, text);
    await assertRank(page, number, suffix);
  }
  assert.deepEqual(await page.locator(siblingSelector).evaluateAll(nodes => nodes.map(node => node.outerHTML)), before);
  assert.equal(await page.evaluate(() => window.observerStats.created), 1);
  assert.equal(await page.evaluate(() => window.observerStats.runaway), false);
});

test('enhancement is idempotent and observers settle after child and character-data mutations', {timeout: 30000}, async t => {
  const page = await openFixture(t);
  await setRank(page, '21st');
  await page.evaluate(() => {
    window.finish.enhanceFinishAnnouncers(document);
    window.originalChildren = [...document.querySelector('.position').childNodes];
    for (let i = 0; i < 25; i++) window.finish.enhanceFinishAnnouncers(document);
  });
  await settle(page);
  assert.deepEqual(await page.evaluate(() => ({...window.observerStats})), {created: 1, delivered: 0, runaway: false});
  assert.equal(await page.locator(positionSelector).evaluate(node => [...node.childNodes].every((child, i) => child === window.originalChildren[i])), true);
  await page.locator('.sq-finish-number').evaluate(node => { node.firstChild.data = '31'; });
  await settle(page);
  await assertRank(page, 31, 'st');
  await page.locator('.sq-finish-number').evaluate(node => { node.firstChild.data = '32'; });
  await settle(page);
  await assertRank(page, 32, 'nd');
  await page.locator(positionSelector).evaluate(node => node.replaceChildren(document.createTextNode('11th')));
  await settle(page);
  await assertRank(page, 11, 'th');
  const settled = await page.evaluate(() => ({...window.observerStats}));
  assert.equal(settled.created, 1);
  assert.equal(settled.runaway, false);
  assert.ok(settled.delivered >= 3 && settled.delivered <= 6, 'bounded native observer delivery');
  await settle(page);
  assert.deepEqual(await page.evaluate(() => ({...window.observerStats})), settled, 'no continuing observer feedback loop');
});

test('event finish suffix and contextual title survive enhancement and repeated native sync calls', {timeout: 30000}, async t => {
  const source = await fs.readFile(new URL('../events/client.mjs', import.meta.url), 'utf8');
  const syncStart = source.indexOf('  function syncFinishPlace(){');
  const syncEnd = source.indexOf('  function tick(', syncStart);
  const ordinalStart = source.indexOf('export function eventOrdinal(');
  const ordinalEnd = source.indexOf('export function eventTrackName(', ordinalStart);
  assert.ok(syncStart >= 0 && syncEnd > syncStart && ordinalStart >= 0 && ordinalEnd > ordinalStart,
    'native event finish helpers remain discoverable');
  const helpers = source.slice(ordinalStart, ordinalEnd).replace(/^export /, '') + source.slice(syncStart, syncEnd);

  for (const attachFirst of [false, true]) {
    const page = await openFixture(t);
    const label = attachFirst ? 'event arrives after observer attaches' : 'event exists before enhancement';
    await page.evaluate(({helpers, attachFirst}) => {
      window.eventPlace = {rank: 21, fieldSize: 64, provisional: true};
      // Run only the real DOM synchronizer with local session data, never the event bootstrap.
      window.syncEventFinish = new Function('place', `
        const latestFinish = {periodId: 'daily', accountId: 'fixture'};
        const sessions = {current: () => ({periodId: 'daily'})};
        const bridge = {accountId: () => 'fixture'};
        const finishPlace = () => place;
        ${helpers}
        return syncFinishPlace;
      `)(window.eventPlace);
      const node = document.querySelector('.time-announcer-ui > .current > .position');
      const replaceChildren = node.replaceChildren;
      window.eventRewrites = 0;
      node.replaceChildren = function (...children) {
        window.eventRewrites++;
        return replaceChildren.apply(this, children);
      };
      if (attachFirst) window.finish.enhanceFinishAnnouncers(document);
      window.syncEventFinish();
      window.eventChildren = [...node.childNodes];
      window.eventMarkup = node.innerHTML;
      window.finish.enhanceFinishAnnouncers(document);
    }, {helpers, attachFirst});
    await settle(page);

    const assertEvent = async (rank, suffix, title, rewrites) => {
      const actual = await page.locator(positionSelector).evaluate(node => ({
        text: node.textContent, title: node.title, aria: node.getAttribute('aria-label'),
        children: [...node.childNodes].map(child => ({
          tag: child.nodeName, className: child.nodeType === Node.ELEMENT_NODE ? child.className : null,
          text: child.textContent,
        })),
        sameNodes: node.childNodes.length === window.eventChildren.length
          && [...node.childNodes].every((child, index) => child === window.eventChildren[index]),
        sameMarkup: node.innerHTML === window.eventMarkup,
        rewrites: window.eventRewrites, observers: window.observerStats.created,
        runaway: window.observerStats.runaway,
      }));
      assert.deepEqual(actual, {
        text: `${rank}${suffix}`, title, aria: title || `${rank}${suffix} place`,
        children: [
          {tag: '#text', className: null, text: String(rank)},
          {tag: 'SPAN', className: 'sq-event-ordinal-suffix', text: suffix},
        ],
        sameNodes: true, sameMarkup: true, rewrites, observers: 1, runaway: false,
      }, label);
    };
    await assertEvent(21, 'st', 'Event place 21 of 64 (provisional)', 1);
    const settled = await page.evaluate(() => ({...window.observerStats}));
    for (let tick = 0; tick < 25; tick++) {
      await page.evaluate(() => {
        window.syncEventFinish();
        window.finish.enhanceFinishAnnouncers(document);
      });
      await settle(page);
    }
    await assertEvent(21, 'st', 'Event place 21 of 64 (provisional)', 1);
    assert.deepEqual(await page.evaluate(() => ({...window.observerStats})), settled,
      label + ': repeated event ticks and enhancement calls cause no mutation feedback');

    await page.evaluate(() => {
      Object.assign(window.eventPlace, {rank: 22, fieldSize: 65, provisional: false});
      window.syncEventFinish();
      const node = document.querySelector('.time-announcer-ui > .current > .position');
      window.eventChildren = [...node.childNodes];
      window.eventMarkup = node.innerHTML;
    });
    await settle(page);
    await assertEvent(22, 'nd', 'Event place 22 of 65', 2);

    await page.locator(positionSelector).evaluate(node => {
      node.removeAttribute('title');
      node.firstChild.data = '23';
      node.lastChild.firstChild.data = 'rd';
      window.eventMarkup = node.innerHTML;
    });
    await settle(page);
    await assertEvent(23, 'rd', '', 2);
  }
});

test('invalid ranks and lookalike nodes outside the native direct-child structure remain untouched', {timeout: 30000}, async t => {
  const page = await openFixture(t);
  const values = ['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', 'DNF', '3rd place', '<b>1st</b>'];
  await page.evaluate(values => {
    const current = document.querySelector('.current');
    current.querySelector('.position').remove();
    for (const text of values) {
      const node = document.createElement('div');
      node.className = 'position'; node.textContent = text; current.append(node);
    }
    const other = document.createElement('section');
    other.id = 'unrelated';
    other.innerHTML = '<div class="position">2nd</div><div class="current"><div class="position">3rd</div></div>';
    document.body.append(other);
    const nested = document.createElement('section');
    nested.innerHTML = '<div class="position">4th</div>';
    current.append(nested);
    window.finish.enhanceFinishAnnouncers(document);
  }, values);
  await settle(page);
  assert.deepEqual(await page.locator(positionSelector).allTextContents(), values);
  assert.equal(await page.locator('[aria-label], .sq-finish-number, .sq-finish-ordinal').count(), 0);
  assert.equal(await page.locator('#unrelated').textContent(), '2nd3rd');
  assert.equal(await page.locator('.current > section').textContent(), '4th');
  await page.locator(positionSelector).first().evaluate(node => { node.textContent = '2nd'; });
  await settle(page);
  await assertRank(page, 2, 'nd', positionSelector + '[aria-label]');
});

test('rescanning discovers a replacement announcer while reusing observers on reattached nodes', {timeout: 30000}, async t => {
  const page = await openFixture(t);
  await setRank(page, '3rd');
  await page.evaluate(() => {
    window.finish.enhanceFinishAnnouncers(document);
    const original = document.querySelector('.time-announcer-ui');
    original.remove(); document.querySelector('#ui').append(original);
    window.finish.enhanceFinishAnnouncers(document);
    const replacement = original.cloneNode(true);
    replacement.querySelector('.position').textContent = '12th';
    original.replaceWith(replacement);
    window.finish.enhanceFinishAnnouncers(document);
    window.finish.enhanceFinishAnnouncers(document);
  });
  await settle(page);
  await assertRank(page, 12, 'th');
  await setRank(page, '2nd');
  await assertRank(page, 2, 'nd');
  assert.equal(await page.evaluate(() => window.observerStats.created), 2);
  assert.equal(await page.evaluate(() => window.observerStats.runaway), false);
});

const viewports = [
  [320, 568], [375, 667], [390, 844], [440, 956], [667, 375], [844, 390],
  [600, 960], [768, 1024], [820, 1180], [1024, 768], [1100, 500], [1100, 501],
  [1366, 600], [1920, 1080], [2560, 1440], [3440, 1440], [5120, 1440],
];
const inside = (inner, outer) => inner.x >= outer.x - 1 && inner.right <= outer.right + 1
  && inner.y >= outer.y - 1 && inner.bottom <= outer.bottom + 1;

async function geometry(page) {
  return page.evaluate(() => {
    const rect = node => {
      const r = node.getBoundingClientRect();
      return {x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height};
    };
    const sample = selector => {
      const node = document.querySelector(selector), style = getComputedStyle(node);
      return {...rect(node), font: parseFloat(style.fontSize), opacity: style.opacity,
        verticalAlign: style.verticalAlign, transition: style.transitionDuration};
    };
    return {
      announcer: sample('.time-announcer-ui'), current: sample('.current'),
      time: sample('.time'), dash: sample('.position-dash'), position: sample('.position'),
      number: sample('.sq-finish-number'), suffix: sample('.sq-finish-ordinal'),
      track: sample('.track-name'), record: sample('.record'),
      scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
    };
  });
}

test('native-shaped finish layout keeps time and superscript ranks readable across responsive widths', {timeout: 90000}, async t => {
  const page = await openFixture(t);
  await setRank(page, '1003rd');
  await page.evaluate(async () => {
    window.finish.enhanceFinishAnnouncers(document);
    document.querySelector('.current').classList.add('show-position');
    await Promise.all(document.getAnimations().map(animation => animation.finished));
  });
  const output = process.env.POLYTRACK_FINISH_SCREENSHOTS;
  if (output) await fs.mkdir(output, {recursive: true});
  for (const [width, height] of viewports) {
    await page.setViewportSize({width, height});
    await settle(page);
    for (const [rank, suffix] of [[1, 'st'], [11, 'th'], [23, 'rd'], [1003, 'rd'], [9999999, 'th']]) {
      await setRank(page, String(rank));
      await assertRank(page, rank, suffix);
      const g = await geometry(page), label = `${width}x${height}, rank ${rank}`;
      const viewport = {x: 0, y: 0, right: width, bottom: height};
      assert.ok(g.current.width > 0 && g.current.height > 0, label + ': current row is visible');
      for (const key of ['time', 'dash', 'position', 'number', 'suffix', 'track', 'record']) {
        assert.ok(g[key].width > 0 && g[key].height > 0, label + ': visible ' + key);
        assert.ok(inside(g[key], viewport) && inside(g[key], g.announcer), label + ': unclipped ' + key + ' ' + JSON.stringify(g[key]));
      }
      assert.equal(g.position.opacity, '1', label + ': native reveal completes');
      assert.ok(g.time.right < g.dash.x && g.dash.right < g.position.x, label + ': time, dash, rank do not overlap');
      assert.ok(g.number.right < g.suffix.x, label + ': separate ordinal glyphs');
      assert.ok(g.suffix.font < g.number.font && g.suffix.y < g.number.y, label + ': raised smaller suffix');
      assert.equal(g.suffix.verticalAlign, 'super');
      assert.ok(g.scroll <= g.client, label + ': no horizontal overflow');
      assert.ok(Math.abs(g.current.font - Math.max(24, Math.min(48, width * 0.032))) < 0.02, label + ': responsive font clamp');
      assert.ok(Math.abs(g.announcer.y - height * (height <= 500 ? 0.2 : 0.35)) < 1, label + ': short-height positioning');
    }
    if (output) await page.screenshot({path: path.join(output, `finish-${width}x${height}.png`)});
  }
  t.diagnostic(`${viewports.length} viewports, five ranks each; screenshots ${output || 'disabled (set POLYTRACK_FINISH_SCREENSHOTS)'}`);
});

test('native reveal transitions remain enabled normally and disabled for reduced motion', {timeout: 30000}, async t => {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const page = await openFixture(t, {width: 390, height: 844, reducedMotion});
    await setRank(page, '2nd');
    await page.evaluate(async () => {
      window.finish.enhanceFinishAnnouncers(document);
      await Promise.all(document.getAnimations().map(animation => animation.finished));
    });
    const before = await geometry(page);
    assert.equal(before.position.opacity, '0', 'rank stays hidden before native reveal');
    for (const key of ['time', 'dash', 'position']) {
      assert.equal(before[key].transition, reducedMotion === 'reduce' ? '0s' : '0.5s, 0.5s');
    }
    await page.evaluate(async () => {
      document.querySelector('.current').classList.add('show-position');
      await Promise.all(document.getAnimations().map(animation => animation.finished));
    });
    await settle(page);
    const after = await geometry(page);
    assert.equal(after.position.opacity, '1');
    assert.ok(after.time.right < after.dash.x && after.dash.right < after.position.x);
    await assertRank(page, 2, 'nd');
  }
});
