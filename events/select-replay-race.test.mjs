import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./client.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  async function selectReplay(');
const end = source.indexOf('  function raceGhosts(', start);
assert(start >= 0 && end > start, 'selectReplay source is available');
const selectReplaySource = source.slice(start, end);
const raceStart = source.indexOf('  function raceGhosts(');
const raceEnd = source.indexOf('  function resumeRace(', raceStart);
assert(raceStart >= 0 && raceEnd > raceStart, 'raceGhosts source is available');
const raceGhostsSource = source.slice(raceStart, raceEnd);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const session = { periodId: 'period', accountId: 'viewer' };
  let activeSession = session;
  let accountId = 'viewer';
  let ticks = 0;
  let prepares = 0;
  let clock = 1000;
  let preparationError = null;
  const reads = new Map();
  const messages = [];
  let displayRows = [];
  const bridge = {
    accountId: () => accountId,
    require: () => ({}),
    readReplay(_periodId, racerId) {
      const pending = deferred();
      reads.set(racerId, pending);
      return pending.promise;
    }
  };
  const context = vm.createContext({
    bridge,
    sessions: { current: () => activeSession },
    message: value => messages.push(value),
    displayName: row => row.name,
    nativeView: null,
    knownPeriods: new Map([['period', period]]),
    catalog: { periods: [period] },
    now: () => clock,
    eventDisplayRows: () => ({ rows: displayRows }),
    syncNativeBoard() {},
    tick: () => { ticks++; },
    preparePublishedEventGhost: async ({ row, entry }) => {
      prepares++;
      if (preparationError) throw preparationError;
      if (row.accountId !== entry.accountId || row.timeMs !== entry.timeMs || row.replayHash !== entry.replayHash) {
        throw Error('Published replay hash does not match standings.');
      }
      return { nickname: entry.name, racerId: entry.accountId };
    }
  });
  const api = vm.runInContext(`(()=>{let selectedGhost=null,replayRequest=0,topSelectionToken=0;const selectedGhosts=new Map(),pendingGhosts=new Map(),replayCache=new Map(),preparedGhosts=new Map(),replayFailures=new Map();${selectReplaySource};return {selectReplay,selectTopEventRows,selectEventRange,clearEventGhostSelection,selected:()=>selectedGhost,selectedCount:()=>selectedGhosts.size,pendingCount:()=>pendingGhosts.size};})()`, context);
  return {
    ...api,
    bridge,
    reads,
    messages,
    session,
    setAccount: value => { accountId = value; },
    setSession: value => { activeSession = value; },
    setClock: value => { clock = value; },
    setPreparationError: value => { preparationError = value; },
    setRows: value => { displayRows = value; },
    showNativeBoard: () => { context.nativeView = { periodId: 'period', page: 0, signature: '' }; },
    ticks: () => ticks,
    prepares: () => prepares
  };
}

test('top event shortcuts load a group and a second press clears it', async () => {
  const h = harness();
  const rows = [racer('first', 1200, 'First'), racer('second', 1300, 'Second'), racer('third', 1400, 'Third')];
  h.setRows(rows); h.showNativeBoard();
  const loading = h.selectTopEventRows(3);
  for (const row of rows) {
    while (!h.reads.has(row.accountId)) await new Promise(resolve => setImmediate(resolve));
    h.reads.get(row.accountId).resolve(payload(row));
  }
  await loading;
  assert.equal(h.selectedCount(), 3);
  assert.match(h.messages.at(-1), /3 of 3 top event ghosts ready/);
  await h.selectTopEventRows(3);
  assert.equal(h.selectedCount(), 0);
  assert.equal(h.messages.at(-1), 'Event ghosts unselected.');
  await h.selectTopEventRows(2);
  assert.equal(h.selectedCount(), 2);
  h.clearEventGhostSelection('period', 'viewer');
  assert.equal(h.selectedCount(), 0);
});

test('event range shortcuts load only the inclusive places and toggle the group', async () => {
  const h = harness();
  const rows = Array.from({ length: 6 }, (_, index) => racer(`racer-${index + 1}`, 1200 + index * 100, `Racer ${index + 1}`));
  h.setRows(rows);h.showNativeBoard();
  const loading = h.selectEventRange(3, 6);
  for (const row of rows.slice(2, 6)) {
    while (!h.reads.has(row.accountId)) await new Promise(resolve => setImmediate(resolve));
    h.reads.get(row.accountId).resolve(payload(row));
  }
  await loading;
  assert.equal(h.selectedCount(), 4);
  assert.equal(h.reads.size, 4);
  await h.selectEventRange(3, 6);
  assert.equal(h.selectedCount(), 0);
});

