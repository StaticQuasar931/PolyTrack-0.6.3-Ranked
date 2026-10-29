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
const watchBlock = eventSource.slice(eventSource.indexOf('  function watchEvent(){'), eventSource.indexOf('  async function playEvent('));
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
  await page.addStyleTag({content: '@font-face{font-family:ForcedSquare;src:url(/forced_square.woff2) format("woff2")}'});
  await page.evaluate(async ({factories, nativeMethod, eventBlock, watchBlock, options}) => {
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
        if (options.allMissing || !options.allValid && id === '2'.repeat(64)) return null;
        const row = rows.find(row => row.accountId === id);
        return {...row, periodId: period.id, trackId: track, frames: row.timeMs, replay: recording, carStyle, replayHash: options.corrupt && id === '3'.repeat(64) ? '0'.repeat(64) : replayHash};
      }};
      root.__pt062EventWatch={version:1,trackId:track,open:ghosts=>{stats.races.push(ghosts.map(ghost=>({name:ghost.nickname,frames:ghost.time.numberOfFrames,isSelf:ghost.isSelf})));}};
      bridge.watchEvent=(_session,ghosts)=>root.__pt062EventWatch.open(ghosts);
      const api = new Function('bridge', 'sessions', 'nativeView', 'eventDisplayRows', 'preparePublishedEventGhost', 'confirmPartialReplaySelection', 'period', `
        let archiveIntent=null,selectedGhost=null,replayRequest=0,topSelectionToken=0;
        const selectedGhosts=new Map(),pendingGhosts=new Map(),replayCache=new Map(),preparedGhosts=new Map(),replayFailures=new Map(),knownPeriods=new Map([[period.id,period]]),catalog={periods:[period]};
        const now=Date.now,tick=()=>{},displayName=row=>row.name,message=text=>document.querySelector('#status').textContent=text;
        ${eventBlock}
        ${watchBlock}
        return {selectTopEventRows,selectReplay,clearEventGhostSelection,watchEvent,damageSelectedReplay:()=>{for(const [key,payload] of replayCache)if(key.includes('3'.repeat(64)))payload.carStyle='AAAA';},selected:()=>[...selectedGhosts.values()],pending:()=>pendingGhosts.size};
      `)(bridge, {current: () => session}, view, () => ({rows}), preparePublishedEventGhost, module.confirmPartialReplaySelection, period);
      root.querySelector('.play').onclick = () => { window.loading = api.selectTopEventRows(3); };
      root.querySelector('.watch').onclick = () => { window.loading = api.watchEvent(); };
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
  }, {factories, nativeMethod, eventBlock, watchBlock, options});
  t.after(async () => { assert.deepEqual(errors, []); assert.deepEqual(external, [], 'no production, Firebase or live recovery traffic'); await page.close(); });
  return page;
}
const chooser = page => page.locator('.sq-partial-replay-dialog');
const proceed = page => page.locator('[data-partial-replay-continue]');
const shot = async (page, name) => {
  if (!process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR) return;
  await fs.mkdir(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR, {recursive: true});
  await page.screenshot({path: path.join(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR, name + '.png')});
};

