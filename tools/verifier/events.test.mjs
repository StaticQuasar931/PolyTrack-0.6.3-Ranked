import test from 'node:test';
import assert from 'node:assert/strict';
import { runEventCoordinator, EVENT_JOB_LIMIT } from './events.mjs';
import { createSimilarityReviewer } from './similarity.mjs';
import { VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION } from '../../workers/ranked/src/verification.js';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventService, EVENT_COLLECTIONS as EC, EVENT_LIMITS as EL } from '../../workers/ranked/src/events.js';
import { createEventFirestoreStore, eventEncode, eventDecode } from '../../workers/ranked/src/events-store.js';
import { runVerifier } from './run.mjs';
import { drainVerification } from './throughput.mjs';

function fixture(counts, inboxCount = 0, unavailable = false) {
  let intakes = 0, native = 0;
  const batches = [];
  const runtime = { service: {
    processBatch: async (period, verify, limit) => {
      assert(limit <= 4);
      const count = Math.min(counts[period], limit); counts[period] -= count;
      if (!count) return [];
      batches.push({ period, count });
      const jobs = Array.from({ length: count }, (_, i) => ({ resultId: `${period}_${counts[period]}_${i}` }));
      return verify(jobs, { id: period, kind: 'custom', trackId: 'a'.repeat(64) });
    }, archivePeriod: async () => assert.fail('unexpected archive')
  }};
  const options = { verifyBatch: async (_root, jobs) => { native += jobs.length; return jobs.map(j => ({ ...j, reason: unavailable ? 'engine_unavailable' : 'native_exact_finish' })); },
    consumeInbox: async () => ({ consumed: intakes++ < inboxCount ? 1 : 0 }),
    readWork: async () => ({ periodIds: Object.keys(counts), archiveId: null }) };
  return { runtime, options, batches, native: () => native, intakes: () => intakes };
}
test('one event period can consume sixteen jobs in four bounded native batches', async () => {
  const f = fixture({ daily: 100 });
  const result = await runEventCoordinator(f.runtime, '/repo', f.options);
  assert.equal(EVENT_JOB_LIMIT, 16); assert.equal(result.checked, 16);
  assert.equal(f.native(), 16); assert.deepEqual(f.batches.map(b => b.count), [4, 4, 4, 4]);
});
test('daily and weekly share one global sixteen-job budget', async () => {
  const f = fixture({ daily: 100, weekly: 100 });
  const result = await runEventCoordinator(f.runtime, '/repo', f.options);
  assert.equal(result.checked, 16); assert.equal(f.native(), 16);
  assert.deepEqual(f.batches.map(b => b.period), ['daily', 'weekly', 'daily', 'weekly']);
});
test('caller shared native remainder bounds event work exactly', async () => {
  for (const limit of [1, 4, 7, 12, 16]) {
    const f = fixture({ daily: 100, weekly: 100 });
    assert.equal((await runEventCoordinator(f.runtime, '/repo', { ...f.options, limit })).checked, limit);
    assert.equal(f.native(), limit);
  }
});
test('intake stops on empty and never reads more than sixteen receipts', async () => {
  for (const count of [0, 3, 16, 100]) {
    const f = fixture({}, count);
    const result = await runEventCoordinator(f.runtime, '/repo', f.options);
    assert.equal(result.consumed, Math.min(count, 16));
    assert.equal(f.intakes(), Math.min(count + 1, 16));
  }
});
test('event intake is capped by native allowance even when caller requests sixteen receipts', async () => {
  for (const limit of [1,4,7,12,16]) {
    const f=fixture({daily:100},100);
    const result=await runEventCoordinator(f.runtime,'/repo',{...f.options,limit,intakeLimit:16});
    assert.equal(result.consumed,limit);
    assert.equal(f.intakes(),limit);
    assert.equal(result.checked,limit);
  }
  const f=fixture({daily:100},100);
  const result=await runEventCoordinator(f.runtime,'/repo',{...f.options,limit:4,intakeLimit:2});
  assert.equal(result.consumed,2);
  assert.equal(result.checked,4,'already admitted jobs remain eligible');
});
test('post-intake discovery does not rescan receipts or retries', async () => {
  const f=fixture({daily:4});
  let discoveries=0;
  await runEventCoordinator(f.runtime,'/repo',{...f.options,limit:4,
    readWork:async(_runtime,options)=>{
      discoveries++;
      assert.deepEqual(options,{inspectInbox:false});
      return {periodIds:['daily'],archiveId:null};
    }});
  assert.equal(discoveries,1);
});
test('invalid job and intake limits fail before any work', async () => {
  const f = fixture({ daily: 100 });
  for (const limit of [0, 17, 1.5]) await assert.rejects(runEventCoordinator(f.runtime, '/repo', { ...f.options, limit }), /limit/);
  await assert.rejects(runEventCoordinator(f.runtime, '/repo', { ...f.options, intakeLimit: 17 }), /limit/);
  assert.equal(f.intakes(), 0); assert.equal(f.native(), 0);
});
test('engine unavailable stops subsequent batches and preserves native reason', async () => {
  const f = fixture({ daily: 100, weekly: 100 }, 0, true);
  const result = await runEventCoordinator(f.runtime, '/repo', f.options);
  assert.equal(result.checked, 4); assert.equal(f.batches.length, 1);
  assert(result.results.every(r => r.reason === 'engine_unavailable'));
});
test('Kodub periods forward only the trusted period descriptor', async () => {
  const trackId = 'a'.repeat(64), codeHash = 'b'.repeat(64), code = 'PolyTrack2ABC';
  const period = { id: 'kodub_period', kind: 'kodub', trackId,
    kodub: { trackCode: code, trackCodeHash: codeHash } };
  const jobs = [{ resultId: 'kodub_result', trackId }];
  let calls = 0, invocation;
  const runtime = { service: {
    processBatch: async (_periodId, verify, limit) => {
      assert(limit <= 4);
      if (calls++) return [];
      return verify(jobs, period);
    },
    archivePeriod: async () => assert.fail('unexpected archive'),
  } };
  const result = await runEventCoordinator(runtime, '/repo', {
    consumeInbox: async () => ({ consumed: 0 }),
    readWork: async () => ({ periodIds: [period.id], archiveId: null }),
    verifyBatch: async (...args) => {
      invocation = args;
      return jobs.map(job => ({ ...job, reason: 'native_exact_finish' }));
    },
  });
  assert.equal(result.checked, 1);
  assert.deepEqual(invocation, ['/repo', jobs, [{ trackId, code, codeHash }]]);
});
test('Kodub periods reject mismatched leased job tracks before verification', async () => {
  const trackId = 'a'.repeat(64);
  const period = { id: 'kodub_period', kind: 'kodub', trackId,
    kodub: { trackCode: 'PolyTrack2ABC', trackCodeHash: 'b'.repeat(64) } };
  const runtime = { service: {
    processBatch: async (_periodId, verify) => verify([
      { resultId: 'kodub_result', trackId: 'c'.repeat(64) },
    ], period),
    archivePeriod: async () => assert.fail('unexpected archive'),
  } };
  await assert.rejects(runEventCoordinator(runtime, '/repo', {
    consumeInbox: async () => ({ consumed: 0 }),
    readWork: async () => ({ periodIds: [period.id], archiveId: null }),
    verifyBatch: async () => assert.fail('mismatched job must not reach verifier'),
  }), /Kodub verifier period mismatch/);
});

