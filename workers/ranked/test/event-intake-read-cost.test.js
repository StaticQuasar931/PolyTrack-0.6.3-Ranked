import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../src/index.js';
import {eventRuntime, consumeEventInbox} from '../src/events-runtime.js';
import {eventPeriod, EVENT_COLLECTIONS as C} from '../src/events.js';
import {eventEncode, eventDecode} from '../src/events-store.js';
import {createFirestoreAudit, recordFirestoreReads} from '../src/firestore-read-cost.js';

const accountId = 'b'.repeat(64), trackId = 'a'.repeat(64);
const periodId = 'd_' + new Date().toISOString().slice(0,10).replaceAll('-','');
const base = 'projects/test-project/databases/(default)/documents/';
const origin = 'https://intake-audit.invalid';
const subject = periodId + '_' + accountId;
const body = {accountId, trackId, attemptId:'first', timeMs:20000, frames:20000, replay:'AAAA', carStyle:''};

function fixture(t) {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('network forbidden'));
  t.mock.method(console, 'log', () => {});
  const at = Date.now(), data = new Map(), versions = new Map(), transactions = new Map();
  let nonce = 0, audit = createFirestoreAudit(), calls = [], commitFailure = null;
  const period = eventPeriod({id:periodId, enabled:true, trackId, startsAt:at-10000,
    endsAt:at+86400000, graceMs:3600000, targetMs:10000, maxRp:100,
    eligibility:'best-submitted-during-period', capacity:{policyVersion:'intake-cost',
      entrants:200, admissionsPerPeriod:512, replayBytesPerPeriod:8388608,
      minIntervalMs:1000, verificationsPerDay:128}});
  const put = (key, value) => {data.set(key, structuredClone(value)); versions.set(key, 'v' + ++nonce);};
  put(C.periods+'/'+periodId, period);
  put(C.profiles+'/'+accountId, {accountId, ownerUid:'owner', name:'Racer'});
  put(C.owners+'/'+accountId, {accountId, ownerUid:'owner'});
  put(C.queues+'/'+periodId, {slots:[], runIds:[], subjects:[], admitted:0, entrants:0, replayBytes:0});
  const wire = (key, source=data, revision=versions) => ({name:base+key,
    updateTime:revision.get(key), fields:eventEncode(source.get(key)).mapValue.fields});
  const request = async (route, init={}) => {
    const input = init.body ? JSON.parse(init.body) : null;
    let result;
    calls.push(route);
    if (route === ':beginTransaction') {
      const transaction = 'tx' + ++nonce;
      transactions.set(transaction, {data:structuredClone(data), versions:new Map(versions), reads:new Set()});
      result = {transaction};
    } else if (route === ':rollback') {
      assert.ok(transactions.delete(input.transaction)); result = {};
    } else if (route === ':commit') {
      if (commitFailure) { const error = commitFailure; commitFailure = null; throw error; }
      const tx = transactions.get(input.transaction); assert.ok(tx);
      assert.ok(input.writes.length <= 16);
      for (const w of input.writes) {
        const key = (w.update?.name || w.delete).slice(base.length);
        assert.ok(w.currentDocument, 'every write retains a precondition');
        if (w.currentDocument.exists === false) assert.equal(data.has(key), false);
        else {
          assert.ok(tx.reads.has(key), 'updates and deletes require transaction reads');
          assert.equal(w.currentDocument.updateTime, versions.get(key), 'fresh CAS');
        }
      }
      for (const w of input.writes) {
        const key = (w.update?.name || w.delete).slice(base.length);
        if (w.delete) {data.delete(key); versions.delete(key);}
        else {
          const value = eventDecode({mapValue:{fields:w.update.fields}});
          put(key, w.updateMask ? {...data.get(key), ...value} : value);
        }
      }
      transactions.delete(input.transaction); result = {};
    } else if (route === ':runQuery') {
      const q = input.structuredQuery, collection = q.from[0].collectionId;
      assert.equal(q.limit, 1, 'no widened intake scans');
      assert.ok([C.inbox, C.retries].includes(collection));
      let keys = [...data.keys()].filter(key => key.startsWith(collection+'/'));
      if (collection === C.inbox) {
        keys.sort((a,b) => data.get(a).receivedAt.__firestoreTimestamp.localeCompare(data.get(b).receivedAt.__firestoreTimestamp) || a.localeCompare(b));
        if (q.startAt) keys = keys.filter(key => {
          const stamp = data.get(key).receivedAt.__firestoreTimestamp;
          return stamp > q.startAt.values[0].timestampValue || stamp === q.startAt.values[0].timestampValue && base+key > q.startAt.values[1].referenceValue;
        });
      } else keys = keys.filter(key => data.get(key).notBefore <= at);
      result = keys.slice(0,1).map(key => ({document:wire(key)}));
    } else {
      const [path, query] = route.split('?'), key = decodeURIComponent(path.slice(1));
      const txId = new URLSearchParams(query).get('transaction');
      const tx = txId ? transactions.get(txId) : null;
      if (txId) {
        assert.ok(tx); tx.reads.add(key); assert.ok(tx.reads.size <= 16);
      }
      const source = tx ? tx.data : data;
      result = source.has(key) ? wire(key, source, tx ? tx.versions : versions) : null;
    }
    recordFirestoreReads(audit, route, init, result); return result;
  };
  const runtime = eventRuntime(request, {projectId:'test-project', now:()=>at});
  const env = {EVENTS_ENABLED:'true', FIREBASE_PROJECT_ID:'test-project', ALLOWED_ORIGINS:origin,
    __TEST_UID:'owner', EVENT_RATE_LIMITER:{limit:async()=>({success:true})}, __TEST_FIRESTORE:request};
  const send = async (route, payload) => {
    const response = await handleRequest(new Request('https://worker.invalid/v1/events/'+periodId+'/'+route,
      {method:payload ? 'POST' : 'GET', headers:{Origin:origin, 'Content-Type':'application/json', 'CF-Connecting-IP':'127.0.0.1'},
        ...(payload ? {body:JSON.stringify(payload)} : {})}), env);
    return {status:response.status, body:await response.json()};
  };
  return {data, put, runtime, send, inbox:(value=body) => {
    const row = {...value, periodId, ownerUid:'owner', receivedAt:{__firestoreTimestamp:new Date(at).toISOString()}};
    put(C.inbox+'/'+subject, row); return row;
  }, failCommit:error=>{commitFailure=error;}, reset:()=>{audit=createFirestoreAudit(); calls=[];},
  cost:()=>({reads:audit.documentReadEstimate, writes:audit.writeEstimate, deletes:audit.deleteEstimate}),
  paths:()=>calls.filter(route=>route.startsWith('/')).map(route=>decodeURIComponent(route.slice(1).split('?')[0])),
  idle:()=>assert.equal(transactions.size,0)};
}

