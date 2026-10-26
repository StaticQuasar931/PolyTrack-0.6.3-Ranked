import { pathToFileURL } from 'node:url';
const repositoryRoot = process.env.PRACTICE_UI_REPO ? pathToFileURL(process.env.PRACTICE_UI_REPO.replace(/\\/g, '/') + '/') : new URL('../', import.meta.url);
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { renderPracticeProfile, installPracticeProfileControls } from './practice-profile.mjs';
import { practiceProfileChoiceKey, readPracticeProfileChoice, writePracticeProfileChoice } from './practice-profile.mjs';

test('sort preference keys isolate profiles and never use an anonymous shared key', () => {
  assert.equal(practiceProfileChoiceKey(''), null);
  assert.equal(practiceProfileChoiceKey(null), null);
  assert.notEqual(practiceProfileChoiceKey('profile/a'), practiceProfileChoiceKey('profile%2Fa'));
  const data = new Map(), storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  writePracticeProfileChoice('a', { sort: 'name', direction: 'asc', search: 'private' }, storage);
  assert.deepEqual(readPracticeProfileChoice('a', storage), { sort: 'name', direction: 'asc' });
  assert.deepEqual(readPracticeProfileChoice('b', storage), { sort: 'active', direction: 'desc' });
  assert.deepEqual(JSON.parse(data.get(practiceProfileChoiceKey('a'))), { sort: 'name', direction: 'asc' });
  writePracticeProfileChoice('', { sort: 'recent', direction: 'asc' }, storage);
  assert.equal(data.size, 1);
});

test('invalid, corrupt, missing and throwing storage safely use Active time', () => {
  for (const value of [null, '{', '{}', '[]', 'null', '{"sort":"missing","direction":"asc"}', '{"sort":"active","direction":"sideways"}']) {
    assert.deepEqual(readPracticeProfileChoice('a', { getItem: () => value }), { sort: 'active', direction: 'desc' });
  }
  const broken = { getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); } };
  assert.deepEqual(readPracticeProfileChoice('a', broken), { sort: 'active', direction: 'desc' });
  assert.doesNotThrow(() => writePracticeProfileChoice('a', { sort: 'recent', direction: 'asc' }, broken));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('disabled'); } });
    assert.deepEqual(readPracticeProfileChoice('a'), { sort: 'active', direction: 'desc' });
    assert.doesNotThrow(() => writePracticeProfileChoice('a', { sort: 'name', direction: 'asc' }));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

const row = (overrides = {}) => ({
  trackId: 'track-a', trackName: 'Summer Run', activeMs: 125000, attempts: 7,
  finishes: 3, pbs: 1, bestMs: 47250, trackedBestMs: 47250, sincePbMs: 61000,
  lastPlayedAt: Date.UTC(2026, 9, 17), lastPbAt: Date.UTC(2026, 9, 17), ...overrides
});

test('renders compact summary and per-track useful data with trusted preview markup', () => {
  const html = renderPracticeProfile({ rows: [row()], trackPreview: id => `<img src="/thumb/${id}.png" alt="">` });
  assert.match(html, /ACTIVE RACE TIME/);
  assert.match(html, /2m/);
  assert.match(html, /TRACKS DRIVEN/);
  assert.match(html, /7 attempts/);
  assert.match(html, /3 recorded finishes/);
  assert.match(html, /1 recorded best/);
  assert.match(html, /47\.25s/);
  assert.match(html, /1m 1s since last recorded best/);
  assert.match(html, /Last played<\/small><strong>[^<]*2026/);
  assert.match(html, /Active race time<\/small><strong>2m 5s/);
  assert.match(html, /<img src="\/thumb\/track-a\.png" alt="">/);
  assert.match(html, /<li class="pp-track" data-pp-track-id="track-a"/);
  assert.doesNotMatch(html, /<li class="pp-track" data-track-id=/);
  assert.equal((html.match(/<button[^>]*data-track-id="track-a"/g) || []).length, 2);
  assert.doesNotMatch(html, />PT</);
});

test('invalid epoch-scale activity timestamps are reported as unavailable', () => {
  const html = renderPracticeProfile({ rows: [row({ lastPlayedAt: 2 })] });
  assert.match(html, /Last played<\/small><strong>Date not recorded/);
  assert.doesNotMatch(html, /Dec 31, 1969|Jan 1, 1970/);
});

