import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(new URL('./verifier/package.json', import.meta.url));
const {chromium} = require('playwright');
const patch = await fs.readFile(path.join(root, 'polytrack_062_patch.js'), 'utf8');
const main = await fs.readFile(path.join(root, 'main.bundle.js'), 'utf8');
function block(start, end) {
  const from = patch.indexOf(start), to = patch.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return patch.slice(from, to);
}
const helpers = block('  function invalidateNativePartialReplay(', '  async function repairOwnNativeRecording(');
const reader = block('  function cachedNativeRecording(', '  function invalidateNativePartialReplay(');
const trackChange = block('  function selectCachedTrackState(', '  function setTrackLoadStateForGeneration(');
const rowChange = block('  function chooseNativeRows(', '  function selectTopNativeRows(');
const accountWrite = /invalidateNativePartialReplayAccount\(accountId\);\s*localStorage\.setItem\('polytrack-0\.6\.2-active-account-id', accountId\);/.exec(patch)?.[0];
const generationChange = /nativeRecordingEpoch\+\+;nativeRecordingMemory\.clear\(\);nativeRecordingRequests\.clear\(\);nativeRecordingRetryAt\.clear\(\);\s*invalidateNativePartialReplay\(true\);/.exec(patch)?.[0];
assert.ok(accountWrite && generationChange);
const factories = main.slice(main.indexOf('t={') + 2, main.lastIndexOf('},n={};function i(e)') + 1);
const methodStart = main.indexOf('getRecordings(e){');
const nativeMethod = main.slice(methodStart, main.indexOf('submitLeaderboard(', methodStart));
let browser;
before(async () => { browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})}); });
after(async () => { await browser?.close(); });