test('group selection marks every row pending immediately and starts reads concurrently', async () => {
  const h = harness();
  const rows = Array.from({ length: 4 }, (_, index) => racer(`racer-${index + 1}`, 1200 + index * 100, `Racer ${index + 1}`));
  h.setRows(rows); h.showNativeBoard();
  const loading = h.selectEventRange(1, 4);
  assert.equal(h.pendingCount(), 4);
  assert.equal(h.reads.size, 4);
  for (const row of rows) h.reads.get(row.accountId).resolve(payload(row));
  await loading;
  assert.equal(h.pendingCount(), 0);
  assert.equal(h.selectedCount(), 4);
});

test('ten-row shortcut cache retains payloads and prepared ghosts across reselection', async () => {
  const h = harness();
  const rows = Array.from({ length: 10 }, (_, index) => racer(`racer-${index + 1}`, 1200 + index * 100, `Racer ${index + 1}`));
  let reads = 0;
  h.bridge.readReplay = async (_periodId, accountId) => { reads++; return payload(rows.find(row => row.accountId === accountId)); };
  h.setRows(rows); h.showNativeBoard();
  await h.selectTopEventRows(10);
  assert.equal(h.selectedCount(), 10);
  assert.equal(reads, 10);
  assert.equal(h.prepares(), 10);
  await h.selectTopEventRows(10);
  await h.selectTopEventRows(10);
  assert.equal(h.selectedCount(), 10);
  assert.equal(reads, 10);
  assert.equal(h.prepares(), 10);
});

test('direct selection cancels an in-flight group without committing stale rows', async () => {
  const h = harness();
  const rows = Array.from({ length: 3 }, (_, index) => racer(`racer-${index + 1}`, 1200 + index * 100, `Racer ${index + 1}`));
  h.setRows(rows); h.showNativeBoard();
  const group = h.selectEventRange(1, 2);
  assert.equal(h.pendingCount(), 2);
  const direct = h.selectReplay(period, rows[2]);
  assert.equal(h.pendingCount(), 1);
  for (const row of rows) h.reads.get(row.accountId).resolve(payload(row));
  await Promise.all([group, direct]);
  assert.equal(h.selectedCount(), 1);
  assert.equal(h.selected().ghost.racerId, rows[2].accountId);
  assert.equal(h.pendingCount(), 0);
});

test('pressing a pending group shortcut again cancels the whole pending batch', async () => {
  const h = harness();
  const rows = [racer('first', 1200, 'First'), racer('second', 1300, 'Second')];
  h.setRows(rows); h.showNativeBoard();
  const first = h.selectTopEventRows(2);
  assert.equal(h.pendingCount(), 2);
  await h.selectTopEventRows(2);
  assert.equal(h.pendingCount(), 0);
  for (const row of rows) h.reads.get(row.accountId).resolve(payload(row));
  await first;
  assert.equal(h.selectedCount(), 0);
  assert.equal(h.messages.at(-1), 'Event ghosts unselected.');
});

test('a second pending click cancels the first pending visual state', async () => {
  const h = harness();
  const first = racer('first', 1200, 'First');
  const second = racer('second', 1300, 'Second');
  const oldRequest = h.selectReplay(period, first);
  assert.equal(h.pendingCount(), 1);
  const newRequest = h.selectReplay(period, second);
  assert.equal(h.pendingCount(), 1);
  h.reads.get('second').resolve(payload(second));
  await newRequest;
  h.reads.get('first').resolve(payload(first));
  await oldRequest;
  assert.equal(h.selectedCount(), 1);
  assert.equal(h.selected().ghost.racerId, 'second');
  assert.equal(h.pendingCount(), 0);
});

test('same pending replay toggles off without starting another read', async () => {
  const h = harness(), row = racer('racer', 1400, 'Racer');
  const request = h.selectReplay(period, row);
  assert.equal(h.pendingCount(), 1);
  await h.selectReplay(period, row);
  assert.equal(h.pendingCount(), 0);
  h.reads.get(row.accountId).resolve(payload(row));
  await request;
  assert.equal(h.selectedCount(), 0);
  assert.equal(h.reads.size, 1);
});