test('ordinary mixed selection: modal, desktop/mobile layout, safe names, native handoff and no extra reads', async t => {
  const page = await fixture(t);
  await page.getByRole('button', {name: 'Play', exact: true}).click(); await proceed(page).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  assert.ok(main.includes('font-family: ForcedSquare;'), 'uses the exact family declared by the native game');
  assert.equal(await page.evaluate(()=>[...document.fonts].some(face=>face.family==='ForcedSquare'&&face.status==='loaded')&&document.fonts.check('20px ForcedSquare')),true,'repository ForcedSquare font loaded, not a generic fallback');
  assert.equal(await proceed(page).textContent(),'Skip & play');
  assert.equal(await chooser(page).evaluate(el=>getComputedStyle(el).borderRadius),'0px');
  assert.equal(await page.getByRole('dialog',{name:'Skip unavailable replays?'}).count(),1);
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

for (const mode of ['play', 'watch']) test(`scaled ${mode} chooser keeps native typography and both actions visible on short screens`, async t => {
  const page = await fixture(t);
  await page.setViewportSize({width: 844, height: 390});
  await page.locator('.' + mode).click(); await proceed(page).waitFor();
  await page.evaluate(() => document.fonts.ready);
  for (const scale of [0.85, 1, 1.25]) {
    await page.evaluate(scale => document.documentElement.style.setProperty('--sq-ui-scale', scale), String(scale));
    const sizes = await chooser(page).evaluate(dialog => {
      const style = getComputedStyle(dialog);
      return {body: parseFloat(style.fontSize), title: parseFloat(getComputedStyle(dialog.querySelector('h2')).fontSize),
        note: parseFloat(getComputedStyle(dialog.querySelector('.sq-partial-note')).fontSize),
        button: parseFloat(getComputedStyle(dialog.querySelector('button')).fontSize), family: style.fontFamily, italic: style.fontStyle};
    });
    assert.equal(sizes.body, 20 * scale);
    assert.equal(sizes.title, 30 * scale);
    assert.equal(sizes.note, 16 * scale);
    assert.equal(sizes.button, 20 * scale);
    assert.match(sizes.family, /^ForcedSquare/); assert.equal(sizes.italic, 'italic');
  }
  // More names than fit force content scrolling, not scrolling the actions offscreen.
  await chooser(page).locator('ul').evaluate(list => {
    list.style.maxHeight = 'none';
    for (let i = 0; i < 9; i++) { const li = document.createElement('li'); li.textContent = 'Unavailable racer ' + i; list.append(li); }
  });
  for (const [width, height] of [[844, 390], [320, 568], [640, 320]]) {
    await page.setViewportSize({width, height});
    for (const bottom of [false, true]) {
      const layout = await chooser(page).evaluate((dialog, bottom) => {
        const content = dialog.querySelector('.sq-partial-body');
        content.scrollTop = bottom ? content.scrollHeight : 0;
        const box = dialog.getBoundingClientRect();
        return {overflow: dialog.scrollWidth > dialog.clientWidth + 1,
          contentScrolls: content.scrollHeight > content.clientHeight,
          actions: [...dialog.querySelectorAll('button')].map(button => {
            const rect = button.getBoundingClientRect();
            return {visible: rect.top >= box.top && rect.bottom <= box.bottom && rect.bottom <= innerHeight,
              height: rect.height, font: getComputedStyle(button).fontFamily};
          })};
      }, bottom);
      assert.equal(layout.overflow, false); assert.equal(layout.contentScrolls, true);
      for (const action of layout.actions) { assert.equal(action.visible, true, JSON.stringify(layout)); assert.ok(action.height >= 44); assert.match(action.font, /^ForcedSquare/); }
    }
    assert.equal(await proceed(page).textContent(), 'Skip & ' + mode);
    assert.equal(await page.evaluate(() => stats.dispatched + stats.writes), 0);
    await shot(page, `partial-replay-${mode}-scaled-${width}x${height}`);
  }
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  assert.equal(await page.evaluate(() => fixture.selected().length), 3);
  assert.equal(await page.evaluate(() => stats.dispatched + stats.writes), 0);
  assert.equal(await page.locator('.' + mode).evaluate(button => button === document.activeElement), true);
});

test('ordinary cancel, Escape, keyboard activation and repeat clicks do not silently drop or reread failures', async t => {
  const page = await fixture(t);
  await page.locator('.play').click(); await proceed(page).waitFor();
  await page.keyboard.press('Escape'); await chooser(page).waitFor({state: 'detached'});
  assert.equal(await page.locator('.play').evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.evaluate(() => fixture.selected().length), 3); assert.equal(await page.evaluate(() => stats.dispatched), 0);
  await page.locator('.play').focus(); await page.keyboard.press('Enter'); await proceed(page).waitFor();
  assert.equal(await page.getByRole('button', {name:'Cancel',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Enter'); await chooser(page).waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>fixture.selected().length),3);assert.equal(await page.evaluate(()=>stats.dispatched),0);
  await page.locator('.play').click();await proceed(page).waitFor();
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  await page.locator('.play').click(); await proceed(page).waitFor(); await proceed(page).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => stats.races.length === 1); assert.deepEqual(await page.evaluate(() => stats.reads), [1, 2, 3]);
});

test('native-style modal traps focus, handles long names and remains operable at large text',async t=>{
  const page=await fixture(t);await page.setViewportSize({width:320,height:568});
  await page.evaluate(async()=>{
    const {confirmPartialReplaySelection}=await import('/tools/partial-replay-selection.mjs');
    window.modalResult=confirmPartialReplaySelection({document,ready:[{}],failed:Array.from({length:9},(_,i)=>({row:{name:'Racer '+i+' '+ '<script>'.repeat(28)}})),isCurrent:()=>true,mode:'watch',returnFocus:document.querySelector('.watch')});
  });
  await proceed(page).waitFor();await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Shift+Tab');assert.equal(await chooser(page).locator('ul').evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Shift+Tab');assert.equal(await proceed(page).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Tab');assert.equal(await chooser(page).locator('ul').evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Tab');assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).evaluate(el=>el===document.activeElement),true);
  await chooser(page).evaluate(el=>el.style.fontSize='40px');
  await proceed(page).focus();
  assert.equal(await chooser(page).locator('.sq-partial-body').evaluate(el=>el.clientHeight>100&&el.scrollHeight>el.clientHeight),true,'large text retains a usable scrollable explanation');
  for (const button of await chooser(page).locator('button').all()) {
    assert.equal(await button.evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),true);
  }
  assert.equal(await chooser(page).evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  assert.equal(await chooser(page).locator('script').count(),0);
  await shot(page,'partial-replay-long-names-large-text');
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>modalResult),false);
  assert.equal(await page.locator('.watch').evaluate(el=>el===document.activeElement),true);
});