async function fixture(t, options = {}) {
  const page = await browser.newPage();
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'localhost') { external.push(url.href); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: '<!doctype html><div class="track-info-ui"><div class="leaderboard-ui"></div><div class="side-panel"><button class="play">Play</button><button class="watch">Watch</button><button class="back">Back</button><p id="status"></p></div></div>'});
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !file.endsWith('.mjs')) return route.abort();
    try { return route.fulfill({contentType: 'text/javascript', body: await fs.readFile(file)}); }
    catch { return route.fulfill({status: 404, body: ''}); }
  });
  await page.goto('http://localhost/');
  await page.evaluate(async ({helpers, reader, trackChange, rowChange, accountWrite, generationChange, factories, nativeMethod, options}) => {
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
    const module = await import('/tools/partial-replay-selection.mjs?v=194');
    const {preparePublicRecordingPlayback} = await import('/tools/public-replay-playback.mjs');
    const stats = window.stats = {reads: [], prepares: [], refreshes: 0, native: 0, races: [], failures: [], writes: 0, firebase: 0};
    Object.defineProperty(window, 'firebase', {get() { stats.firebase++; throw Error('No Firebase permitted'); }});
    const input = new (require(1754).A)(); input.recordFrame(0, {up: true, right: false, down: false, left: false, reset: false});
    const recording = input.serialize(), carStyle = require(8724).A.default().serialize();
    const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');
    const track = 'b'.repeat(64), account = 'a'.repeat(64);
    localStorage.setItem('polytrack-0.6.2-active-account-id', account);
    const entries = [], payloads = new Map();
    for (const id of [1, 2, 3]) {
      const entry = {uploadId: id, trackId: track, accountId: id === 3 ? account : String(id).repeat(64), frames: 1000 + id, timeMs: 1000 + id,
        replayHash: await hash(recording), integrityVerified: true, runVerified: false, verified: false, verifiedState: 0};
      const payload = {...entry, recording, carStyle};
      if (id === 2) {
        if (options.badHash) payload.replayHash = '0'.repeat(64);
        if (options.badBinding) payload.accountId = 'f'.repeat(64);
        if (options.badStyle) payload.carStyle = 'AAAA';
        if (options.badRecording) { payload.recording = 'AAAA'; payload.replayHash = entry.replayHash = await hash('AAAA'); }
        if (options.badFrames) payload.frames = entry.frames = 4000001;
        if (options.badState) payload.verifiedState = -1;
      }
      entries.push(entry); payloads.set(id, options.allMissing || id === 2 && !options.allValid ? null : payload);
    }
    const root = document.querySelector('.track-info-ui'), board = root.querySelector('.leaderboard-ui');
    let selected = [1, 2, 3].map(recordingId => ({recordingId, nickname: 'Racer ' + recordingId, isSelf: recordingId === 3}));
    if (options.empty) selected = [];
    const selection = board.__pt062OpponentSelection = {version: 1, trackId: () => track,
      accountId: () => localStorage.getItem('polytrack-0.6.2-active-account-id'), get: () => selected.map(row => ({...row})),
      set(rows) { stats.writes++; selected = rows.map(row => ({...row})); }};
    let release; const gate = options.delayed ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
    const api = new Function('module', 'require', 'preparePublicRecordingPlayback', 'stats', 'entries', 'payloads', 'gate', 'root', 'board', 'options', `
      let nativePartialReplaySelection=null,nativePartialReplayRevision=0,trackLoadGeneration=0,rankedTrackNavigationEpoch=0;
      let currentTrackLoadState={trackId:entries[0].trackId};
      const TRACK_CACHE_KEY='track-cache',RECORDING_STORE_KEY='recording-cache',TRACK_REFRESH_MS=60000;
      let eventPending=options.eventPending===true,engineFailed=false;
      const eventUi={isEntered:()=>eventPending,isTrackNavigationCurrent:()=>eventPending};
      const activeRankedAccountId=()=>localStorage.getItem('polytrack-0.6.2-active-account-id');
      const isElementVisible=node=>!!node?.isConnected&&!node.hidden&&!node.classList.contains('hidden');
      const opponentShortcutBoard=()=>isElementVisible(board)?board:null;
      const opponentShortcutStatus=(_board,text)=>document.querySelector('#status').textContent=text;
      const __pt062WebpackRequire=()=>require,normalizeReplayPayloadString=value=>value,__pt062NormalizeStyle=value=>value,getDefaultCarStyle=()=>'';
      const safePositiveInt=(value,fallback)=>Number.isSafeInteger(value)&&value>=1?value:fallback;
      const readRecordingStore=ids=>ids.map(id=>options.poisonedLocal&&id===2?{...payloads.get(id),frames:9}:null);
      const readPublicSnapshotBackup=async(kind,id)=>{stats.reads.push([kind,id]);await gate;return kind==='track'?{entries}:payloads.get(Number(id));};
      const publicSnapshotReaderPromise=Promise.resolve({recordingPlayback:async entry=>{
        stats.prepares.push(entry.uploadId);const payload=payloads.get(entry.uploadId);return payload?preparePublicRecordingPlayback(payload,entry,{allowPending:true}):null;
      }});
      const playbackWorkerBridgePromise=Promise.resolve({refreshPreparedRecording:async()=>{stats.refreshes++;if(engineFailed)throw Error('Playback engine asset mismatch');}});
      const nativeDigitsHeld=new Map([['Digit1',1]]),nativeDigitsConsumed=new Set(['Digit1']);
      let nativeTopHeld=true,nativeTopPrefixUntil=999,nativeTopSelectToken=0,overallPageOffset=100;
      const resetOverallPageOffset=()=>{overallPageOffset=0;};
      const updateTrackFreshnessBanner=()=>{},nativeRowSelected=row=>row.selected;
      ${reader}
      ${helpers}
      ${trackChange}
      ${rowChange}
      document.addEventListener('click',nativePartialReplayStartupClick,true);
      if(!options.startup)installNativePartialReplayFallback(module);
      return {readNativeRecordings,context:()=>nativePartialReplayContext(root.querySelector('.play')),
        install:()=>installNativePartialReplayFallback(module),
        change:kind=>{
          if(kind==='account'){const accountId='c'.repeat(64);${accountWrite}}
          if(kind==='account-back'){for(const accountId of ['c'.repeat(64),'a'.repeat(64)]){${accountWrite}}}
          if(kind==='track-back'){selectCachedTrackState('c'.repeat(64),null);selectCachedTrackState(entries[0].trackId,null);}
          if(kind==='selection-back')chooseNativeRows([],[]);
          if(kind==='generation'){${generationChange}}
          if(kind==='binding'){entries[0].replayHash='0'.repeat(64);invalidateNativePartialReplay(true);}
          if(kind==='event')eventPending=true;
          if(kind==='hidden-back'){root.hidden=true;root.hidden=false;}
          if(kind==='remove-back'){root.remove();document.body.append(root);}
          if(kind==='engine')engineFailed=true;
          if(kind==='dispose')nativePartialReplaySelection.dispose();
        },held:()=>({digits:nativeDigitsHeld.size,consumed:nativeDigitsConsumed.size,top:nativeTopHeld,offset:overallPageOffset}),
        cacheSize:()=>nativePartialReplaySelection.cacheSize()};
    `)(module, require, preparePublicRecordingPlayback, stats, entries, payloads, gate, root, board, options);
    class XHR {
      static DONE = 4;
      open(_method, url) { this.ids = new URL(url).searchParams.get('ids').split(',').map(Number); }
      overrideMimeType() {}
      send() { api.readNativeRecordings(this.ids).then(rows => { this.readyState = 4; this.status = 200; this.responseText = JSON.stringify(rows); this.onreadystatechange(); }); }
    }
    const Native = new Function('R', 'Af', 'gf', 'Mo', 'ie', 'xt', 'Zt', 'XMLHttpRequest', 'return class {' + nativeMethod + '}')(
      {gn: (_instance, field) => field === 'timeout' ? 5000 : ''}, 'api', 'timeout', {Ok: 0}, require(1754), require(6146), require(8724), XHR);
    const native = new Native(); native.determinismState = options.determinismFailure ? 1 : 0;
    for (const button of root.querySelectorAll('.play,.watch')) button.onclick = () => {
      stats.native++; const rows = selected.map(row => ({...row}));
      stats.readsAtNative = stats.reads.length;
      native.getRecordings(rows.map(row => row.recordingId)).then(recordings => {
        if (recordings.some(row => !row)) throw Error('Missing recording');
        stats.races.push(recordings.map((payload, i) => ({...rows[i], frames: payload.time.numberOfFrames})));
      }).catch(error => stats.failures.push(error.message));
    };
    window.fixture = {api, release, selected: () => selected};
  }, {helpers, reader, trackChange, rowChange, accountWrite, generationChange, factories, nativeMethod, options});
  t.after(async () => { assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(await page.evaluate(() => stats.firebase), 0); await page.close(); });
  return page;
}
const proceed = page => page.getByRole('button', {name: 'Continue with working replays'});
const chooser = page => page.locator('.sq-partial-replay-dialog');