test('escapes names and uses fallback art if callback fails or returns no markup', () => {
  const html = renderPracticeProfile({ rows: [row({ trackName: '<img src=x onerror=1>' })], trackPreview: () => '<script>bad()</script>' });
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
  assert.match(html, /<script>bad\(\)<\/script>/);
  const fallback = renderPracticeProfile({ rows: [row()], trackPreview: () => '' });
  assert.match(fallback, /pp-preview-unknown/);
});

test('does not render recent finishes section when there are none', () => {
  const html = renderPracticeProfile({ rows: [row()] });
  assert.doesNotMatch(html, /pp-finishes/);
  assert.doesNotMatch(html, /Recent finishes/);
});

test('shows recent finishes only when known and keeps optional timing note escaped', () => {
  const html = renderPracticeProfile({ rows: [row({ recentFinishes: [{ at: Date.UTC(2026, 9, 18), timeMs: 48123, practiceMs: 92000, timingNote: true }] })] });
  assert.match(html, /Recent finishes/);
  assert.match(html, /48\.12s/);
  assert.match(html, /1m 32s practice/);
  assert.match(html, /clocks differed/);
});

test('renders the full searchable track history and excludes non-observations', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row({ trackId: `t${i}`, trackName: `Track ${i}`, lastPlayedAt: i + 1 }));
  rows.push({ trackId: 'empty', trackName: 'Empty', activeMs: 0, attempts: 0, finishes: 0 });
  const html = renderPracticeProfile({ rows });
  assert.equal((html.match(/class="pp-track"/g) || []).length, 12);
  assert.doesNotMatch(html, /Empty/);
});

test('separates known local/cloud PB evidence from tracked finish history and never invents rank', () => {
  const html = renderPracticeProfile({ rows: [row()], results: [
    { trackId: 'track-a', timeMs: 46000, local: true },
    { trackId: 'track-a', timeMs: 45500, source: 'cloud', rank: 4, fieldSize: 20 }
  ] });
  assert.match(html, /Tracked history/);
  assert.match(html, /Submitted PB/);
  assert.match(html, /45\.50s/);
  assert.match(html, /Rank 4 of 20/);
  const noProof = renderPracticeProfile({ rows: [row()] });
  assert.doesNotMatch(noProof, /Known PB evidence|Rank /);
});

test('keeps coverage explanation accessible in a closed disclosure, not a persistent warning', () => {
  const view = fraction => renderPracticeProfile({ rows: [row()], coverage: { coverageFraction: fraction } });
  assert.match(view(0.05), /<details class="pp-coverage-details"><summary>About history coverage<\/summary>/);
  assert.match(view(0.05), /5% visible-time coverage\. Less than 10%/);
  assert.match(view(0.3), /30% visible-time coverage\. Partial evidence/);
  assert.match(view(0.85), /85% visible-time coverage\. Good evidence/);
  assert.doesNotMatch(view(0.05), /Sparse evidence|limited history|pp-coverage-low/);
  assert.doesNotMatch(view(NaN), /pp-coverage-details/);
});

test('shows PB age only from a PB timestamp, never from snapshot capture age', () => {
  const recent = renderPracticeProfile({ rows: [row()], results: [
    { trackId: 'track-a', timeMs: 46000, source: 'snapshot', snapshotCapturedAt: Date.now() - 20 * 86400000,
      pbAt: Date.now() - 2 * 86400000 }
  ] });
  assert.match(recent, /PB recorded 2d ago/);
  const captureOnly = renderPracticeProfile({ rows: [row()], results: [
    { trackId: 'track-a', timeMs: 46000, source: 'snapshot', snapshotCapturedAt: Date.now() - 20 * 86400000 }
  ] });
  assert.doesNotMatch(captureOnly, /PB recorded/);
});

test('provides accessible search, sorting, view controls, and event handler export', () => {
  const html = renderPracticeProfile({ rows: [row()] });
  assert.match(html, /<label>Search tracks/);
  assert.match(html, /class="pp-direction" data-pp-direction="desc" aria-label="Sort descending"/);
  assert.doesNotMatch(html, /<label>Direction/);
  assert.match(html, /data-pp-view="list"/);
  assert.equal(typeof installPracticeProfileControls, 'function');
  assert.equal(installPracticeProfileControls(null) instanceof Function, true);
});