test('replay fetch failures are cooled down then retried after expiry', async () => {
  const h = harness(), row = racer('racer', 1400, 'Racer');
  let calls = 0;
  h.bridge.readReplay = async () => { calls++; throw Error('Replay service unavailable.'); };
  await h.selectReplay(period, row);
  await h.selectReplay(period, row);
  assert.equal(calls, 1);
  assert.match(h.messages.at(-1), /Replay service unavailable/);
  h.setClock(1000 + 5 * 60 * 1000 + 1);
  h.bridge.readReplay = async () => { calls++; return payload(row); };
  await h.selectReplay(period, row);
  assert.equal(calls, 2);
  assert.equal(h.selectedCount(), 1);
});

test('native ghost preparation failures are cooled down without another replay read', async () => {
  const h = harness(), row = racer('racer', 1400, 'Racer');
  let calls = 0;
  h.bridge.readReplay = async () => { calls++; return payload(row); };
  h.setPreparationError(Error('Replay failed native validation.'));
  await h.selectReplay(period, row);
  await h.selectReplay(period, row);
  assert.equal(calls, 1);
  assert.equal(h.prepares(), 1);
  assert.match(h.messages.at(-1), /native validation/);
});

test('an empty event group reports unavailable replays instead of a deselection', async () => {
  const h = harness();h.setRows([]);h.showNativeBoard();
  await h.selectTopEventRows(3);
  assert.equal(h.messages.at(-1), 'No playable replays in these places.');
});

const period = { id: 'period' };
const racer = (accountId, timeMs, name) => ({ accountId, timeMs, name, replayHash: `hash-${accountId}`, pending: false });
const payload = row => ({ accountId: row.accountId, timeMs: row.timeMs, replayHash: row.replayHash });

test('latest replay request wins when reads resolve out of order', async () => {
  const h = harness();
  const firstRow = racer('first', 1200, 'First');
  const latestRow = racer('latest', 1300, 'Latest');
  const first = h.selectReplay(period, firstRow);
  const latest = h.selectReplay(period, latestRow);
  h.reads.get('latest').resolve(payload(latestRow));
  await latest;
  h.reads.get('first').resolve(payload(firstRow));
  await first;
  assert.equal(h.selected().ghost.racerId, 'latest');
  assert.equal(h.messages.at(-1), 'Replay ready: Latest. Play to race this ghost.');
  assert.equal(h.ticks(), 3);
});

test('older rejection cannot replace the latest request success message', async () => {
  const h = harness();
  const firstRow = racer('first', 1200, 'First');
  const latestRow = racer('latest', 1300, 'Latest');
  const first = h.selectReplay(period, firstRow);
  const latest = h.selectReplay(period, latestRow);
  h.reads.get('latest').resolve(payload(latestRow));
  await latest;
  h.reads.get('first').reject(Error('Older replay unavailable.'));
  await first;
  assert.equal(h.selected().ghost.racerId, 'latest');
  assert.equal(h.messages.at(-1), 'Replay ready: Latest. Play to race this ghost.');
  assert(!h.messages.includes('Older replay unavailable.'));
});

test('latest validation failure is not overwritten by an older success', async () => {
  const h = harness();
  const firstRow = racer('first', 1200, 'First');
  const latestRow = racer('latest', 1300, 'Latest');
  const first = h.selectReplay(period, firstRow);
  const latest = h.selectReplay(period, latestRow);
  h.reads.get('latest').resolve({ ...payload(latestRow), replayHash: 'wrong-hash' });
  await latest;
  h.reads.get('first').resolve(payload(firstRow));
  await first;
  assert.equal(h.selected(), null);
  assert.equal(h.messages.at(-1), 'Published replay hash does not match standings.');
  assert.equal(h.ticks(), 3);
});

test('session and account changes still suppress replay selection', async () => {
  for (const change of ['account', 'session']) {
    const h = harness();
    const row = racer('racer', 1400, 'Racer');
    const request = h.selectReplay(period, row);
    if (change === 'account') h.setAccount('other-viewer');
    else h.setSession({ periodId: 'period', accountId: 'viewer' });
    h.reads.get('racer').resolve(payload(row));
    await request;
    assert.equal(h.selected(), null);
    assert.equal(h.pendingCount(), 0);
    assert.equal(h.ticks(), 2);
  }
});

