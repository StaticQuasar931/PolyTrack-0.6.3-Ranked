import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(new URL('./verifier/package.json', import.meta.url));
const {chromium} = require('playwright');
const main = await fs.readFile(path.join(root, 'main.bundle.js'), 'utf8');
const factories = main.slice(main.indexOf('t={') + 2, main.lastIndexOf('},n={};function i(e)') + 1);
const methodStart = main.indexOf('getRecordings(e){');
const nativeMethod = main.slice(methodStart, main.indexOf('submitLeaderboard(', methodStart));
const eventSource = await fs.readFile(path.join(root, 'events/client.mjs'), 'utf8');
const eventBlock = eventSource.slice(eventSource.indexOf('  const replayContextActive='), eventSource.indexOf('  function raceGhosts('));
const patchSource = await fs.readFile(path.join(root, 'polytrack_062_patch.js'), 'utf8');
const keyboardStart = patchSource.indexOf("    window.addEventListener('keydown', (event)=>{");
const keyboardEnd = patchSource.indexOf("    window.addEventListener('blur',resetOverallPageOffset);", keyboardStart);
assert.ok(keyboardStart >= 0 && keyboardEnd > keyboardStart, 'Actual patch keyboard registration is available');
const patchKeyboard = patchSource.slice(keyboardStart, keyboardEnd);
const cancelStart = patchSource.indexOf("    const cancel=event=>{if(event.key==='Escape'||event.type==='pointerdown'");
const cancelEnd = patchSource.indexOf('\n    try{', cancelStart);
assert.ok(cancelStart >= 0 && cancelEnd > cancelStart, 'Actual early document-capture navigation guard is available');
const patchCancel = patchSource.slice(cancelStart, cancelEnd);
const nativeKeyboardStart = main.indexOf('window.addEventListener("keydown",(0,R.GG)(this,wl,');
const nativeKeyboardEnd = main.indexOf(',"f"))', nativeKeyboardStart) + ',"f"))'.length;
assert.ok(nativeKeyboardStart >= 0 && nativeKeyboardEnd > nativeKeyboardStart, 'Actual native track keyboard registration is available');
const nativeKeyboard = main.slice(nativeKeyboardStart, nativeKeyboardEnd);
let browser;
before(async () => { browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})}); });
after(async () => { await browser?.close(); });