function expectCost(f, reads, writes, label) {
  assert.deepEqual(f.cost(), {reads, writes, deletes:0}); f.idle();
  process.stdout.write('EVENT_INTAKE_COST '+JSON.stringify({label, ...f.cost()})+'\n');
}
function noImprovement(f) {
  f.put(C.pbs+'/'+subject, {accountId, ownerUid:'owner', periodId, timeMs:15000});
  f.put(C.canonical+'/'+accountId+'_'+trackId, {accountId, ownerUid:'owner', trackId, timeMs:15000, frames:15000});
}

for (const [status,code] of [[409,'ABORTED'],[403,'PERMISSION_DENIED']])
test('failed inbox admission commit stays retryable without rejection writes: '+code,async t=>{
  const f=fixture(t); f.inbox();
  const before=structuredClone(f.data), failure=Object.assign(Error('backend failure'),{status,code});
  f.failCommit(failure);
  let caught;
  try { await consumeEventInbox(f.runtime); } catch(error) { caught=error; }
  process.stdout.write('EVENT_INFRASTRUCTURE_COST '+JSON.stringify({code,...f.cost()})+'\n');
  assert.equal(caught,failure);
  assert.deepEqual(f.data,before,'no terminal cursor, rejection, or partial admission');
  expectCost(f,15,0,'failed-admission-'+code);
  f.reset();
  assert.equal((await consumeEventInbox(f.runtime)).status,'waiting');
  expectCost(f,17,8,'recovered-admission-'+code);
  assert.equal(f.data.get(C.queues+'/'+periodId).admitted,1);
});