test('event exact-duplicate review runs on bound results before any event publication',async()=>{
  const trackId='a'.repeat(64), replayParts=[];
  const turns=Array.from({length:24},(_,i)=>100+i*200);
  const controls={lists:{up:[0],right:turns,down:[],left:[],reset:[]}};
  for(const list of Object.values(controls.lists)){
    const bytes=Buffer.alloc(3+list.length*3);bytes.writeUIntLE(list.length,0,3);
    list.forEach((tick,i)=>bytes.writeUIntLE(tick-(i?list[i-1]:0),3+i*3,3));replayParts.push(bytes);
  }
  const replay=deflateSync(Buffer.concat(replayParts)).toString('base64url');
  const replayHash=createHash('sha256').update(replay).digest('hex');
  const jobs=[
    {runId:'run-later',resultId:'run-later',accountId:'b'.repeat(64),trackId,timeMs:6000,replay,replayHash,receivedAt:200},
    {runId:'run-earlier',resultId:'run-earlier',accountId:'c'.repeat(64),trackId,timeMs:6000,replay,replayHash,receivedAt:100},
  ];
  const period={id:'daily',kind:'daily',trackId};
  const nativeResults=jobs.map(job=>({resultId:job.runId,status:'verified',trackId,timeMs:job.timeMs,replayHash,
    engineDigest:VERIFIER_ENGINE_DIGEST,trackContentHash:null,
    binding:{verifierVersion:VERIFIER_VERSION,resultId:job.runId,trackId,nativeTrackId:trackId,timeMs:job.timeMs,
      replayHash,actualReplayHash:replayHash,trackContentHash:null,engineDigest:VERIFIER_ENGINE_DIGEST}}));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'event-similarity-'));
  try{
    const reviewer=createSimilarityReviewer(root);let publishedResults,publicationComplete=false;const findings=[];
    const runtime={service:{processBatch:async(_period,verify)=>{
      publishedResults=await verify(jobs,period);
      publicationComplete=true;
      return publishedResults.map(row=>({...row}));
    },archivePeriod:async()=>assert.fail('unexpected archive')}};
    const result=await runEventCoordinator(runtime,root,{limit:2,consumeInbox:async()=>({consumed:0}),
      readWork:async()=>({periodIds:['daily'],archiveId:null}),verifyBatch:async()=>nativeResults,
      reviewSimilarity:reviewer,writeFinding:async(...args)=>{
        assert.equal(publicationComplete,true,'finding write must follow publication');findings.push(args);return true;
      }});
    assert.equal(result.checked,2);
    assert.equal(publishedResults[0].status,'mismatch');
    assert.equal(publishedResults[0].reason,'exact_duplicate_run');
    assert.equal(publishedResults[1].status,'verified','earliest trusted event receipt remains the winner');
    assert.equal(findings.length,1,'only the published exact duplicate is recorded');
    assert.equal(findings[0][1].runId,'run-later');assert.equal(findings[0][2].reason,'exact_duplicate_run');
    assert.equal(result.eventFindingsAdded,1);assert.equal(result.eventFindingWriteFailed,0);

    let mismatchedWrites=0;
    const mismatchedRuntime={service:{processBatch:async(_period,verify)=>{
      const rows=await verify(jobs,period);return rows.map((row,index)=>index===0?{...row,reason:'publication_reason_changed'}:{...row});
    },archivePeriod:async()=>assert.fail('unexpected archive')}};
    await runEventCoordinator(mismatchedRuntime,root,{limit:2,consumeInbox:async()=>({consumed:0}),
      readWork:async()=>({periodIds:['daily'],archiveId:null}),verifyBatch:async()=>nativeResults,
      reviewSimilarity:createSimilarityReviewer(root),writeFinding:async()=>{mismatchedWrites++;return true;}});
    assert.equal(mismatchedWrites,0,'unmatched publication results never create findings');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('event similarity guard lets sparse unavailable results defer without native proof fields',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'event-unavailable-'));
  try{
    const job={runId:'unavailable-run',resultId:'unavailable-run'};
    const runtime={service:{processBatch:async(_period,verify)=>verify([job],{id:'daily',kind:'daily'}),archivePeriod:async()=>assert.fail('unexpected archive')}};
    const result=await runEventCoordinator(runtime,root,{limit:1,consumeInbox:async()=>({consumed:0}),
      readWork:async()=>({periodIds:['daily'],archiveId:null}),verifyBatch:async()=>[{resultId:job.runId,status:'unavailable',reason:'engine_unavailable'}],
      reviewSimilarity:createSimilarityReviewer(root)});
    assert.equal(result.checked,1);
    assert.equal(result.results[0].reason,'engine_unavailable');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('intake alternates retry priority even under sustained fresh traffic', async () => {
  const f = fixture({}, 100), priorities = [];
  await runEventCoordinator(f.runtime, '/repo', { ...f.options,
    consumeInbox: async (_runtime, { preferRetry }) => { priorities.push(preferRetry); return { consumed: 1 }; } });
  assert.deepEqual(priorities, Array.from({ length: 16 }, (_, i) => i % 2 === 0));
});

test('budget exhaustion defers event work before any lease or discovery read',async()=>{
  const f=fixture({daily:10},100);
  f.options.readWork=async()=>assert.fail('discovery must be deferred');
  const result=await runEventCoordinator(f.runtime,'/repo',{...f.options,canSpend:()=>false});
  assert.equal(result.budgetDeferred,true);assert.equal(result.checked,0);assert.equal(result.archived,null);
  assert.equal(f.intakes(),0);assert.equal(f.native(),0);
});

test('sustained intake preserves request allowance for a leased event batch',async()=>{
  let remaining=400,intakes=0,batches=0;
  const runtime={service:{processBatch:async(_period,_verify,limit)=>{
    assert.ok(remaining>=136,'must reserve completion plus four possible findings before lease');remaining-=128;batches++;
    return Array.from({length:limit},()=>({reason:'native_exact_finish'}));
  },archivePeriod:async()=>{assert.ok(remaining>=24);remaining-=24;}}};
  const result=await runEventCoordinator(runtime,'/repo',{limit:4,canSpend:n=>n<=remaining,
    consumeInbox:async()=>{remaining-=48;intakes++;return {consumed:1};},
    readWork:async()=>{remaining-=24;return {periodIds:['daily'],archiveId:'old'};},
    verifyBatch:async()=>assert.fail('fixture batch simulates native accounting')});
  assert.equal(intakes,4);assert.equal(batches,1);assert.equal(result.checked,4);
  assert.equal(result.archived,'old');assert.equal(result.budgetDeferred,false);assert.equal(remaining,32);
});

test('insufficient discovery plus completion reserve performs no event reads or leases',async()=>{
  for (const remaining of [0,24,127,136,159]) {
    const f=fixture({daily:20});
    f.options.readWork=async()=>assert.fail('insufficient reserve must skip discovery');
    const result=await runEventCoordinator(f.runtime,'/repo',{...f.options,canSpend:n=>n<=remaining});
    assert.equal(f.intakes(),0);assert.equal(f.native(),0);assert.equal(f.batches.length,0);
    assert.equal(result.budgetDeferred,true);assert.equal(result.archived,null);
  }
});

test('exact discovery and completion reserve still processes already admitted work',async()=>{
  const f=fixture({daily:4});let remaining=160;
  const result=await runEventCoordinator(f.runtime,'/repo',{...f.options,limit:4,canSpend:n=>n<=remaining,
    readWork:async()=>{remaining-=24;return {periodIds:['daily'],archiveId:null};}});
  assert.equal(f.intakes(),0);assert.equal(result.checked,4);
  assert.equal(result.budgetDeferred,true,'new intake was deferred but queued work proceeds');
});

test('four-slot Catch-Up rounds rotate sustained periods even when discovery clock order is unchanged', async () => {
  const f = fixture({daily: 100, weekly: 100, older: 100});
  const selectionState = {};
  for (let i = 0; i < 12; i++) {
    const result = await runEventCoordinator(f.runtime, '/repo', {...f.options, limit: 4, selectionState});
    assert.equal(result.checked, 4);
  }
  assert.deepEqual(f.batches.map(batch => batch.period), Array.from({length: 4}, () => ['daily', 'weekly', 'older']).flat());
  assert.equal(f.intakes(), 12, 'No additional intake or discovery polling');
});

test('deferred event budgets do not advance the in-memory period cursor', async () => {
  const f = fixture({daily: 100, weekly: 100});
  const selectionState = {lastPeriodId: 'daily'};
  await runEventCoordinator(f.runtime, '/repo', {...f.options, limit: 4, selectionState, canSpend: () => false});
  assert.deepEqual(selectionState, {lastPeriodId: 'daily'});
  const result = await runEventCoordinator(f.runtime, '/repo', {...f.options, limit: 4, selectionState});
  assert.equal(result.checked, 4);
  assert.equal(f.batches[0].period, 'weekly');
});


test('aborted intake defers only event work without adding immediate retries',async()=>{
 const f=fixture({daily:10});let calls=0;
 const options={...f.options,consumeInbox:async()=>{if(calls++===0)return {consumed:1,rejected:false};throw Object.assign(Error('Firestore request failed: 409'),{status:409,code:'ABORTED'});},readWork:async()=>assert.fail('no more event reads after contention')};
 const result=await runEventCoordinator(f.runtime,'/repo',options);
 assert.equal(result.consumed,1);assert.equal(result.checked,0);assert.equal(result.conflictDeferred,true);assert.equal(result.budgetDeferred,true);assert.equal(f.native(),0);assert.equal(calls,2);
});

test('event intake never hides permission failures or ambiguous write outcomes',async()=>{
 for(const failure of [Object.assign(Error('denied'),{status:403,code:'PERMISSION_DENIED'}),Object.assign(Error('unavailable'),{status:503}),Error('timeout')]){
  const f=fixture({daily:10});await assert.rejects(runEventCoordinator(f.runtime,'/repo',{...f.options,consumeInbox:async()=>{throw failure;}}),e=>e===failure);
 }
});


const eventConflict = () => Object.assign(Error('Firestore request failed: 409'), { status: 409, code: 'ABORTED' });
const conflictVerdict = job => ({ ...job, status: 'verified', reason: 'native_exact_finish',
  engineDigest: VERIFIER_ENGINE_DIGEST, binding: { resultId: job.resultId, trackId: job.trackId,
    nativeTrackId: job.trackId, timeMs: job.timeMs, replayHash: job.replayHash, actualReplayHash: job.replayHash,
    engineDigest: VERIFIER_ENGINE_DIGEST, verifierVersion: VERIFIER_VERSION } });

// Real service and REST adapter; all transport state and native results stay in memory.
async function conflictFixture(stage) {
  const docs = new Map(), versions = new Map(), transactions = new Map(), failedTransactions = new Set();
  const stats = { native: 0, normalQueries: 0, rollbacks: 0, readOnlyRollbacks: 0, errorRollbacks: 0,
    rollbackFailures: 0, rollbackTransactions: [], completionAttempts: 0, committed: 0, aborts: 0 };
  const trackId = 'a'.repeat(64), periodId = 'conflict_day';
  const period = { id: periodId, enabled: true, trackId, startsAt: 1000, endsAt: 86401000, graceMs: 3600000,
    targetMs: 10000, maxRp: 1000, eligibility: 'best-submitted-during-period',
    capacity: { policyVersion: 'test-reviewed-v1', entrants: 200, admissionsPerPeriod: 512,
      replayBytesPerPeriod: 8388608, minIntervalMs: 1000, verificationsPerDay: 128 } };
  let now = 0, sequence = 0, armed = false;
  const failure = eventConflict();
  const request = async (route, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (route === ':beginTransaction') {
      const transaction = 'tx' + sequence++;
      transactions.set(transaction, new Set());
      return { transaction };
    }
    if (route === ':rollback') {
      assert.deepEqual(Object.keys(body), ['transaction']);
      assert.ok(transactions.has(body.transaction), 'rollback must close an active transaction exactly once');
      if (armed) {
        stats.rollbacks++; stats.rollbackTransactions.push(body.transaction);
        if (failedTransactions.has(body.transaction)) stats.errorRollbacks++;
        else if (stage === 'period-read' && [...transactions.get(body.transaction)].join() === EC.periods + '/' + periodId) {
          stats.aborts++; stats.rollbackFailures++; throw failure;
        } else stats.readOnlyRollbacks++;
      }
      transactions.delete(body.transaction); failedTransactions.delete(body.transaction); return {};
    }
    if (route === ':runQuery') { stats.normalQueries++; return []; }
    if (route.startsWith('/')) {
      const [key, query] = route.slice(1).split('?');
      transactions.get(new URLSearchParams(query).get('transaction'))?.add(key);
      return docs.has(key) ? { fields: eventEncode(docs.get(key)).mapValue.fields,
        updateTime: 'v' + (versions.get(key) || 0) } : null;
    }
    assert.equal(route, ':commit');
    assert.ok(body.writes.length > 0, 'read-only transactions must finish through rollback, never an empty commit');
    const keyOf = write => (write.update?.name || write.delete).split('/documents/')[1];
    const keys = body.writes.map(keyOf);
    const completion = keys.some(key => key.startsWith(EC.runs + '/'));
    if (armed && completion) stats.completionAttempts++;
    const kind = keys.some(key => key.startsWith(EC.archives + '/')) ? 'archive' : completion ? 'completion' :
      keys.includes(EC.quotas + '/verification_global') ? 'lease' : 'other';
    if (armed && (stage === kind || stage === 'completion2' && kind === 'completion' && stats.completionAttempts === 2)) {
      stats.aborts++;
      failedTransactions.add(body.transaction);
      throw failure;
    }
    for (const write of body.writes) {
      const key = keyOf(write);
      assert.deepEqual(write.currentDocument, docs.has(key) ?
        { updateTime: 'v' + (versions.get(key) || 0) } : { exists: false });
    }
    const next = new Map(docs);
    for (const write of body.writes) {
      const key = keyOf(write);
      if (write.delete) next.delete(key);
      else {
        const value = eventDecode({ mapValue: { fields: write.update.fields } });
        for (const transform of write.updateTransforms || []) {
          assert.equal(transform.setToServerValue, 'REQUEST_TIME');
          value[transform.fieldPath] = { __firestoreTimestamp: new Date(now).toISOString() };
        }
        next.set(key, write.updateMask ? { ...next.get(key), ...value } : value);
      }
    }
    docs.clear();
    for (const [key, value] of next) docs.set(key, value);
    for (const key of keys) versions.set(key, (versions.get(key) || 0) + 1);
    transactions.delete(body.transaction);
    if (armed && completion) stats.committed++;
    return {};
  };
  const serviceFor = transport => createEventService({
    store: createEventFirestoreStore({ request: transport, projectId: 'offline-event-tests', retries: 0 }),
    now: () => now, hash: value => createHash('sha256').update(value).digest('hex'),
    randomId: () => 'lease_' + sequence++,
  });
  const service = serviceFor(request);
  await service.createPeriod(period);
  now = period.startsAt;
  const runIds = [], accounts = ['b'.repeat(64), 'c'.repeat(64)];
  for (const [index, accountId] of accounts.entries()) {
    const ownerUid = 'owner' + index;
    docs.set(EC.profiles + '/' + accountId, { accountId, ownerUid, name: 'Racer ' + index });
    await service.bindOwner(ownerUid, accountId);
    const run = await service.submit(periodId, ownerUid, { accountId, trackId, attemptId: 'attempt' + index,
      timeMs: 20000 + index, frames: 20000 + index, replay: 'AAAA', carStyle: '' });
    runIds.push(run.runId);
  }
  now = stage === 'archive' ? period.endsAt + period.graceMs : 2500;
  armed = true;
  const db = { call: (route, body) => request(route, { body: JSON.stringify(body) }) };
  const eventRun = (bounded, root, options) => runEventCoordinator({ service: serviceFor((route, init) =>
    bounded.call(route, init?.body ? JSON.parse(init.body) : undefined)) }, root, { ...options,
    consumeInbox: async () => ({ consumed: 0 }),
    readWork: async () => ({ periodIds: [periodId], archiveId: stage === 'archive' ? periodId : null }),
    verifyBatch: async (_root, jobs) => { stats.native += jobs.length; return jobs.map(conflictVerdict); },
  });
  const run = ({ catchUp = false, drain = true } = {}) => runVerifier({ drain, catchUp, clock: () => 0,
    env: { FIREBASE_VERIFIER_SERVICE_ACCOUNT: 'offline-synthetic', GITHUB_EVENT_NAME: 'workflow_dispatch' },
    validateEngine: async () => {}, connectDatabase: async () => db, eventRun, log: () => {},
    prioritizeNormal: async (_db, rows) => rows,
    selectNormal: async () => assert.fail('normal selection must not continue after event conflict'),
    verifyNormal: async () => assert.fail('normal verification must not continue after event conflict'),
    publishNormal: async () => assert.fail('normal publication must not continue after event conflict'),
  });
  return { docs, stats, runIds, accounts, service, run, failure, periodId, trackId,
    disarm: () => { armed = false; }, expireLease: () => { now += EL.leaseMs; } };
}

for (const [stage, native, quota, committed, readOnlyRollbacks] of [
  ['lease', 0, 0, 0, 0], ['period-read', 0, 2, 0, 0], ['completion2', 2, 2, 1, 1], ['archive', 2, 2, 2, 2],
]) test(`real event ${stage} abort stops drain and Catch-Up without retry or invented counts`, async () => {
  for (const catchUp of [false, true]) {
    const f = await conflictFixture(stage);
    const summary = await f.run({ catchUp });
    assert.equal(summary.stop, 'event_conflict');
    assert.equal(summary.countsComplete, false);
    assert.equal(summary.interruptedRound, true);
    assert.equal(summary.rounds, 0);
    assert.equal(summary.processed, 0);
    assert.equal(summary.eventChecked, 0, 'interrupted-round work is unknown, not included in completed-round totals');
    assert.equal(summary.verified, 0);
    assert.equal(f.stats.native, native);
    assert.equal(f.stats.normalQueries, 0);
    assert.equal(f.stats.aborts, 1);
    assert.equal(f.stats.rollbacks, readOnlyRollbacks + 1);
    assert.equal(f.stats.readOnlyRollbacks, readOnlyRollbacks);
    assert.equal(f.stats.errorRollbacks, stage === 'period-read' ? 0 : 1);
    assert.equal(f.stats.rollbackFailures, stage === 'period-read' ? 1 : 0);
    assert.equal(new Set(f.stats.rollbackTransactions).size, f.stats.rollbacks, 'no transaction is rolled back twice');
    assert.equal(f.stats.committed, committed);
    assert.equal(f.stats.completionAttempts, native);
    assert.equal(f.docs.get(EC.quotas + '/verification_global')?.used || 0, quota);
    assert.deepEqual(f.runIds.map(id => f.docs.get(EC.runs + '/' + id).status),
      f.runIds.map((_, index) => index < committed ? 'verified' : 'waiting'));
    const queue = f.docs.get(EC.queues + '/' + f.periodId);
    assert.equal(queue.slots.length, 2 - committed);
    assert.ok(queue.slots.every(slot => slot.attempts === (stage === 'lease' ? 0 : 1)));
    assert.equal([...f.docs.keys()].filter(key => key.startsWith(EC.canonical + '/')).length, committed);
    assert.equal(f.docs.has(EC.archives + '/' + f.periodId), false);
    assert.notEqual(f.docs.get(EC.history + '/' + f.periodId)?.archived, true);
  }
});

test('event partial publication survives conflict and only unfinished work recovers after lease expiry', async () => {
  const f = await conflictFixture('completion2');
  assert.equal((await f.run()).stop, 'event_conflict');
  const firstTotal = structuredClone(f.docs.get(EC.totals + '/' + f.accounts[0]));
  const firstCanonical = structuredClone(f.docs.get(EC.canonical + '/' + f.accounts[0] + '_' + f.trackId));
  assert.ok(firstTotal.rp > 0);
  f.disarm();
  assert.deepEqual(await f.service.processBatch(f.periodId, async () => assert.fail('live lease cannot run again')), []);
  assert.equal(f.docs.get(EC.quotas + '/verification_global').used, 2);
  f.expireLease();
  let checked = 0;
  const recovered = await f.service.processBatch(f.periodId, async jobs => {
    checked += jobs.length;
    assert.deepEqual(jobs.map(job => job.resultId), [f.runIds[1]]);
    return jobs.map(conflictVerdict);
  });
  assert.equal(checked, 1);
  assert.equal(recovered.length, 1);
  assert.equal(f.docs.get(EC.quotas + '/verification_global').used, 3, 'no refund for the interrupted attempt');
  assert.deepEqual(f.docs.get(EC.totals + '/' + f.accounts[0]), firstTotal);
  assert.deepEqual(f.docs.get(EC.canonical + '/' + f.accounts[0] + '_' + f.trackId), firstCanonical);
  assert.equal(f.docs.get(EC.queues + '/' + f.periodId).slots.length, 0);
});

test('event archive abort preserves earlier publications and later archival is atomic and idempotent', async () => {
  const f = await conflictFixture('archive');
  assert.equal((await f.run()).stop, 'event_conflict');
  const canonical = () => [...f.docs].filter(([key]) => key.startsWith(EC.canonical + '/'));
  const before = structuredClone(canonical());
  assert.equal(before.length, 2);
  const catalog = () => f.docs.get(EC.catalog + '/main').periods.find(row => row.id === f.periodId);
  assert.notEqual(catalog().archived, true);
  f.disarm();
  assert.deepEqual(await f.service.archivePeriod(f.periodId), { archived: true, duplicate: false });
  assert.deepEqual(await f.service.archivePeriod(f.periodId), { archived: true, duplicate: true });
  assert.deepEqual(canonical(), before);
  assert.equal(catalog().archived, true);
  assert.equal(f.docs.get(EC.archives + '/' + f.periodId).settled, true);
  assert.equal(f.docs.get(EC.history + '/' + f.periodId).archived, true);
});

test('batch and archive deferral never hide permission, domain, malformed or ambiguous failures', async () => {
  const failures = [
    [403, 'PERMISSION_DENIED'], [409, 'event_lease_lost'], [409, 'event_binding_changed'],
    [409, 'event_settlement_open'], [409, 'FAILED_PRECONDITION'], [503, 'UNAVAILABLE'],
    [503, 'ABORTED'], ['409', 'ABORTED'], [409, undefined], [undefined, 'ABORTED'],
  ].map(([status, code]) => Object.assign(Error('Firestore request failed: 409 ABORTED'), { status, code }));
  failures.push(Error('timeout'));
  for (const phase of ['batch', 'archive']) for (const failure of failures) {
    let calls = 0;
    const fail = async () => { calls++; throw failure; };
    const runtime = { service: { processBatch: phase === 'batch' ? fail : async () => [], archivePeriod: fail } };
    await assert.rejects(drainVerification({ now: () => 0, requests: () => 0, log: () => {},
      runRound: () => runEventCoordinator(runtime, '/offline', {
        consumeInbox: async () => ({ consumed: 0 }),
        readWork: async () => ({ periodIds: phase === 'batch' ? ['daily'] : [], archiveId: 'old' }),
        verifyBatch: async () => assert.fail('native verification must not run'),
      }),
    }), error => error === failure);
    assert.equal(calls, 1);
  }
});

test('non-drain runner defers tagged event conflict without continuing normal work', async () => {
  const f = await conflictFixture('completion2');
  assert.deepEqual(await f.run({ drain: false }), {
    deferred: true, reason: 'event_conflict', interruptedRound: true, countsComplete: false,
  });
  assert.equal(f.stats.normalQueries, 0);
  assert.equal(f.stats.native, 2);
  assert.equal(f.stats.committed, 1);
  assert.equal(f.stats.aborts, 1);
  assert.equal(f.docs.get(EC.quotas + '/verification_global').used, 2);
});
