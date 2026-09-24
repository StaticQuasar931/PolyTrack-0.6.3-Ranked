import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./client.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  async function selectReplay(');
const end = source.indexOf('  function raceGhosts(', start);
assert(start >= 0 && end > start, 'selectReplay source is available');
const selectReplaySource = source.slice(start, end);

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
  const reads = new Map();
  const messages = [];
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
    tick: () => { ticks++; },
    preparePublishedEventGhost: async ({ row, entry }) => {
      if (row.accountId !== entry.accountId || row.timeMs !== entry.timeMs || row.replayHash !== entry.replayHash) {
        throw Error('Published replay hash does not match standings.');
      }
      return { nickname: entry.name, racerId: entry.accountId };
    }
  });
  const api = vm.runInContext(`(()=>{let selectedGhost=null,replayRequest=0;const selectedGhosts=new Map(),replayCache=new Map();${selectReplaySource};return {selectReplay,selected:()=>selectedGhost,selectedCount:()=>selectedGhosts.size};})()`, context);
  return {
    ...api,
    bridge,
    reads,
    messages,
    session,
    setAccount: value => { accountId = value; },
    setSession: value => { activeSession = value; },
    ticks: () => ticks
  };
}

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
  assert.equal(h.ticks(), 1);
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
  assert.equal(h.ticks(), 0);
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
    assert.equal(h.ticks(), 0);
  }
});

test('client declaration owns one replay request counter', () => {
  assert.match(source, /selectedGhost=null,replayRequest=0;const selectedGhosts=new Map\(\),replayCache=new Map\(\)/);
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
 assert.equal(h.ticks(),2);
});