test('renders a single compact instruction for no meaningful observations', () => {
  const html = renderPracticeProfile({ rows: [row({ activeMs: 0, attempts: 0, finishes: 0, bestMs: 0 })] });
  assert.match(html, /Drive a track to start building your practice history/);
  assert.doesNotMatch(html, /pp-tracks/);
});

test('keeps clear-history action available in accessible native details', () => {
  const html = renderPracticeProfile();
  assert.match(html, /<details class="pp-manage">/);
  assert.match(html, /<button type="button" data-clear-practice-history>/);
  assert.match(html, /Manage local history/);
});

test('baseline PB is never labelled an observed finish and invalid ranks are omitted',()=>{const html=renderPracticeProfile({rows:[row({bestMs:12345,trackedBestMs:0})],results:[{trackId:'track-a',timeMs:12345,local:true,rank:4,fieldSize:2}]});assert.doesNotMatch(html,/Tracked best|best 12.35s|Rank 4/);assert.match(html,/Known PB evidence/);});

test('sparse cards keep evidence readable without inventing session measurements',()=>{
 const html=renderPracticeProfile({rows:[row({finishes:0,trackedBestMs:0,observationVersion:1,pausedMs:0,focusedMs:0})],results:[{trackId:'track-a',timeMs:47000,source:'snapshot'}]});
 assert.match(html,/Snapshot PB/);assert.doesNotMatch(html,/Placement not available/);assert.match(html,/7 attempts/);
 assert.doesNotMatch(html,/No finish recorded yet|pp-evidence-tracked|pp-evidence-unavailable/);
 assert.doesNotMatch(html,/pp-session-details|>Paused<|>Stationary</);
});

test('attempt-only tracks omit empty evidence panels and retain meaningful time and counts', () => {
  const rows = Array.from({ length: 15 }, (_, i) => row({
    trackId: 'attempt-' + i, finishes: 0, trackedBestMs: 0, bestMs: 0, pbs: 0, sincePbMs: 0
  }));
  const before = structuredClone(rows);
  const html = renderPracticeProfile({ rows });
  assert.equal((html.match(/7 attempts/g) || []).length, 15);
  assert.equal((html.match(/Active race time<\/small><strong>2m 5s/g) || []).length, 15);
  assert.doesNotMatch(html, /pp-results|No finish|Saved PB|Not available|recommend/i);
  assert.doesNotMatch(html, /value="improvement"/);
  assert.match(renderPracticeProfile({ rows: [row({ improvedMs: 100 })] }), /value="improvement"/);
  assert.deepEqual(rows, before);
});

test('offers only observed finish and hunt sorts and marks their selected metrics', () => {
  const html = renderPracticeProfile({ rows: [row({ finishes: 2, longestHuntMs: 90000 })] });
  assert.match(html, /value="finishes">Finishes/);
  assert.match(html, /value="longest-hunt">Longest hunt/);
  assert.match(html, /data-finishes="2"/);
  assert.match(html, /data-longest-hunt-ms="90000"/);
  assert.match(html, /pp-sort-finishes/);
  assert.match(html, /pp-sort-longest-hunt/);
  const noMeasurements = renderPracticeProfile({ rows: [row({ finishes: 0, longestHuntMs: 0 })] });
  assert.doesNotMatch(noMeasurements, /value="finishes"|value="longest-hunt"/);
});

test('measured active time switches to one-decimal days at 100 hours', () => {
  const hours = renderPracticeProfile({ rows: [row({ activeMs: (99 * 60 + 59) * 60000 })] });
  const days = renderPracticeProfile({ rows: [row({ activeMs: 100 * 3600000 })] });
  assert.match(hours, /Active race time<\/small><strong>99h 59m 0s/);
  assert.match(days, /Active race time<\/small><strong>4\.2d/);
  assert.doesNotMatch(days, /100h/);
});

test('finish count without a tracked best does not invent a best time', () => {
  const html = renderPracticeProfile({ rows: [row({ trackedBestMs: 0 })] });
  assert.match(html, /3 recorded finishes/);
  assert.doesNotMatch(html, /<b>best |No finish recorded|pp-evidence-unavailable/);
});