async function fixture(t, options = {}) {
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'localhost') { external.push(url.href); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Partial replay browser tests</title><style>body{background:#101a35;color:white;font:18px sans-serif}button{font:inherit;padding:12px}.track-info-ui{padding:32px}dialog::backdrop{background:#0009}</style><div class="track-info-ui"><div class="leaderboard-ui"></div><div class="side-panel"><button class="play">Play</button><button class="watch">Watch</button><button class="select">Change selection</button><button class="back">Back</button><p role="status" id="status"></p></div></div>'});
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !/\.(?:mjs|woff2)$/.test(file)) return route.abort();
    try { return route.fulfill({contentType: file.endsWith('.mjs') ? 'text/javascript' : 'font/woff2', body: await fs.readFile(file)}); }
    catch { return route.fulfill({status: 404, body: ''}); }
  });
  await page.goto('http://localhost/');
  await page.evaluate(async ({factories, nativeMethod, eventBlock, options}) => {
    const table = new Function('return (' + factories + ')')(), cache = {};
    const require = id => {
      if (cache[id]) return cache[id].exports;
      const module = cache[id] = {exports: {}}; table[id](module, module.exports, require); return module.exports;
    };
    require.d = (exports, names) => { for (const key in names) Object.defineProperty(exports, key, {get: names[key]}); };
    require.o = (object, key) => Object.hasOwn(object, key);
    require.r = exports => Object.defineProperty(exports, '__esModule', {value: true});
    require.n = exports => { const getter = exports?.__esModule ? () => exports.default : () => exports; require.d(getter, {a: getter}); return getter; };
    require.g = globalThis; require.p = '';
    const module = await import('/tools/partial-replay-selection.mjs');
    const {validatePublicReplayStructure} = await import('/tools/public-replay-playback.mjs');
    const {preparePublishedEventGhost} = await import('/events/public-replay.mjs');
    const input = new (require(1754).A)(); input.recordFrame(0, {up: true, right: false, down: false, left: false, reset: false});
    const recording = input.serialize(), carStyle = require(8724).A.default().serialize();
    const replayHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(recording)))].map(n => n.toString(16).padStart(2, '0')).join('');
    let selected = [1, 2, 3].map(recordingId => ({recordingId, nickname: recordingId === 1 ? 'First <img src=x onerror=alert(1)>' : 'Racer ' + recordingId, isSelf: recordingId === 3}));
    let account = 'a'.repeat(64), track = 'b'.repeat(64), revision = 1;
    const root = document.querySelector('.track-info-ui'), board = root.querySelector('.leaderboard-ui');
    const stats = window.stats = {reads: [], validations: [], nativeRequests: [], dispatched: 0, races: [], failures: [], keys: 0, writes: 0};
    const payloads = new Map([1, 2, 3].map(id => [id, options.allMissing || id === 2 && !options.allValid ? null : {recording: options.malformed && id === 2 ? 'AAAA' : recording, frames: 1000 + id, carStyle, verifiedState: 0}]));
    const rawCache = new Map();
    let release;
    const gate = options.delayed ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
    const read = async ids => {
      await gate;
      return ids.map(id => {
        if (rawCache.has(id)) return rawCache.get(id);
        stats.reads.push(id); const payload = payloads.get(id); if (payload) rawCache.set(id, payload); return payload;
      });
    };
    const selection = board.__pt062OpponentSelection = {version: 1, get: () => selected.map(row => ({...row})), trackId: () => track, accountId: () => account,
      set: (rows, context) => { if (context.trackId !== track || context.accountId !== account || !board.isConnected) throw Error('context'); stats.writes++; selected = rows; return rows.length; }};
    if (options.event) {
      const period = {id: 'daily-fixture', trackId: track};
      let session = {periodId: period.id, trackId: track, accountId: account};
      const rows = [1, 2, 3].map(id => ({accountId: String(id).repeat(64), name: 'Event racer ' + id, timeMs: 1000 + id, runId: String(id).repeat(64), replayHash, pending: false}));
      const view = {root, board, period, periodId: period.id, page: 0};
      const bridge = {accountId: () => account, require: () => require, readReplay: async (_period, id) => {
        stats.reads.push(id); await gate;
        if (options.allMissing || id === '2'.repeat(64)) return null;
        const row = rows.find(row => row.accountId === id);
        return {...row, periodId: period.id, trackId: track, frames: row.timeMs, replay: recording, carStyle, replayHash: options.corrupt && id === '3'.repeat(64) ? '0'.repeat(64) : replayHash};
      }};
      const api = new Function('bridge', 'sessions', 'nativeView', 'eventDisplayRows', 'preparePublishedEventGhost', 'confirmPartialReplaySelection', 'period', `
        let archiveIntent=null,selectedGhost=null,replayRequest=0,topSelectionToken=0;
        const selectedGhosts=new Map(),pendingGhosts=new Map(),replayCache=new Map(),preparedGhosts=new Map(),replayFailures=new Map(),knownPeriods=new Map([[period.id,period]]),catalog={periods:[period]};
        const now=Date.now,tick=()=>{},displayName=row=>row.name,message=text=>document.querySelector('#status').textContent=text;
        ${eventBlock}
        return {selectTopEventRows,selectReplay,clearEventGhostSelection,selected:()=>[...selectedGhosts.values()],pending:()=>pendingGhosts.size};
      `)(bridge, {current: () => session}, view, () => ({rows}), preparePublishedEventGhost, module.confirmPartialReplaySelection, period);
      root.querySelector('.play').onclick = () => { window.loading = api.selectTopEventRows(3); };
      window.fixture = {api, release, selected: () => api.selected(), change: kind => {
        if (kind === 'account') account = 'c'.repeat(64); else if (kind === 'session') session = {...session}; else if (kind === 'track') period.trackId = 'other';
        else if (kind === 'selection') api.clearEventGhostSelection(period.id, account); else if (kind === 'standings') rows[0].replayHash = 'changed'; else root.remove();
      }};
    } else {
      // Real native getRecordings and real native parsers, with only transport isolated.
      class XHR {
        static DONE = 4;
        open(_method, url) { this.ids = new URL(url).searchParams.get('ids').split(',').map(Number); }
        overrideMimeType() {}
        send() {
          stats.nativeRequests.push(this.ids);
          read(this.ids).then(rows => { this.readyState = 4; this.status = 200; this.responseText = JSON.stringify(rows); this.onreadystatechange(); });
        }
      }
      const Native = new Function('R', 'Af', 'gf', 'Mo', 'ie', 'xt', 'Zt', 'XMLHttpRequest', 'return class {' + nativeMethod + '}')(
        {gn: (_instance, field) => field === 'timeout' ? 5000 : ''}, 'api', 'timeout', {Ok: 0}, require(1754), require(6146), require(8724), XHR);
      const native = new Native(); native.determinismState = options.determinismFailure ? 1 : 0;
      const hook = module.installPartialReplaySelection({document,
        getContext: () => ({selection, revision, isCurrent: () => root.isConnected}), readRecordings: read,
        validateRecording: async (payload, row) => {
          stats.validations.push(row.recordingId);
          if (options.engineFailure && row.recordingId === 2) throw Error('Playback asset mismatch');
          await validatePublicReplayStructure(payload.recording, payload.frames);
          if (!require(1754).A.deserialize(payload.recording)) throw Error('Native replay decode failed');
          if (!require(8724).A.deserializeSafe(payload.carStyle)) throw Error('Native style decode failed');
          return true;
        }, status: text => document.querySelector('#status').textContent = text
      });
      for (const button of root.querySelectorAll('.play,.watch')) button.onclick = () => {
        stats.dispatched++; const rows = selected.map(row => ({...row}));
        native.getRecordings(rows.map(row => row.recordingId)).then(recordings => {
          if (recordings.some(row => !row)) throw Error('Failed to load at least one recording.');
          stats.races.push(recordings.map((payload, index) => ({name: rows[index].nickname, frames: payload.time.numberOfFrames, isSelf: rows[index].isSelf, verifiedState: payload.verifiedState})));
        }).catch(error => stats.failures.push(error.message));
      };
      window.fixture = {release, hook, selected: () => selected, change: kind => {
        if (kind === 'account') account += 'x'; else if (kind === 'track') track += 'x'; else if (kind === 'revision') revision++;
        else if (kind === 'selection') selected = [selected[2]]; else if (kind === 'history') window.dispatchEvent(new PopStateEvent('popstate')); else root.remove();
      }};
      root.querySelector('.select').onclick = () => fixture.change('selection');
      root.querySelector('.back').onclick = () => root.remove();
    }
    document.addEventListener('keydown', () => stats.keys++);
  }, {factories, nativeMethod, eventBlock, options});
  t.after(async () => { assert.deepEqual(errors, []); assert.deepEqual(external, [], 'no production, Firebase or live recovery traffic'); await page.close(); });
  return page;
}
const chooser = page => page.locator('.sq-partial-replay-dialog');
const proceed = page => page.getByRole('button', {name: 'Continue with working replays'});
const shot = async (page, name) => {
  if (!process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR) return;
  await fs.mkdir(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR, {recursive: true});
  await page.screenshot({path: path.join(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR, name + '.png')});
};

