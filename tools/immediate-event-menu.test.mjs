import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = process.env.EVENT_TEST_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(process.env.EVENT_MENU_PATCH || path.join(repo, 'polytrack_062_patch.js'), 'utf8');
const schedule = await import(pathToFileURL(path.join(repo, 'events/schedule.mjs')));
const weekly = await import(pathToFileURL(path.join(repo, 'events/kodub-weekly.mjs')));
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `production boundary: ${start}`);
  return source.slice(a, b);
}
function extract(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n  }', start);
  assert.ok(end > start, name);
  return source.slice(start, end + 4);
}
const at = Date.UTC(2026, 9, 17, 12);
const current = { trackId: 'c'.repeat(64), name: 'Weekly selection', endTime: new Date(at + 86400000).toISOString() };
const catalogPath = '/v1/events/catalog';
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function catalogFixture({ load, importWeekly } = {}) {
  let now = at, loads = 0, imports = 0, refreshes = 0, refreshed = null;
  const assets = [], timers = [];
  const adapter = { withKodubWeekly: weekly.withKodubWeekly, loadKodubWeekly: () => { loads++; return load?.(loads) ?? Promise.resolve({ current }); } };
  const context = vm.createContext({ URL, Date: { now: () => now, parse: Date.parse }, Promise, Map, AbortSignal,
    eventsModuleUrl: 'https://game.test/events/client.mjs?v=143', kodubAdapter: null, nativeWeeklySelection: null,
    eventCloudCache: new Map(), eventCloudRequests: new Map(), eventCloudRetryAt: new Map(),
    rankedBrokerUrl: () => 'https://worker.test',
    fetch: async url => {
      const target = new URL(url); assets.push(target.href);
      assert.equal(target.origin, 'https://game.test', 'catalog assets remain same-origin');
      return Response.json(target.pathname.endsWith('rotation.json') ? { version: 1, officialIds: ['a'.repeat(64)], allIds: ['a'.repeat(64), 'b'.repeat(64)] } : { periods: [], archives: [] });
    },
    importTestModule: async name => { if (name === 'schedule') return schedule; imports++; return importWeekly ? importWeekly(adapter) : adapter; },
    setTimeout: (callback, delay) => { assert.equal(delay, 0, 'only one deferred enrichment refresh, no polling'); timers.push(callback); return timers.length; },
    db: () => assert.fail('catalog enrichment must not access Firestore'),
    ensureEventUi: () => assert.fail('enrichment must not recursively initialize Event UI'),
    noteFirebaseQuota: error => assert.fail('local catalog must not enter live fallback: '+String(error?.stack||error)),
  });
  context.Headers=Headers;
  vm.runInContext(extract('rankedFetch')+extract('rankedWeeklyFetch')+extract('eventRequestSignal'),context);
  let body = section('  let localEventSchedulePromise=', '  async function eventCloudRead(');
  const weeklyImport = body.match(/import\(new URL\('\.\/kodub-weekly\.mjs\?v=\d+',eventsModuleUrl\)\.href\)/)?.[0];
  assert.ok(weeklyImport, 'production weekly adapter import');
  for (const [anchor, replacement] of [
    ["import(new URL('./schedule.mjs',eventsModuleUrl).href)", "importTestModule('schedule')"],
    [weeklyImport, "importTestModule('weekly')"],
  ]) { assert.ok(body.includes(anchor)); body = body.replaceAll(anchor, replacement); }
  vm.runInContext(body + extract('eventCloudRead'), context);
  context.loadEventCloudRead = () => context.localEventCatalog();
  context.eventUi = { refreshCatalog: async force => { assert.equal(force, true); refreshes++; refreshed = await context.eventCloudRead(catalogPath, 'public', 'catalog'); return refreshed; } };
  return { context, assets, timers, advance: ms => { now += ms; }, counts: () => ({ loads, imports, refreshes }), refreshed: () => refreshed,
    read: () => context.eventCloudRead(catalogPath, 'public', 'catalog'),
    drain: async () => { for (const callback of timers.splice(0)) callback(); await turn(); } };
}

test('daily/weekly catalog returns while Kodub is blocked, then enriches once without recursion', async () => {
  const gate = deferred(), f = catalogFixture({ load: () => gate.promise });
  let ready = false;
  const initial = f.read().then(value => { ready = true; return value; });
  await turn();
  assert.equal(ready, true, 'daily/weekly must not wait for 4-second local plus 8-second broker fallback');
  assert.deepEqual(Array.from((await initial).periods, period => period.kind).sort(), ['daily', 'weekly']);
  await Promise.all(Array.from({ length: 50 }, () => f.context.localEventCatalog()));
  assert.equal(f.counts().loads, 1); assert.equal(f.assets.length, 2);
  f.context.eventCloudRetryAt.set(catalogPath, at + 999999);
  gate.resolve({ current }); await f.context.warmLocalWeeklyCatalog();
  assert.equal(f.timers.length, 1); assert.equal(f.counts().refreshes, 0);
  await f.drain();
  assert.equal(f.counts().refreshes, 1);
  assert.ok(f.refreshed().periods.some(period => period.kind === 'kodub' && period.trackId === current.trackId));
  assert.equal(f.context.eventCloudRetryAt.has(catalogPath), false);
  await Promise.all(Array.from({ length: 50 }, () => f.context.localEventCatalog())); await f.drain();
  assert.deepEqual(f.counts(), { loads: 1, imports: 1, refreshes: 1 });
});