const require = createRequire(new URL('tools/verifier/package.json', repositoryRoot));
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {}

test('practice identity and controls survive injected popup CSS in narrow grid and list layouts', { skip: !chromium }, async () => {
  const module = await fs.readFile(new URL('./practice-profile.mjs', import.meta.url), 'utf8');
  const activeTimeModule = await fs.readFile(new URL('tools/active-time.mjs', repositoryRoot), 'utf8');
  const historyModule = await fs.readFile(new URL('tools/practice-history.mjs', repositoryRoot), 'utf8');
  const patch = await fs.readFile(new URL('polytrack_062_patch.js', repositoryRoot), 'utf8');
  const injectedCss = [...patch.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)]
    .map(match => JSON.parse(match[1])).join('\n');
  assert.ok(injectedCss.includes('#overallProfilePopup') && injectedCss.includes('!important'));
  const font = (await fs.readFile(new URL('forced_square.woff2', repositoryRoot))).toString('base64');
  const css = await fs.readFile(new URL('home-ui.css', repositoryRoot), 'utf8') + '\n' +
    await fs.readFile(new URL('../practice-responsive.css', import.meta.url), 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Fulfil every request locally: this regression never contacts the game or Firebase.
    await page.route('**/*', route => route.fulfill({
      contentType: /\/(practice|active-time|practice-history)\.mjs$/.test(route.request().url()) ? 'text/javascript' : 'text/html',
      body: route.request().url().endsWith('practice-history.mjs') ? historyModule :
        route.request().url().endsWith('active-time.mjs') ? activeTimeModule :
        route.request().url().endsWith('practice.mjs') ? module :
        '<!doctype html><html lang="en"><title>Practice regression</title>' +
        '<main id="overallProfilePopup" style="display:flex"><article class="overall-profile-card">' +
        '<div id="overallProfileContent"></div></article></main></html>'
    }));
    await page.goto('http://localhost/');
    await page.addStyleTag({ content: '@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,' + font + ')}' +
      css + '\nbody{margin:0}' });
    // The real patch appends styles at runtime, after the linked stylesheets.
    await page.addStyleTag({ content: injectedCss });
    await page.evaluate(async () => {
      const { renderPracticeProfile, installPracticeProfileControls } = await import('/practice.mjs');
      document.querySelector('#overallProfileContent').innerHTML =
        '<section class="profile-guide"><div class="profile-guide-body"><button class="profile-guide-track">Route planner</button></div></section>' +
        renderPracticeProfile({
        coverage: { coverageFraction: .02 },
        rows: [
          { trackId: 'a', trackName: 'Alpha with a very long track name', activeMs: 1000, attempts: 3, finishes: 2, longestHuntMs: 6000, lastPlayedAt: Date.now()-3000, improvementMs: 50 },
          { trackId: 'b', trackName: 'Beta', activeMs: 9000, attempts: 1, longestHuntMs: 3000, lastPlayedAt: Date.now()-2000 },
          { trackId: 'c', trackName: 'C'.repeat(100), activeMs: 9000, attempts: 2, finishes: 5, longestHuntMs: 9000, lastPlayedAt: Date.now()-1000, trackedBestMs: 10200 }
        ],
        results: [{ trackId: 'a', source: 'snapshot', timeMs: 9800, snapshotCapturedAt: Date.now() }]
      });
      const root = document.querySelector('.polytrack-practice-profile');
      root.open = true;
      window.disposePractice = installPracticeProfileControls(root);
      await document.fonts.ready;
    });
    const ids = () => page.locator('.pp-track:not([hidden])').evaluateAll(items => items.map(item => item.dataset.ppTrackId));
    assert.deepEqual(await ids(), ['b', 'c', 'a']);
    const direction = page.locator('[data-pp-direction]');
    for (const [key, descending, ascending] of [
      ['recent', ['c', 'b', 'a'], ['a', 'b', 'c']],
      ['active', ['b', 'c', 'a'], ['a', 'b', 'c']],
      ['attempts', ['a', 'c', 'b'], ['b', 'c', 'a']],
      ['finishes', ['c', 'a', 'b'], ['b', 'a', 'c']],
      ['longest-hunt', ['c', 'a', 'b'], ['b', 'a', 'c']],
      ['improvement', ['a', 'b', 'c'], ['b', 'c', 'a']],
      ['name', ['c', 'b', 'a'], ['a', 'b', 'c']]
    ]) {
      await page.locator('[data-pp-sort]').selectOption(key);
      if ((await direction.getAttribute('data-pp-direction')) !== 'desc') await direction.click();
      assert.deepEqual(await ids(), descending);
      await direction.click();
      assert.match(await direction.getAttribute('aria-label'), /ascending\. Switch to descending$/);
      assert.deepEqual(await ids(), ascending);
    }
    await page.locator('[data-pp-sort]').selectOption('active');
    assert.equal(await page.locator('.pp-tracks').getAttribute('data-pp-sort-key'), 'active');
    assert.equal(await page.locator('.pp-sort-active strong').first().evaluate(el => getComputedStyle(el).fontWeight), '700');
    await page.locator('[data-pp-sort]').selectOption('attempts');
    assert.equal(await page.locator('.pp-sort-attempts').first().evaluate(el => getComputedStyle(el).fontWeight), '700');
    await page.locator('[data-pp-sort]').selectOption('finishes');
    assert.equal(await page.locator('.pp-sort-finishes').first().evaluate(el => getComputedStyle(el).fontWeight), '700');
    await page.locator('[data-pp-sort]').selectOption('longest-hunt');
    assert.equal(await page.locator('.pp-sort-longest-hunt').first().evaluate(el => getComputedStyle(el).fontWeight), '700');
    await page.locator('[data-pp-sort]').selectOption('improvement');
    assert.equal(await page.locator('.pp-sort-improvement.pp-zero').first().isVisible(), true);
    const clickTargets = await page.locator('.pp-track').first().evaluate(el => ({
      card: el.hasAttribute('data-track-id'), controls: [...el.querySelectorAll('[data-track-id]')].map(item => item.className),
      cursors: [getComputedStyle(el).cursor, getComputedStyle(el.querySelector('.pp-art')).cursor,
        getComputedStyle(el.querySelector('.pp-track-name-button')).cursor]
    }));
    assert.deepEqual(clickTargets, { card: false, controls: ['pp-art pp-track-open', 'pp-track-name-button'], cursors: ['auto', 'pointer', 'pointer'] });
    await page.evaluate(() => {
      window.practiceStarts = [];
      document.querySelector('#overallProfilePopup').addEventListener('click', event => {
        const target = event.target.closest('[data-track-id]');
        if (target) window.practiceStarts.push(target.dataset.trackId);
      });
    });
    await page.locator('.pp-track').first().locator('.pp-track-data').click();
    assert.deepEqual(await page.evaluate(() => window.practiceStarts), []);
    await page.locator('.pp-track').first().locator('.pp-art').click();
    await page.locator('.pp-track').first().locator('.pp-track-name-button').click();
    assert.equal((await page.evaluate(() => window.practiceStarts)).length, 2);
    await page.locator('[data-pp-search]').fill('missing');
    assert.equal(await page.locator('.pp-no-results').isVisible(), true);
    await page.locator('[data-pp-search]').fill('Beta');
    assert.deepEqual(await ids(), ['b']);
    await page.locator('[data-pp-search]').fill('');
    for (const [width, height] of [[320, 568], [390, 844], [568, 320], [844, 320], [844, 390], [1024, 768], [1366, 600]]) {
      await page.setViewportSize({ width, height });
      for (const view of ['grid', 'list']) {
        await page.locator('[data-pp-view="' + view + '"]').click();
        assert.equal(await page.locator('[data-pp-view="' + view + '"]').getAttribute('aria-pressed'), 'true');
        const overflowing = await page.locator('.polytrack-practice-profile, .pp-toolbar, .pp-track, .pp-results').evaluateAll(items =>
          items.filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.className));
        assert.deepEqual(overflowing, [], width + ' ' + view + ' fits');
        const controlsFit = await page.locator('.pp-toolbar input, .pp-toolbar select, .pp-toolbar button').evaluateAll(items =>
          items.every(item => { const r = item.getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth; }));
        assert.equal(controlsFit, true, 'touch controls fit ' + width);
        if (width >= 1366) {
          const sortWidth = await page.locator('[data-pp-sort]').evaluate(item => item.getBoundingClientRect().width);
          assert.ok(sortWidth >= 200 && sortWidth <= 260, 'desktop sort selector stays compact but readable');
        }
        const palette = await page.evaluate(() => {
          const style = selector => getComputedStyle(document.querySelector(selector));
          return {
            track: style('.pp-track').backgroundColor,
            trackAccent: style('.pp-track').borderLeftColor,
            headingAccent: style('.pp-heading').borderLeftColor,
            heading: style('.pp-heading').backgroundImage,
            input: style('[data-pp-search]').backgroundColor,
            select: style('[data-pp-sort]').backgroundColor,
            pressed: style('[data-pp-view][aria-pressed="true"]').backgroundColor,
            tracked: style('.pp-evidence-tracked').backgroundColor,
            trackedLabel: style('.pp-evidence-tracked strong').color,
            planner: style('.profile-guide-track').backgroundColor
          };
        });
        assert.deepEqual(palette, {
          track: 'rgb(38, 61, 117)', trackAccent: 'rgb(126, 231, 255)',
          headingAccent: 'rgb(255, 212, 135)',
          heading: 'linear-gradient(110deg, rgb(41, 70, 133), rgb(28, 48, 100))',
          input: 'rgb(20, 41, 85)', select: 'rgb(20, 41, 85)',
          pressed: 'rgb(126, 231, 255)', tracked: 'rgb(53, 60, 103)',
          trackedLabel: 'rgb(255, 212, 135)', planner: 'rgb(37, 62, 115)'
        }, 'practice uses PolyTrack blue without changing the planner at ' + width + ' ' + view);
        const overlapping = await page.locator('.pp-toolbar input, .pp-toolbar select, .pp-toolbar button').evaluateAll(items => {
          const boxes = items.map(item => item.getBoundingClientRect());
          return boxes.some((a, i) => boxes.slice(i + 1).some(b =>
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1));
        });
        assert.equal(overlapping, false, 'controls never overlap at ' + width);
      }
    }
    assert.equal(await page.locator('.pp-coverage-note').isVisible(), false);
    assert.equal(await page.locator('.pp-coverage-details').count(), 1);
    assert.equal(await page.locator('.pp-coverage-low, .pp-no-finish, .pp-evidence-unavailable').count(), 0);
    await page.locator('.pp-coverage-details > summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.pp-coverage-note').isVisible(), true);
    assert.match(await page.locator('[data-pp-track-id="a"] .pp-results').textContent(), /Snapshot PB.*9.80s/);
    assert.equal(await page.locator('[data-pp-track-id="a"] .pp-pb-age').count(), 0);
    assert.equal(await page.locator('[data-pp-track-id="b"] .pp-results').count(), 0);
    assert.match(await page.locator('[data-pp-track-id="c"] .pp-results').textContent(), /best 10.20s/);
    if (process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR) {
      await page.locator('[data-pp-sort]').selectOption('active');
      await page.locator('[data-pp-view="grid"]').click();
      await page.locator('.pp-coverage-details > summary').click();
      await page.addStyleTag({ content: '#overallProfilePopup, #overallProfilePopup .overall-profile-card{' +
        'position:static!important;height:auto!important;max-height:none!important;overflow:visible!important}' });
      for (const [width, height] of [[1366, 600], [390, 844], [844, 320]]) {
        await page.setViewportSize({ width, height });
        await page.screenshot({ path: process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR + `/practice-${width}x${height}.png` });
      }
    }
    await page.evaluate(() => window.disposePractice());
    const before = await ids();
    await page.locator('[data-pp-search]').fill('no event listener');
    await direction.click();
    assert.deepEqual(await ids(), before, 'cleanup removes search and direction listeners');
  } finally {
    await browser.close();
  }
});
test('observed session details are optional and known PBs remain separate from driven finishes',()=>{
 const html=renderPracticeProfile({rows:[row({observationVersion:1,focusedMs:90000,pausedMs:12000,movingMs:70000,motionObservedMs:80000,longestHuntMs:60000,biggestPbImprovementMs:350})],results:[{trackId:'track-a',timeMs:45000,source:'snapshot',rank:4,fieldSize:20}]});
 assert.match(html,/<details class="pp-session-details">/);assert.match(html,/Session details/);assert.match(html,/Largest driven PB gain/);assert.match(html,/Rank 4 of 20/);assert.match(html,/best 47.25s/);
});