test('client declaration owns one replay request counter', () => {
  assert.match(source, /selectedGhost=null,replayRequest=0,topSelectionToken=0,[^;]+;const selectedGhosts=new Map\(\),pendingGhosts=new Map\(\),replayCache=new Map\(\)/);
  assert.match(selectReplaySource, /const token=\+\+replayRequest/);
});

test('sequential replay selections accumulate and each one toggles off', async () => {
  const h = harness();
  const first = racer('first', 1200, 'First');
  const second = racer('second', 1300, 'Second');
  const p1 = h.selectReplay(period, first);
  h.reads.get('first').resolve(payload(first));
  await p1;
  const p2 = h.selectReplay(period, second);
  h.reads.get('second').resolve(payload(second));
  await p2;
  assert.equal(h.selectedCount(), 2);
  await h.selectReplay(period, first);
  assert.equal(h.selectedCount(), 1);
  assert.equal(h.selected().ghost.racerId, 'second');
});

test('waiting replay selection requests exact run and isolates verified cache',async()=>{
 const h=harness(),calls=[];
 const row={...racer('racer',1400,'Racer'),pending:true,runId:'a'.repeat(64)};
 h.bridge.readReplay=async(...args)=>{calls.push(args);return payload(row);};
 await h.selectReplay(period,row);
 assert.deepEqual(calls[0],[period.id,'racer',row.runId]);
 assert.equal(h.selected().ghost.racerId,'racer');
 assert.match(h.messages.at(-1),/unverified/);
 await h.selectReplay(period,{...row,pending:false,runId:undefined});
 assert.equal(calls.length,2);
 assert.equal(calls[1][2],null);
});

test('clicking the same event replay again unselects it without another download',async()=>{
 const h=harness(),row=racer('racer',1400,'Racer');
 const first=h.selectReplay(period,row);
 h.reads.get('racer').resolve(payload(row));
 await first;
 assert.equal(h.selected().targetAccountId,'racer');
 await h.selectReplay(period,row);
 assert.equal(h.selected(),null);
 assert.match(h.messages.at(-1),/unselected/);
  assert.equal(h.ticks(),3);
});

test('reselecting a validated event replay does not parse it again',async()=>{
 const h=harness(),row=racer('racer',1400,'Racer');
 const first=h.selectReplay(period,row);
 h.reads.get('racer').resolve(payload(row));
 await first;
 await h.selectReplay(period,row);
 await h.selectReplay(period,row);
 assert.equal(h.prepares(),1);
 assert.equal(h.selected().ghost.racerId,'racer');
});

test('local event ghost parses once until its replay or saved best changes',()=>{
 const replay={attemptId:'attempt-1',timeMs:1200,frames:1200,replay:'encoded-replay',carStyle:'encoded-style'};
 const best={attemptId:'attempt-1',timeMs:1200};
 const ghost={recording:{},carStyle:{},time:{numberOfFrames:1200},isSelf:true};
 let prepares=0;
 const context=vm.createContext({
  bridge:{supportsEventGhost:()=>true,require:()=>({})},
  knownPeriods:new Map([['period',period]]),
  eventDisplayRows:()=>({rows:[]}),
  getOwnReplay:()=>replay,
  bestRecords:{'period_viewer':best},
  prepareOwnEventGhost:()=>{prepares++;return ghost;}
 });
 const race=vm.runInContext(`(()=>{const selectedGhosts=new Map(),pendingGhosts=new Map(),preparedOwnGhosts=new Map();${raceGhostsSource};return raceGhosts;})()`,context);
 const session={periodId:'period',trackId:period.trackId,accountId:'viewer'};
 assert.equal(race(session).ownGhost,ghost);
 assert.equal(race(session).ownGhost,ghost);
 assert.equal(prepares,1,'repeated play/watch/resume preparation reuses the validated native replay');
 replay.replay='replacement-replay';
 assert.equal(race(session).ownGhost,ghost);
 assert.equal(prepares,2,'changed replay bytes are parsed and validated again');
 context.bestRecords.period_viewer={attemptId:'attempt-2',timeMs:1100};
 replay.attemptId='attempt-2';replay.timeMs=1100;replay.frames=1100;
 assert.equal(race(session).ownGhost,ghost);
 assert.equal(prepares,3,'changed PB identity is parsed and validated again');
});