test('patch wiring uses v194 and only the existing native reader, with synchronous lifecycle hooks', () => {
  assert.match(patch, /partial-replay-selection\.mjs\?v=194/);
  assert.match(helpers, /readRecordings:ids=>readNativeRecordings\(ids\)/);
  assert.doesNotMatch(helpers, /firebase|\bfetch\(/i);
  assert.equal((patch.match(/invalidateNativePartialReplayAccount\(accountId\);/g) || []).length, 3);
  assert.match(patch, /if\(id===currentTrackLoadState\?\.trackId\)invalidateNativePartialReplay\(true\)/);
  assert.match(patch, /async function applyOpponentShortcut[^\n]+\r?\n\s*invalidateNativePartialReplay\(\)/);
  assert.match(patch, /async function focusTrackFromRanked[^\n]+\r?\n\s*invalidateNativePartialReplay\(\)/);
});

test('actual patch waits for consent, preserves positional names/self, and native resume uses cached successes', async t => {
  const page = await fixture(t);
  assert.equal(await page.evaluate(() => fixture.api.context().selection === document.querySelector('.leaderboard-ui').__pt062OpponentSelection), true);
  await page.locator('.play').click(); await proceed(page).waitFor();
  assert.equal(await page.evaluate(() => stats.native), 0);
  assert.deepEqual(await page.evaluate(() => fixture.api.held()), {digits: 0, consumed: 0, top: false, offset: 0});
  await proceed(page).click(); await page.waitForFunction(() => stats.races.length === 1);
  assert.deepEqual(await page.evaluate(() => stats.races[0]), [
    {recordingId: 1, nickname: 'Racer 1', isSelf: false, frames: 1001},
    {recordingId: 3, nickname: 'Racer 3', isSelf: true, frames: 1003}
  ]);
  assert.equal(await page.evaluate(() => stats.reads.length === stats.readsAtNative), true);
  assert.ok(await page.evaluate(() => stats.refreshes >= 6));
});

test('Cancel leaves original selection and successful cache entries intact', async t => {
  const page = await fixture(t); await page.locator('.play').click(); await proceed(page).waitFor();
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  assert.equal(await page.evaluate(() => stats.writes), 0);
  assert.equal(await page.evaluate(() => fixture.selected().length), 3);
  await page.locator('.play').click(); await proceed(page).waitFor();
  assert.equal(await page.evaluate(() => stats.reads.filter(([kind]) => kind === 'recording').length), 3);
  assert.equal(await page.evaluate(() => stats.native), 0);
});

for (const change of ['account', 'account-back', 'track-back', 'selection-back', 'generation', 'binding', 'event', 'hidden-back', 'remove-back', 'dispose']) {
  test(`pending consent cancels on ${change}`, async t => {
    const page = await fixture(t); await page.locator('.play').click(); await proceed(page).waitFor();
    await page.evaluate(kind => fixture.api.change(kind), change);
    await chooser(page).waitFor({state: 'detached'});
    assert.equal(await page.evaluate(() => stats.native), 0);
    assert.equal(await page.evaluate(() => stats.writes), 0);
    if (change === 'generation' || change === 'binding') assert.equal(await page.evaluate(() => fixture.api.cacheSize()), 0);
  });
}

for (const change of ['account-back', 'track-back', 'selection-back', 'generation', 'hidden-back']) {
  test(`loading cannot resume after ${change}, even when the context returns`, async t => {
    const page = await fixture(t, {delayed: true});
    await page.evaluate(kind => { document.querySelector('.play').click(); fixture.api.change(kind); fixture.release(); }, change);
    await page.waitForTimeout(100);
    assert.equal(await chooser(page).count(), 0); assert.equal(await page.evaluate(() => stats.native), 0);
  });
}

for (const failure of ['badHash', 'badBinding', 'badStyle', 'badRecording', 'badFrames', 'badState', 'poisonedLocal']) {
  test(`actual patch excludes ${failure} rather than treating cached payload as valid`, async t => {
    const page = await fixture(t, {allValid: true, [failure]: true});
    await page.locator('.play').click(); await proceed(page).waitFor();
    assert.match(await chooser(page).textContent(), /2 of 3/);
    assert.equal(await page.evaluate(() => stats.native), 0);
  });
}

test('engine refresh failure on a chooser cache hit fails closed', async t => {
  const page = await fixture(t); await page.locator('.play').click(); await proceed(page).waitFor();
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  await page.evaluate(() => fixture.api.change('engine'));
  await page.locator('.play').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('No selected replay'));
  assert.equal(await chooser(page).count(), 0); assert.equal(await page.evaluate(() => stats.native), 0);
});