test('practice without an observed PB does not imply a recorded PB timestamp',()=>{
 const html=renderPracticeProfile({rows:[row({lastPbAt:0})]});
 assert.match(html,/1m 1s without a tracked PB/);assert.doesNotMatch(html,/since last recorded best/);
});
test('secondary PB evidence stays available in a compact per-track disclosure',()=>{
 const html=renderPracticeProfile({rows:[row()],results:[{trackId:'track-a',source:'snapshot',timeMs:48000},{trackId:'track-a',local:true,timeMs:46000}]});
 assert.ok(html.indexOf('46.00s')<html.indexOf('48.00s'));assert.match(html,/data-pp-details-key="track:track-a"/);
 assert.match(html,/More history for Summer Run/);assert.match(html,/Snapshot PB/);
});

test('per-track history exposes recent pace and separates earlier time estimates',()=>{
 const html=renderPracticeProfile({rows:[row({activeTimeVersion:2,activeMs:90000,legacyActiveMs:60000,
  recentFinishes:[{at:Date.now()-1000,timeMs:50000},{at:Date.now(),timeMs:48000}],furthestCheckpoint:4})]});
 assert.match(html,/Earlier time estimate/);assert.match(html,/New race progress/);
 assert.match(html,/Latest finish/);assert.match(html,/Recent finish range/);assert.match(html,/48.00s to 50.00s/);
 assert.match(html,/Furthest checkpoint/);assert.match(html,/Includes earlier time estimates/);assert.match(html,/PRACTICE TIME/);
});

