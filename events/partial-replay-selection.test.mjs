import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./client.mjs', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('  const replayContextActive='), source.indexOf('  function raceGhosts('));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {resolve, promise}; };
function harness(options = {}) {
  const period = {id: 'period', trackId: 'track'}, rows = [1, 2, 3].map(id => ({accountId: 'racer' + id, name: 'Racer ' + id, timeMs: 1000 + id, replayHash: 'hash' + id}));
  let session = {periodId: period.id, trackId: period.trackId, accountId: 'viewer'}, account = 'viewer', reads = 0, prompts = 0, prepares = 0, time = 0;
  const messages = [], view = {period, periodId: period.id, page: 0, root: {isConnected: true}};
  const context = vm.createContext({
    bridge: {accountId: () => account, require: () => ({}), readReplay: async (_period, id) => { reads++; return options.read ? options.read(id) : id === 'racer2' ? null : {id}; }},
    sessions: {current: () => session}, archiveIntent: null, nativeView: view, document: {activeElement: null},
    knownPeriods: new Map([[period.id, period]]), catalog: {periods: [period]}, eventDisplayRows: () => ({rows}), archivePeriodCounts: () => ({verifiedEntries: rows}),
    tick() {}, syncNativeBoard() {}, displayName: row => row.name, now: () => time, message: text => messages.push(text),
    preparePublishedEventGhost: async ({row, entry}) => { prepares++; if (!row) throw Error('missing'); if (options.prepare) await options.prepare(row); return {nickname: entry.name, id: entry.accountId}; },
    confirmPartialReplaySelection: data => { prompts++; return options.confirm ? options.confirm(data) : true; }
  });
  const api = vm.runInContext(`(()=>{let selectedGhost=null,replayRequest=0,topSelectionToken=0;const selectedGhosts=new Map(),pendingGhosts=new Map(),replayCache=new Map(),preparedGhosts=new Map(),replayFailures=new Map();${block};return {selectTopEventRows,selectReplay,clearEventGhostSelection,selected:()=>[...selectedGhosts.values()],pending:()=>pendingGhosts.size};})()`, context);
  return {...api, rows, period, messages, get reads() { return reads; }, get prompts() { return prompts; }, get prepares() { return prepares; }, clock: value => { time = value; }, change: what => {
    if (what === 'account') account = 'other'; else if (what === 'session') session = {...session}; else if (what === 'track') period.trackId = 'other';
    else if (what === 'page') view.page++; else if (what === 'standings') rows[0].replayHash = 'different';
    else if (what === 'navigation') view.root.isConnected = false; else if (what === 'selection') api.clearEventGhostSelection(period.id, account); else view.onlyVerified = true;
  }, archive: () => { context.archiveIntent = {...session, archive: true}; session = null; view.archive = true; view.snapshot = {}; context.bridge.readArchivedReplay = context.bridge.readReplay; context.bridge.readReplay = () => { throw Error('Unexpected live fallback'); }; }};
}
test('event mixed group remains pending and unselected until explicit Continue', async () => {
  const gate = deferred(); let offered;
  const h = harness({confirm: value => { offered = value; return gate.promise; }});
  const pending = h.selectTopEventRows(3);
  while (!offered) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.selected().length, 0); assert.equal(h.pending(), 3); assert.equal(offered.source, 'event');
  gate.resolve(true); await pending;
  assert.deepEqual(Array.from(h.selected(), row => row.ghost.nickname), ['Racer 1', 'Racer 3']); assert.equal(h.pending(), 0); assert.equal(h.reads, 3);
});
test('cancelled event batch keeps good replays cached but does not silently select them', async () => {
  const h = harness({confirm: () => false});
  await h.selectTopEventRows(3); await h.selectTopEventRows(3);
  assert.equal(h.selected().length, 0); assert.equal(h.pending(), 0); assert.equal(h.reads, 3); assert.equal(h.prepares, 2); assert.equal(h.prompts, 2);
});
test('event partial selection requires boolean consent, not a truthy response', async () => {
  const h = harness({confirm: () => 'yes'});
  await h.selectTopEventRows(3);
  assert.equal(h.selected().length, 0); assert.equal(h.pending(), 0); assert.equal(h.prompts, 1);
});
test('all missing event replays never offer Continue or live recovery', async () => {
  for (const archive of [false, true]) {
    const h = harness({read: () => null}); if (archive) h.archive();
    await h.selectTopEventRows(3); await h.selectTopEventRows(3);
    assert.equal(h.reads, 3); assert.equal(h.prompts, 0); assert.equal(h.selected().length, 0); assert.equal(h.pending(), 0);
    assert.match(h.messages.at(-1), /Saved event replays unavailable/); assert.match(h.messages.at(-1), /selection is unchanged/);
  }
});
for (const change of ['account', 'session', 'track', 'page', 'standings', 'navigation', 'selection', 'filter']) test(`event prompt rejects stale ${change}`, async () => {
  const gate = deferred(); let offered;
  const h = harness({confirm: value => { offered = value; return gate.promise; }});
  const loading = h.selectTopEventRows(3); while (!offered) await new Promise(resolve => setImmediate(resolve));
  h.change(change); assert.equal(offered.isCurrent(), false); gate.resolve(true); await loading;
  assert.equal(h.selected().length, 0); assert.equal(h.pending(), 0);
});
test('integrity or engine rejection stays unavailable, including after cancel and retry', async () => {
  const h = harness({read: id => ({id}), prepare: row => { if (row.id === 'racer2') throw Error('Event replay integrity check failed.'); }, confirm: () => false});
  await h.selectTopEventRows(3); await h.selectTopEventRows(3);
  assert.equal(h.prompts, 2); assert.equal(h.reads, 3); assert.equal(h.prepares, 3); assert.equal(h.selected().length, 0);
});
test('ineligible pending row is reported as failed, not silently filtered out of group', async () => {
  let offered; const h = harness({confirm: data => { offered = data; return true; }});
  h.rows[1].pending = true; h.rows[1].runId = 'invalid'; await h.selectTopEventRows(3);
  assert.equal(h.reads, 2); assert.equal(offered.failed.length, 1); assert.equal(h.selected().length, 2);
});
test('event partial Cancel and all-fail leave the previous selected group untouched', async () => {
  for (const allFail of [false, true]) {
    let fail = false;
    const h = harness({read: id => fail && (allFail || id === 'racer2') ? null : {id}, confirm: () => false});
    await h.selectReplay(h.period, h.rows[0]);
    const original = h.selected()[0];
    fail = true;
    if (allFail) h.rows[0] = {...h.rows[0], timeMs: 9999};
    await h.selectTopEventRows(3);
    assert.equal(h.selected().length, 1); assert.equal(h.selected()[0], original);
    assert.equal(h.pending(), 0);
  }
});
test('snapshot-only receipt reads remain zero across repeated event opens with existing bestRecords', async () => {
  const fn = source.slice(source.indexOf('  async function readReceipt('), source.indexOf('  function clearNativeView('));
  let calls = 0, clock = 1000;
  const ownReceipts = new Map(), ownReceiptAt = new Map(), ownReceiptRequests = new Map();
  const bestRecords = {period_self: {timeMs: 20000, attemptId: 'saved-attempt'}};
  const read = vm.runInNewContext('(' + fn + ')', {ownReceipts, ownReceiptAt, ownReceiptRequests, bestRecords, now: () => clock,
    bridge: {snapshotOnly: () => true, readOwnStatus: () => { calls++; throw Error('Unexpected live receipt read'); }}});
  for (let i = 0; i < 20; i++) { clock += 120000; assert.equal(await read('period', 'self'), null); }
  const cached = {status: 'verified', attemptId: 'saved-attempt'}; ownReceipts.set('period_self', cached);
  for (let i = 0; i < 20; i++) { clock += 120000; assert.equal(await read('period', 'self'), cached); }
  assert.equal(calls, 0); assert.equal(ownReceiptAt.size, 0); assert.equal(ownReceiptRequests.size, 0);
});
test('snapshot-only refresh control never advertises a countdown or cloud refresh', () => {
  const fn = source.slice(source.indexOf('  function updateEventRefreshControl('), source.indexOf('  function message('));
  const button = {disabled: false, textContent: 'Refresh in 60s', title: 'cloud requests'};
  const update = vm.runInNewContext('(' + fn + ')', {dialog: {querySelector: () => button}, selected: {id: 'period'},
    bridge: {snapshotOnly: () => true}, now: () => { throw Error('Countdown must not be evaluated'); }});
  for (let i = 0; i < 20; i++) update();
  assert.equal(button.disabled, true); assert.equal(button.textContent, 'Snapshot standings'); assert.equal(button.title, 'Standings update with the published snapshot.');
});