test('ordinary mixed selection: modal, desktop/mobile layout, safe names, native handoff and no extra reads', async t => {
  const page = await fixture(t);
  await page.getByRole('button', {name: 'Play', exact: true}).click(); await proceed(page).waitFor();
  assert.equal(await page.evaluate(() => stats.dispatched), 0); assert.equal(await chooser(page).locator('img').count(), 0);
  await shot(page, 'partial-replay-desktop');
  for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
    await page.setViewportSize({width, height});
    const bounds = await chooser(page).evaluate(el => { const box = el.getBoundingClientRect(); return {left: box.left, top: box.top, right: box.right, bottom: box.bottom, overflow: el.scrollWidth > el.clientWidth + 1}; });
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= width && bounds.bottom <= height, JSON.stringify(bounds)); assert.equal(bounds.overflow, false);
    await shot(page, `partial-replay-${width}x${height}`);
  }
  await proceed(page).click(); await page.waitForFunction(() => stats.races.length === 1);
  assert.deepEqual(await page.evaluate(() => stats.reads), [1, 2, 3]);
  assert.deepEqual(await page.evaluate(() => stats.nativeRequests), [[1, 3]]);
  assert.deepEqual(await page.evaluate(() => stats.races[0]), [{name: 'First <img src=x onerror=alert(1)>', frames: 1001, isSelf: false, verifiedState: 0}, {name: 'Racer 3', frames: 1003, isSelf: true, verifiedState: 0}]);
});
test('ordinary cancel, Escape, keyboard activation and repeat clicks do not silently drop or reread failures', async t => {
  const page = await fixture(t);
  await page.locator('.play').click(); await proceed(page).waitFor();
  await page.keyboard.press('Escape'); await chooser(page).waitFor({state: 'detached'});
  assert.equal(await page.evaluate(() => fixture.selected().length), 3); assert.equal(await page.evaluate(() => stats.dispatched), 0);
  await page.locator('.play').focus(); await page.keyboard.press('Enter'); await proceed(page).waitFor();
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  await page.locator('.play').click(); await proceed(page).waitFor(); await proceed(page).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => stats.races.length === 1); assert.deepEqual(await page.evaluate(() => stats.reads), [1, 2, 3]);
});
for (const change of ['account', 'track', 'revision', 'selection', 'history', 'navigation']) test(`ordinary chooser cancels on ${change}`, async t => {
  const page = await fixture(t); await page.locator('.play').click(); await proceed(page).waitFor();
  await page.evaluate(change => fixture.change(change), change); await chooser(page).waitFor({state: 'detached'});
  assert.equal(await page.evaluate(() => stats.dispatched), 0);
});
test('navigation while loading cancels; repeated Play only starts one preload', async t => {
  const page = await fixture(t, {delayed: true});
  await page.evaluate(() => { document.querySelector('.play').click(); document.querySelector('.play').click(); document.querySelector('.back').click(); fixture.release(); });
  await page.waitForTimeout(80); assert.equal(await chooser(page).count(), 0); assert.equal(await page.evaluate(() => stats.dispatched), 0);
  assert.deepEqual(await page.evaluate(() => stats.reads), [1, 2, 3]);
});
test('all-fail and all-valid flows, plus native determinism denial, stay fail-closed', async t => {
  const missing = await fixture(t, {allMissing: true});
  for (let i = 0; i < 2; i++) { await missing.locator('.play').click(); await missing.waitForFunction(() => document.querySelector('#status').textContent.includes('No selected replay')); }
  assert.equal(await chooser(missing).count(), 0); assert.equal(await missing.evaluate(() => stats.dispatched), 0); assert.deepEqual(await missing.evaluate(() => stats.reads), [1, 2, 3]);
  const valid = await fixture(t, {allValid: true}); await valid.locator('.play').click(); await valid.waitForFunction(() => stats.races.length === 1);
  assert.equal(await chooser(valid).count(), 0); assert.equal(await valid.evaluate(() => stats.writes), 0);
  const denied = await fixture(t, {allValid: true, determinismFailure: true}); await denied.locator('.play').click(); await denied.waitForFunction(() => stats.failures.length === 1);
  assert.deepEqual(await denied.evaluate(() => stats.failures), ['Getting recordings not allowed']); assert.equal(await denied.evaluate(() => stats.races.length), 0);
});
test('malformed native payload and engine failure are excluded only after consent; watch does not truncate', async t => {
  for (const option of ['malformed', 'engineFailure']) {
    const page = await fixture(t, {allValid: true, [option]: true}); await page.locator('.watch').click(); await proceed(page).waitFor();
    assert.equal(await page.evaluate(() => stats.dispatched), 0); await proceed(page).click(); await page.waitForFunction(() => stats.races.length === 1);
    assert.deepEqual(await page.evaluate(() => stats.nativeRequests), [[1, 3]]);
  }
  const page = await fixture(t, {allValid: true}); await page.locator('.watch').click(); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Watch supports 2'));
  assert.equal(await page.evaluate(() => fixture.selected().length), 3); assert.equal(await page.evaluate(() => stats.dispatched), 0); assert.equal(await chooser(page).count(), 0);
});
test('event mixed group uses real integrity/native parsers and waits for Continue', async t => {
  const page = await fixture(t, {event: true, corrupt: true}); await page.locator('.play').click(); await proceed(page).waitFor();
  assert.equal(await page.evaluate(() => fixture.api.pending()), 3); assert.equal(await page.evaluate(() => fixture.selected().length), 0);
  assert.match(await chooser(page).textContent(), /Your run and event points are unchanged/); assert.match(await chooser(page).textContent(), /1 of 3/); await shot(page, 'partial-event-replay');
  await proceed(page).click(); await page.evaluate(() => window.loading);
  assert.deepEqual(await page.evaluate(() => fixture.selected().map(row => row.ghost.nickname)), ['Event racer 1']); assert.equal(await page.evaluate(() => fixture.api.pending()), 0);
});
for (const change of ['account', 'session', 'track', 'standings', 'selection', 'navigation']) test(`event chooser cancels on ${change}`, async t => {
  const page = await fixture(t, {event: true}); await page.locator('.play').click(); await proceed(page).waitFor();
  await page.evaluate(change => fixture.change(change), change); await chooser(page).waitFor({state: 'detached'}); await page.evaluate(() => window.loading);
  assert.equal(await page.evaluate(() => fixture.selected().length), 0); assert.equal(await page.evaluate(() => fixture.api.pending()), 0);
});
test('event Cancel retains successes in cache without selecting; event all-fail never prompts', async t => {
  const page = await fixture(t, {event: true});
  for (let i = 0; i < 2; i++) { await page.locator('.play').click(); await proceed(page).waitFor(); await page.getByRole('button', {name: 'Cancel', exact: true}).click(); await page.evaluate(() => window.loading); }
  assert.equal(await page.evaluate(() => stats.reads.length), 3); assert.equal(await page.evaluate(() => fixture.selected().length), 0);
  const missing = await fixture(t, {event: true, allMissing: true}); await missing.locator('.play').click(); await missing.evaluate(() => window.loading);
  assert.equal(await chooser(missing).count(), 0); assert.match(await missing.locator('#status').textContent(), /Saved event replays unavailable/);
});
test('actual patch/native listeners registered BEFORE window guard cannot act through replay or snapshot dialogs', async t => {
  const page = await fixture(t);
  await page.evaluate(async ({patchKeyboard, patchCancel, nativeKeyboard}) => {
    const module = await import('/tools/partial-replay-selection.mjs');
    window[Symbol.for('polytrack.replay-modal-keyboard.v1')].dispose();
    const counts = window.keyboardCounts = {patch: 0, native: 0, earlyDocument: 0};
    const names = ['handleModeratorSequence', 'closeOverallPanel', 'handleArchivePageShortcut', 'handleOverallLeaderboardShortcut',
      'handleOpponentPresetShortcut', 'handleTrackLeaderboardShortcut', 'handleOfficialTrackShortcut', 'handleTrackMenuShortcut',
      'handleLobbyShortcut', 'handleTrackLeaderboardDigitRelease', 'handleOverallLeaderboardModifierRelease'];
    new Function('isElementVisible', 'closeRankedDialog', ...names, patchKeyboard)(
      node => !!node?.isConnected && node.style.display !== 'none', () => { counts.patch++; },
      ...names.map(() => () => { counts.patch++; return false; }));
    window.navigationEpoch = new Function('let rankedTrackNavigationEpoch=0;' + patchCancel + ';return ()=>rankedTrackNavigationEpoch;')();
    new Function('R', 'wl', 'xl', 'g', nativeKeyboard).call({}, {GG: (_owner, _field, value) => value, gn: () => null}, 'handler', 'dialog', () => { counts.native++; });
    document.addEventListener('keydown', () => counts.earlyDocument++, true);
    document.addEventListener('keyup', () => counts.earlyDocument++, true);
    // This is deliberately LATER than both the real global handlers and the
    // real document-capture navigation guard, reproducing the ordering concern.
    module.installReplayModalKeyboardGuard({document});
    window.openReplay = () => { window.modalResult = module.confirmPartialReplaySelection({document, ready: [{row: {nickname: 'Working'}}], failed: [{row: {nickname: 'Unavailable'}}], isCurrent: () => true}); };
    const snapshot = await import('/tools/snapshot-update-check.mjs');
    window.openSnapshot = () => snapshot.showSnapshotUpdateResult({status: 'current'}, {document});
    openReplay();
  }, {patchKeyboard, patchCancel, nativeKeyboard});
  await proceed(page).waitFor();
  for (const key of ['t', '1', 'c', 'ArrowLeft', 'ArrowRight', 'Shift+1']) await page.keyboard.press(key);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true);
  await proceed(page).focus(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => modalResult), true);
  assert.deepEqual(await page.evaluate(() => keyboardCounts), {patch: 0, native: 0, earlyDocument: 0});
  assert.equal(await page.evaluate(() => navigationEpoch()), 0);
  await page.evaluate(() => openReplay()); await proceed(page).waitFor(); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => modalResult), false);
  await page.evaluate(() => openSnapshot()); await page.locator('.sq-snapshot-update-dialog[open]').waitFor();
  for (const key of ['t', '1', 'c', 'ArrowLeft', 'ArrowRight', 'Shift+1']) await page.keyboard.press(key);
  await page.keyboard.press('Escape'); await page.locator('.sq-snapshot-update-dialog').waitFor({state: 'detached'});
  assert.deepEqual(await page.evaluate(() => keyboardCounts), {patch: 0, native: 0, earlyDocument: 0});
  assert.equal(await page.evaluate(() => navigationEpoch()), 0);
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => keyboardCounts.native > 0 && keyboardCounts.patch > 0 && keyboardCounts.earlyDocument > 0 && navigationEpoch() > 0), 'game handlers work normally once the modal closes');
});