test('event Watch rechecks a selected replay and offers Skip & watch without silently removing it',async t=>{
  const page=await fixture(t,{event:true});await page.locator('.play').click();await proceed(page).waitFor();await proceed(page).click();
  await page.waitForFunction(()=>fixture.selected().length===2);
  await page.evaluate(()=>fixture.api.damageSelectedReplay());
  await page.locator('.watch').click();await proceed(page).waitFor();
  assert.equal(await proceed(page).textContent(),'Skip & watch');assert.equal(await page.evaluate(()=>fixture.selected().length),2);
  assert.equal(await page.evaluate(()=>stats.races.length),0);await shot(page,'event-watch-partial-desktop');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>fixture.selected().length),2);
  await page.locator('.watch').click();await proceed(page).waitFor();await proceed(page).click();
  await page.waitForFunction(()=>stats.races.length===1);
  assert.deepEqual(await page.evaluate(()=>stats.races[0]),[{name:'Event racer 1',frames:1001,isSelf:false}]);
  assert.equal(await page.evaluate(()=>fixture.selected().length),1);
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
  const page = await fixture(t, {allValid: true}); await page.locator('.watch').click(); await page.waitForFunction(() => stats.races.length === 1);
  assert.equal(await page.evaluate(() => fixture.selected().length), 3); assert.equal(await page.evaluate(() => stats.dispatched), 1); assert.equal(await chooser(page).count(), 0);
});
test('event mixed group uses real integrity/native parsers and waits for Continue', async t => {
  const page = await fixture(t, {event: true, corrupt: true}); await page.locator('.play').click(); await proceed(page).waitFor();
  assert.equal(await page.evaluate(() => fixture.api.pending()), 3); assert.equal(await page.evaluate(() => fixture.selected().length), 0);
  assert.match(await chooser(page).textContent(), /Saved PBs and points are unchanged/); assert.match(await chooser(page).textContent(), /1 of 3/); await shot(page, 'partial-event-replay');
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
    const names = ['handleModeratorSequence', 'handleRankedSearchShortcut', 'closeOverallPanel', 'handleArchivePageShortcut', 'handleOverallLeaderboardShortcut',
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
    window.openSnapshot = () => snapshot.showSnapshotUpdateResult({status: 'newer', generation:70}, {document,origin:document.querySelector('.watch')});
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
