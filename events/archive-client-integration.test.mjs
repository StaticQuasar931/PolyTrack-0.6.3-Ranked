import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {archivePeriodCounts, archiveSnapshotState} from './archive-view.mjs';
import {decorateEventRowPresentation, eventDisplayRunAt} from './client.mjs';

const source = fs.readFileSync(new URL('./client.mjs', import.meta.url), 'utf8');
const section = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'actual client function boundaries exist');
  return source.slice(a, b);
};
const period = {id: 'old-kodub', kind: 'kodub', trackId: 'a'.repeat(64), archived: true, racerCount: 21};
const row = {accountId: 'b'.repeat(64), name: 'Saved racer', timeMs: 1234, rank: 7, rp: 42};
const board = (changes = {}) => ({period: {...period}, entries: [{...row}], updatedAt: 1000,
  archived: false, _publicBackup: true, ...changes});

function navigationFixture() {
  const opened = [], messages = [], imports = [], state = {left: 0};
  const open = section('  async function openArchivedTrack(', '  async function loadArchivedBoard(');
  const context = {archiveSnapshotState, cache: new Map(), read: () => null, STORE: 'test',
    bridge: {accountId: () => 'viewer', openTrack: async id => {opened.push(id); return true;}},
    sessions: {leave() {state.left++;}}, knownPeriods: new Map(), close() {}, tick() {},
    message: text => messages.push(text), importArchived: async value => {imports.push(value); return true;},
    loadArchivedBoard: async () => {throw Error('No saved board');}};
  const api = vm.runInNewContext(`(()=>{let entryRequest=0,eventIntent=null,archiveIntent=null,
    nativeOpenPermit=false,dialog={},requestId=0;${open};return {openArchivedTrack,current:()=>archiveIntent};})()`, context);
  return {...api, opened, messages, imports, state};
}

test('archive dependencies use the current client cache revision', () => {
  const revision=JSON.parse(fs.readFileSync(new URL('../site-version.json',import.meta.url),'utf8')).revision;
  for(const [symbol,path] of [['archiveSnapshotState','./archive-view.mjs'],['readSavedArchiveTrack','./archive-track.mjs'],['confirmPartialReplaySelection','../tools/partial-replay-selection.mjs']]){
    const line=source.split('\n').find(line=>line.startsWith('import ')&&line.includes(symbol)&&line.includes(path));
    assert.ok(line,'Expected imported '+symbol);
    assert.ok(line.endsWith("from '"+path+'?v='+revision+"';"),'Dependency cache key must match current manifest: '+line);
  }
});

test('archive navigation rejects absent or mismatched event, kind, track and entry bindings before native navigation', async () => {
  for (const change of [
    b => {delete b.period;}, b => {delete b.period.id;}, b => {delete b.period.kind;},
    b => {delete b.period.trackId;}, b => {b.period.id = 'different';},
    b => {b.period.kind = 'daily';}, b => {b.period.trackId = 'c'.repeat(64);},
    b => {b.entries = null;}
  ]) {
    const f = navigationFixture(), saved = board(); change(saved);
    assert.equal(await f.openArchivedTrack(period, saved), false);
    assert.equal(f.opened.length, 0);
    assert.equal(f.state.left, 0);
    assert.equal(f.current(), null);
    assert.match(f.messages.at(-1), /do not match this event and track/);
  }
});

test('archive navigation preserves non-final and partial-final snapshots rather than promoting catalog finality', async () => {
  for (const changes of [{archived: false}, {archived: true, complete: false}, {archived: true, complete: true}]) {
    const f = navigationFixture(), saved = board(changes), before = structuredClone(saved);
    assert.equal(await f.openArchivedTrack(period, saved), true);
    assert.deepEqual(f.opened, [period.trackId]);
    assert.equal(f.current().snapshot, saved);
    assert.deepEqual(saved, before);
    assert.equal(f.current().archive, true);
  }
});

test('missing standings never become an invented empty board and selection-only practice stays independently importable', async () => {
  const f = navigationFixture();
  assert.equal(await f.openArchivedTrack(period, null), false);
  assert.equal(f.opened.length, 0);
  assert.equal(f.current(), null);
  assert.match(f.messages.at(-1), /Import saved track/);
  assert.equal(await f.openArchivedTrack({...period, historyOnly: true}, null), true);
  assert.equal(f.imports.length, 1);
  assert.equal(f.opened.length, 0);
});

test('archive loading preserves bound non-final captures and never falls back to live reads', async () => {
  const code = section('  async function snapshot(', '  function updateEventRefreshControl(');
  for (const changes of [{archived: false}, {archived: true, complete: false}, {archived: true, complete: true}]) {
    const saved = board(changes), cache = new Map(), writes = [];
    const context = {cache, snapshotFetching: new Map(), snapshotAttempts: new Map(), STORE: 'test',
      read: () => null, cacheWrite: (key, value) => writes.push({key, value}), now: () => 2000,
      bridge: {readArchivedSnapshot: async () => saved, readSnapshot: () => {throw Error('Live read forbidden');}}};
    const load = vm.runInNewContext(`${code};snapshot;`, context);
    const loaded = await load(period);
    assert.equal(loaded.archived, saved.archived);
    assert.equal(loaded.complete, saved.complete);
    assert.equal(cache.get(period.id), loaded);
    assert.equal(writes.length, 1);
    context.bridge.readArchivedSnapshot = async () => ({...saved, period: {...period, kind: 'daily'}});
    cache.clear();
    await assert.rejects(load(period), /Invalid saved archive snapshot/);
  }
});