test('a substantial older hunt gets a revisit suggestion without claiming guaranteed improvement',()=>{
 const html=renderPracticeProfile({rows:[row({lastPlayedAt:Date.now()-8*86400000})]});
 assert.match(html,/aria-label="Practice suggestion"/);assert.match(html,/Last practised 8 days ago/);
 assert.doesNotMatch(html,/guaranteed|will improve/);
 const sparse=renderPracticeProfile({rows:[row({attempts:1,activeMs:1000})]});
 assert.doesNotMatch(sparse,/Practice suggestion|Recent finish range|Latest finish|Earlier time estimate/);
});

test('compact active sort label keeps the full accessible option name',()=>{
 const html=renderPracticeProfile({rows:[row()]});
 assert.match(html,/<option value="active" aria-label="Active race time" selected>Active time<\/option>/);
});

test('furthest checkpoint labels the supplied single-attempt index without deriving cumulative progress',()=>{
 const html=renderPracticeProfile({rows:[row({furthestCheckpoint:4,attempts:150,finishes:90,pbs:20})]});
 assert.match(html,/<dt title="Highest checkpoint index observed in a single attempt, not total across all drives">Furthest checkpoint<\/dt><dd>4<\/dd>/);
 assert.doesNotMatch(html,/Checkpoint progress|Total checkpoints|Cumulative checkpoints/);
 const absent=renderPracticeProfile({rows:[row({furthestCheckpoint:undefined,attempts:150,finishes:90,pbs:20})]});
 assert.doesNotMatch(absent,/Furthest checkpoint/);
});

test('official and completed metadata separates saved PBs from recorded finishes',()=>{
 const html=renderPracticeProfile({rows:[row({trackId:'official',finishes:0,trackedBestMs:0,bestMs:40000,biggestObservedImprovementMs:2000,biggestPbImprovementMs:1000})],trackType:()=> 'official'});
 assert.match(html,/data-official="true" data-completed="true"/);
 assert.match(html,/Known PB evidence/);assert.doesNotMatch(html,/recorded finishes/);
 assert.match(html,/data-observed-gain-ms="2000"/);assert.match(html,/data-driven-gain-ms="1000"/);
 assert.match(html,/value="observed-gain"/);assert.match(html,/value="driven-gain"/);
 const confirmed=renderPracticeProfile({rows:[row()],results:[{trackId:'track-a',timeMs:45000,local:true,cloudConfirmed:true}]});
 assert.match(confirmed,/Submitted PB/);assert.doesNotMatch(confirmed,/Local PB/);
});