test('slow adapter import is also outside the daily/weekly critical path', async () => {
  const gate = deferred(), f = catalogFixture({ importWeekly: () => gate.promise });
  let ready = false; const initial = f.read().then(value => { ready = true; return value; });
  await turn(); assert.equal(ready, true); assert.equal((await initial).periods.length, 2);
  gate.resolve({ withKodubWeekly: weekly.withKodubWeekly, loadKodubWeekly: async () => ({ current }) });
  await f.context.warmLocalWeeklyCatalog(); await f.drain();
  assert.equal(f.counts().refreshes, 1);
});

test('instant weekly arrival waits for the original catalog request before the forced refresh', async () => {
  const f = catalogFixture();
  const initial = await f.read(); assert.ok(initial.periods.some(period => period.kind === 'daily'));
  await turn(); assert.equal(f.context.eventCloudRequests.size, 0);
  assert.equal(f.timers.length, 1); await f.drain();
  assert.equal(f.counts().refreshes, 1);
  assert.ok(f.refreshed().periods.some(period => period.kind === 'kodub'));
  assert.equal(f.counts().loads, 1);
});

test('weekly failures keep local events usable and retry only after cooldown on an explicit read', async () => {
  const f = catalogFixture({ load: count => count === 1 ? Promise.reject(Error('weekly unavailable')) : Promise.resolve({ current }) });
  assert.equal((await f.read()).periods.length, 2); await turn();
  assert.equal(f.counts().loads, 1); assert.equal(f.timers.length, 0);
  await f.context.localEventCatalog(); assert.equal(f.counts().loads, 1);
  f.advance(60000); await turn(); assert.equal(f.counts().loads, 1, 'no timer retries');
  await f.context.localEventCatalog(); await f.context.warmLocalWeeklyCatalog(); await f.drain();
  assert.equal(f.counts().loads, 2); assert.equal(f.counts().refreshes, 1);
});

test('native menu switches, tab switches and reopen repaint immediately; Extra Tracks stays in visible root', async () => {
  const require = createRequire(path.join(repo, 'tools/verifier/package.json'));
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent('<div id="menus"></div>');
    await page.addScriptTag({ content: `${extract('isElementVisible')}\n${extract('ensureExtraTracksEntryContents')}\n${extract('reconcileKodubWeeklyCard')}\n${extract('ensureEventEntryContents')}` });
    const result = await page.evaluate(async () => {
      let clock = 100000; Date.now = () => clock;
      Object.assign(window, { lastEventUiTickAt: clock, eventQueueChecked: true, eventUiPromise: null, eventModuleRetryAt: 0,
        nativeWeeklySelection: null, kodubAdapter: null, ticks: [], warmLocalWeeklyCatalog: () => {},
        loadExtraTracksCatalog: async () => [{}, {}], openExtraTracks: () => { throw Error('must not launch'); },
        eventUi: { featuredSection: () => null, tick: options => ticks.push({ root: document.querySelector('.track-selection-ui:not([hidden])')?.id, cachedOnly: options?.cachedOnly === true }) } });
      const make = (id, hidden) => {
        const root = document.createElement('div'); root.className = 'track-selection-ui'; root.id = id; root.hidden = hidden;
        root.innerHTML = '<div class="tracks-container no-group-containers"><div class="wrapper"><div class="community-track-versions"><button class="selected">Static</button><button>0.6.3</button></div></div></div>';
        document.getElementById('menus').append(root); return root;
      };
      const hidden = make('hidden-first', true), first = make('first', false), second = make('second', true);
      ensureEventEntryContents(); const firstTick = ticks.length;
      ensureEventEntryContents(); const stable = ticks.length;
      const buttons = first.querySelectorAll('.community-track-versions button'); buttons[0].classList.remove('selected'); buttons[1].classList.add('selected');
      ensureEventEntryContents(); const tabSwitch = ticks.length;
      const wrapper = first.querySelector('.wrapper'); wrapper.replaceWith(wrapper.cloneNode(true));
      ensureEventEntryContents(); const wrapperSwitch = ticks.length;
      first.hidden = true; second.hidden = false; ensureEventEntryContents(); const rootSwitch = ticks.length;
      second.hidden = true; ensureEventEntryContents(); const closed = ticks.length;
      second.hidden = false; ensureEventEntryContents(); const reopened = ticks.length;
      ensureEventEntryContents(); const stableReopen = ticks.length;
      clock += 10001; ensureEventEntryContents();
      return { firstTick, stable, tabSwitch, wrapperSwitch, rootSwitch, closed, reopened, stableReopen, ticks,
        hiddenCards: hidden.querySelectorAll('.sq-extra-tracks-entry').length,
        firstCards: first.querySelectorAll('.sq-extra-tracks-entry').length,
        secondCards: second.querySelectorAll('.sq-extra-tracks-entry').length };
    });
    assert.deepEqual([result.firstTick, result.stable, result.tabSwitch, result.wrapperSwitch, result.rootSwitch, result.closed, result.reopened, result.stableReopen], [1, 1, 2, 3, 4, 4, 5, 5]);
    assert.ok(result.ticks.slice(0, 5).every(tick => tick.cachedOnly), 'menu-only repaint must not flush or fetch live standings');
    assert.equal(result.ticks[5].cachedOnly, false, 'normal background cadence still runs');
    assert.equal(result.hiddenCards, 0); assert.equal(result.firstCards, 1); assert.equal(result.secondCards, 1);
  } finally { await browser.close(); }
});