function nativeFixture(snapshot) {
  const document = {createElement: () => element(), createTextNode: textContent => ({nodeType: 3, textContent})};
  function element() {
    return {nodeType: 1, ownerDocument: document, childNodes: [], dataset: {}, attributes: {},
      classList: {add() {}, toggle() {}},
      setAttribute(key, value) {this.attributes[key] = value;},
      append(...nodes) {this.childNodes.push(...nodes);},
      prepend(...nodes) {this.childNodes.unshift(...nodes);},
      replaceChildren(...nodes) {this.childNodes = nodes;},
      get textContent() {return this.childNodes.map(node => node.textContent).join('');},
      set textContent(value) {this.childNodes = [document.createTextNode(String(value))];}};
  }
  const nodes = Object.fromEntries(['h2', 'h3', '.total-players', '.container', '.pages'].map(key => [key, element()]));
  const rendered = [];
  const nativeBoard = {...element(), querySelector: selector => nodes[selector],
    querySelectorAll: () => nodes['.container'].childNodes.filter(node => node.dataset?.eventAccountId),
    __pt062EventRows: {version: 1, render(container, value) {
      const position = element(), status = element(), time = element();
      position.textContent = String(value.rank); status.append(document.createTextNode('Just now'));
      const button = {...element(), position, status, value,
        querySelector: selector => selector === '.left .position' ? position : selector === '.verified-state' ? status : time};
      rendered.push(button); container.append(button); return button;
    }}};
  const selectedGhosts = new Map([[row.accountId, {periodId: period.id, accountId: 'viewer', targetTimeMs: row.timeMs}]]);
  const context = {archivePeriodCounts, archiveSnapshotState, decorateEventRowPresentation, eventDisplayRunAt,
    document, selectedGhosts, pendingGhosts: new Map(), now: () => Date.now(),
    bridge: {watchEvent() {}, readArchivedReplay() {throw Error('Tests must not load recordings');}},
    displayName: value => value.name, eventName: () => 'Kodub weekly', selectReplay() {throw Error('Tests must not select replays');}};
  const adapter = section('function nativeEventRow(', 'export function handleEventCarIntersections(');
  const code = section('  function syncNativeArchiveBoard(', '  function syncNativeBoard(');
  const sync = vm.runInNewContext(`${adapter}\n${code};syncNativeArchiveBoard;`, context);
  const view = {period, snapshot, board: nativeBoard, watch: {}, accountId: 'viewer', page: 0};
  return {view, nodes, rendered, sync: () => sync(view)};
}

test('native non-final archive separates saved rows from entrants and never claims frozen final awards', () => {
  const saved = board(), before = structuredClone(saved), f = nativeFixture(saved); f.sync();
  assert.equal(f.nodes.h2.textContent, 'Saved non-final event standings');
  assert.match(f.nodes['.total-players'].textContent, /1 saved result \/ 21 event entrants/);
  assert.doesNotMatch(f.nodes.h3.title, /frozen|fresh data/i);
  assert.match(f.view.board.title, /not final awards/);
  assert.equal(f.rendered[0].value.rank, 7, 'preserve original saved rank instead of reranking the displayed subset');
  assert.equal(f.rendered[0].status.childNodes[0].textContent, '42 ERP (saved)');
  assert.deepEqual(saved, before);
});

test('native partial-final archive does not invent absent rank or RP, including null, strings and negative values', () => {
  for (const missing of [undefined, null, '7', -1]) {
    const saved = board({archived: true, complete: false, entries: [{...row, rank: missing, rp: missing}]}), f = nativeFixture(saved);
    f.sync();
    assert.equal(f.nodes.h2.textContent, 'Saved partial final event standings');
    assert.equal(f.rendered[0].value.rank, '');
    assert.equal(f.rendered[0].position.textContent, 'Rank unavailable');
    assert.equal(f.rendered[0].status.childNodes[0].textContent, 'ERP unavailable');
  }
  const f = nativeFixture(board({archived: true, complete: false, entries: [{...row, rank: 19, rp: 0}]})); f.sync();
  assert.equal(f.rendered[0].value.rank, 19);
  assert.equal(f.rendered[0].status.childNodes[0].textContent, '0 ERP');
});

test('native finality and entrant-count changes invalidate rendering even without timestamp or row changes', () => {
  const f = nativeFixture(board()); f.sync();
  const first = f.view.signature;
  f.view.snapshot.archived = true; f.sync();
  assert.notEqual(f.view.signature, first);
  assert.equal(f.nodes.h2.textContent, 'Frozen final event standings');
  f.view.snapshot.complete = false; f.sync();
  assert.equal(f.nodes.h2.textContent, 'Saved partial final event standings');
  f.view.snapshot.racerCount = 23; f.sync();
  assert.match(f.nodes['.total-players'].textContent, /23 event entrants/);
  assert.equal(f.rendered.length, 4);
});

test('native archive rejects a changed identity and clears rows instead of presenting stale final standings', () => {
  const f = nativeFixture(board({archived: true})); f.sync();
  assert.equal(f.view.watch.disabled, false);
  f.view.snapshot.period.trackId = 'c'.repeat(64); f.sync();
  assert.equal(f.nodes.h2.textContent, 'Standings unavailable');
  assert.equal(f.view.watch.disabled, true);
  assert.equal(f.nodes['.container'].childNodes.length, 1);
  assert.equal(f.nodes['.container'].childNodes[0].dataset.eventAccountId, undefined);
  assert.match(f.nodes['.container'].textContent, /do not match/);
});

test('native empty non-final and partial captures never claim zero final finishes', () => {
  for (const changes of [{archived: false}, {archived: true, complete: false}]) {
    const f = nativeFixture(board({...changes, entries: []})); f.sync();
    assert.match(f.nodes['.container'].textContent, /Final results are not known/);
    assert.doesNotMatch(f.nodes.h2.textContent, /Frozen/);
  }
});