test('real Worker submission: admission, duplicate, and fresh ownership failure costs', async t => {
  const f = fixture(t);
  const admitted = await f.send('runs', body);
  assert.equal(admitted.status,202); assert.equal(admitted.body.status,'waiting');
  expectCost(f,11,6,'direct-admission-existing-owner');
  f.reset();
  assert.equal((await f.send('runs',body)).body.duplicate,true);
  expectCost(f,5,0,'direct-duplicate');
  assert.deepEqual(f.paths(), [C.periods+'/'+periodId, C.receipts+'/'+subject,
    C.owners+'/'+accountId, C.profiles+'/'+accountId, C.runs+'/'+admitted.body.runId]);
  f.put(C.profiles+'/'+accountId,{accountId, ownerUid:'new-owner'}); f.reset();
  assert.deepEqual(await f.send('runs',body),{status:403,body:{error:'profile_owner_changed'}});
  expectCost(f,4,0,'direct-duplicate-owner-changed');
});

test('real Worker no-improvement needs canonical and preserves archive/quota rejection ordering', async t => {
  const f = fixture(t); noImprovement(f);
  assert.equal((await f.send('runs',body)).body.status,'no_improvement');
  expectCost(f,9,0,'direct-no-improvement');
  assert.ok(f.paths().includes(C.canonical+'/'+accountId+'_'+trackId));
  assert.equal(f.paths().includes(C.queues+'/'+periodId),false);
  f.put(C.archives+'/'+periodId,{archivedAt:1}); f.reset();
  assert.equal((await f.send('runs',body)).body.error,'event_archived');
  expectCost(f,6,0,'direct-no-improvement-archived');
});

test('whole inbox duplicate includes discovery and final scan/retry CAS, not admission alone', async t => {
  const f = fixture(t), row = f.inbox();
  const admitted = await consumeEventInbox(f.runtime);
  assert.equal(admitted.status,'waiting'); expectCost(f,17,8,'inbox-admission-existing-owner');
  f.data.delete(C.cursors+'/scan'); f.reset();
  assert.equal((await consumeEventInbox(f.runtime)).duplicate,true);
  expectCost(f,8,1,'inbox-cursor-duplicate');
  assert.equal(f.paths().includes(C.profiles+'/'+accountId),false,'existing cursor fast path does not re-admit');
  f.data.delete(C.cursors+'/scan'); f.data.delete(C.cursors+'/'+subject); f.reset();
  assert.equal((await consumeEventInbox(f.runtime)).duplicate,true);
  expectCost(f,11,2,'inbox-existing-run-duplicate');
  assert.ok(f.paths().includes(C.profiles+'/'+accountId));
  assert.deepEqual(f.data.get(C.inbox+'/'+subject),row,'client inbox payload unchanged');
  assert.equal(f.data.get(C.queues+'/'+periodId).admitted,1);
});

test('whole inbox no-improvement costs include both durable cursors and preserve canonical state', async t => {
  const f = fixture(t); noImprovement(f); f.inbox();
  const canonical = structuredClone(f.data.get(C.canonical+'/'+accountId+'_'+trackId));
  assert.equal((await consumeEventInbox(f.runtime)).status,'no_improvement');
  expectCost(f,15,2,'inbox-no-improvement');
  assert.deepEqual(f.data.get(C.canonical+'/'+accountId+'_'+trackId),canonical);
  assert.equal(f.data.get(C.queues+'/'+periodId).admitted,0);
  f.reset(); assert.deepEqual(await consumeEventInbox(f.runtime),{consumed:0});
  expectCost(f,3,0,'inbox-empty-followup');
});

test('pending observation bundle is additive, read-only, and cannot manufacture proof or scoring', async t => {
  const f = fixture(t);
  const admitted = (await f.send('runs',body)).body; f.reset();
  assert.equal((await f.send('receipt?accountId='+accountId)).body.status,'waiting');
  expectCost(f,2,0,'pending-receipt');
  assert.equal((await f.send('runs/'+admitted.runId)).body.status,'waiting');
  expectCost(f,5,0,'pending-receipt-plus-status');
  const playback = (await f.send('playbacks/'+admitted.runId)).body;
  assert.equal(playback.verified,false); assert.equal(playback.eventRpEligible,false);
  expectCost(f,7,0,'pending-receipt-status-playback');
  const snapshot = (await f.send('snapshot')).body;
  assert.equal(snapshot.pendingPlaybacks.length,1); assert.deepEqual(snapshot.entries,[]);
  expectCost(f,10,0,'pending-receipt-status-playback-snapshot');
  process.stdout.write('EVENT_PENDING_PATHS '+JSON.stringify(f.paths())+'\n');
  assert.equal(f.data.has(C.canonical+'/'+accountId+'_'+trackId),false);
  assert.equal(f.data.has(C.pbs+'/'+subject),false);
});