test('native determinism gate is still enforced after consent', async t => {
  const page = await fixture(t, {determinismFailure: true}); await page.locator('.play').click(); await proceed(page).waitFor();
  await proceed(page).click(); await page.waitForFunction(() => stats.failures.length === 1);
  assert.match(await page.evaluate(() => stats.failures[0]), /Getting recordings not allowed/);
  assert.equal(await page.evaluate(() => stats.races.length), 0);
});

test('all valid Play bypasses chooser; Watch overflow and all-fail do not change selection', async t => {
  const play = await fixture(t, {allValid: true}); await play.locator('.play').click(); await play.waitForFunction(() => stats.races.length === 1);
  assert.equal(await chooser(play).count(), 0); assert.equal(await play.evaluate(() => stats.writes), 0);
  const watch = await fixture(t, {allValid: true}); await watch.locator('.watch').click();
  await watch.waitForFunction(() => document.querySelector('#status').textContent.includes('Watch supports 2'));
  assert.equal(await watch.evaluate(() => stats.native + stats.writes), 0);
  const missing = await fixture(t, {allMissing: true}); await missing.locator('.play').click();
  await missing.waitForFunction(() => document.querySelector('#status').textContent.includes('No selected replay'));
  assert.equal(await missing.evaluate(() => stats.native + stats.writes), 0);
});

test('event intent before overlay mount and empty local-PB selection bypass the hook', async t => {
  for (const options of [{eventPending: true}, {empty: true}]) {
    const page = await fixture(t, options); await page.locator('.play').click();
    assert.equal(await page.evaluate(() => stats.native), 1); assert.equal(await chooser(page).count(), 0);
    assert.equal(await page.evaluate(() => stats.writes), 0);
  }
});

test('startup guard blocks selected replay clicks until installation and installation is idempotent', async t => {
  const page = await fixture(t, {startup: true}); await page.locator('.play').click();
  assert.equal(await page.evaluate(() => stats.native), 0);
  assert.equal(await page.evaluate(() => fixture.api.install() === fixture.api.install()), true);
  await page.locator('.play').click(); await proceed(page).waitFor();
  await proceed(page).click(); await page.waitForFunction(() => stats.races.length === 1);
  assert.equal(await page.evaluate(() => stats.native), 1);
});
