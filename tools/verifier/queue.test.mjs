import test from 'node:test';
import assert from 'node:assert/strict';
import {queueState,reconciledSlot,completedSlot,NEVER} from './queue.mjs';
import {encode,decode} from './firestore.mjs';
import {pendingSlot,VERIFIER_ENGINE_DIGEST,VERIFICATION_COLLECTION,EXTRA_VERIFICATION_COLLECTION,verificationCollectionForTrack} from '../../workers/ranked/src/verification.js';
import {EXTRA_TRACK_IDS} from '../../workers/ranked/src/extra-track-ids.js';
import {createHash} from 'node:crypto';
const row={accountId:'racer',trackId:'track',timeMs:1000,frames:1000,uploadId:1,replayHash:'a'.repeat(64)};
test('missing canonical work leaves the due queue instead of looping forever',()=>{const slot=reconciledSlot(pendingSlot(row),null);assert.equal(queueState({racer:slot}).notBefore,NEVER);});
test('a superseding PB replaces the exact queued binding',()=>{const slot=pendingSlot(row),next={...row,timeMs:900};assert.deepEqual(reconciledSlot(slot,next),pendingSlot(next));});
test('approval requires the pinned engine',()=>{assert.throws(()=>completedSlot(pendingSlot(row),{status:'verified',engineDigest:'wrong'}));assert.equal(completedSlot(pendingSlot(row),{status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST}).status,'verified');});
test('unavailable work retries with a bounded daily backoff',()=>{let slot=pendingSlot(row);for(let i=0;i<3;i++)slot=completedSlot(slot,{status:'unavailable'},100);assert.equal(slot.retryAt,100+604800000);assert.equal(queueState({racer:slot}).pending,true);});
test('Firestore round trip preserves timestamps, decimals and zero',()=>{const x={time:new Date('2026-09-10T00:00:00.000Z'),score:1.52,zero:0,none:null};assert.deepEqual(decode(encode(x)),x);});

test('infrastructure failure never consumes player attempts',()=>{const slot=completedSlot(pendingSlot(row),{status:'unavailable',reason:'isolate_terminated'},100);assert.equal(slot.attempts,0);assert.equal(slot.retryAt,3600100);});
test('missing trusted tracks and scan limits remain waiting with explicit bounded retry',()=>{
  for(const reason of ['missing_trusted_track','scan_work_limit']) {
    const slot=completedSlot(pendingSlot(row),{status:'unavailable',reason},100);
    assert.equal(slot.status,'unavailable');
    assert.equal(slot.attempts,1);
    assert.equal(slot.retryAt,86400100);
    assert.equal(queueState({racer:slot},100).notBefore,86400100);
  }
});
test('served tracks rotate behind already due tracks',()=>assert.equal(queueState({racer:pendingSlot(row)},1234).notBefore,1234));

test('terminal-only and pruned-empty queues cannot starve waiting tracks',()=>{const now=1234,terminal=completedSlot(pendingSlot(row),{status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST},now);const boards=[queueState({racer:terminal},now),queueState({},now),queueState({racer:pendingSlot(row)},now)];assert.deepEqual(boards.map(b=>b.notBefore),[NEVER,NEVER,now]);assert.equal(boards.filter(b=>b.notBefore<=now).length,1);});


import {prioritizeQueueDocuments, selectJobs, publishResults, isConflict, TRACK_AGING_MS} from './runner.mjs';
const queueDoc = (trackId, rows) => ({updateTime: 'v1', data: {trackId,
  slots: Object.fromEntries(rows.map(r => [r.accountId, pendingSlot({...r, trackId})]))}});
const fakeWrite = (collection, id, data, prior) => ({collection, id, data, prior});

test('track scheduling prefers weight while reserving an aged queue and uses one summary read', async () => {
  const now = 10 * TRACK_AGING_MS;
  const docs = [queueDoc('old-low', [row]), queueDoc('recent-high', [row]), queueDoc('recent-medium', [row])];
  docs[0].data.notBefore = now - TRACK_AGING_MS;
  docs[1].data.notBefore = docs[2].data.notBefore = now;
  const weight = new Map([['old-low', 1], ['recent-high', 9], ['recent-medium', 4]]);
  let calls = 0;
  const db = {get: async (collection, id) => {
    calls++; assert.equal(collection, '0.6.2_s1_leaderboards_overall'); assert.equal(id, 'main');
    return {data: {trackSummaries: [...weight].map(([trackId, value]) => ({trackId, weight: value}))}};
  }};
  assert.deepEqual((await prioritizeQueueDocuments(db, docs, now)).map(doc => doc.data.trackId),
    ['old-low', 'recent-high', 'recent-medium']);
  docs[0].data.notBefore = now;
  assert.deepEqual((await prioritizeQueueDocuments(db, docs, now)).map(doc => doc.data.trackId),
    ['recent-high', 'recent-medium', 'old-low']);
  assert.equal(calls, 2);
  const fallback = await prioritizeQueueDocuments({get: async () => { throw Error('optional read failed'); }}, docs, now);
  assert.equal(fallback, docs);
});

test('selection reserves the least recently checked run, then fastest runs, and fills sparse tracks', async () => {
  const now = 100000;
  const rows = Array.from({length: 9}, (_, index) => ({...row, accountId: 'racer-' + index,
    timeMs: 1000 + index * 1000, frames: 1000 + index * 1000, uploadId: index + 1}));
  const first = queueDoc('track-a', rows);
  first.data.slots['racer-8'].checkedAt = 1;
  for (let index = 0; index < 8; index++) first.data.slots['racer-' + index].checkedAt = now;
  const sparse = [first, queueDoc('track-b', [{...row, accountId: 'other'}]),
    queueDoc('track-c', [{...row, accountId: 'third'}])];
  const canonical = new Map();
  for (const doc of sparse) for (const slot of Object.values(doc.data.slots)) {
    const parsed = JSON.parse(slot.key);
    canonical.set(slot.resultId, {data: {accountId: slot.accountId, trackId: doc.data.trackId,
      timeMs: parsed[4], frames: parsed[5], uploadId: parsed[6], replayHash: parsed[7]}});
  }
  const result = await selectJobs({get: async (_, id) => canonical.get(id), write: fakeWrite, call: async () => {}}, sparse, now);
  assert.equal(result.jobs[0].accountId, 'racer-8');
  assert.deepEqual(result.jobs.slice(1, 8).map(job => job.timeMs), [1000, 2000, 3000, 4000, 5000, 6000, 7000]);
  assert.deepEqual(result.jobs.slice(8).map(job => job.trackId), ['track-b', 'track-c']);
  assert.equal(result.canonicalAttempts, 10);
});

test('runner bounds missing canonical lookups to eight per track and sixteen total', async () => {
  const rows = Array.from({length: 500}, (_, i) => ({...row, accountId: 'r'+i}));
  const docs = ['track-a','track-b','track-c'].map(t => queueDoc(t, rows));
  let reads = 0;
  const writes = [];
  const result = await selectJobs({get: async () => {reads++; return null;}, write: fakeWrite,
    call: async (_, body) => writes.push(...body.writes)}, docs, 100);
  assert.equal(reads, 16);
  assert.equal(result.canonicalAttempts, 16);
  assert.equal(result.jobs.length, 0);
  assert.equal(writes.length, 2);
  assert.equal(Object.values(writes[0].data.slots).filter(s => s.reason === 'canonical_missing').length, 8);
  assert.equal(writes[0].data.pending, true);
});

test('selection conflict defers the affected track but preserves other selected work', async () => {
  const docs = ['track-a', 'track-b'].map(t => queueDoc(t, [row]));
  const result = await selectJobs({write: fakeWrite,
    get: async (_, id) => ({data: {...row, trackId: id.endsWith('track-a') ? 'track-a' : 'track-b', timeMs: 900}}),
    call: async (_, body) => {if (body.writes[0].id === 'track-a') throw Error('Firestore request failed: 412');}
  }, docs, 100);
  assert.equal(result.selectionConflicts, 1);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].trackId, 'track-b');
  assert.equal(result.jobs[0].timeMs, 900);
});

test('selection ignores future retries and surfaces non-conflict errors', async () => {
  const doc = queueDoc('track-a', [row]);
  doc.data.slots.racer = {...doc.data.slots.racer, status: 'unavailable', retryAt: 200};
  let reads = 0;
  const db = {get: async () => {reads++; return null;}, write: fakeWrite, call: async () => {}};
  assert.equal((await selectJobs(db, [doc], 100)).canonicalAttempts, 0);
  assert.equal(reads, 0);
  db.call = async () => {throw Error('Firestore request failed: 403');};
  await assert.rejects(selectJobs(db, [doc], 100), /403/);
  assert.equal(isConflict({status: 409}), true);
  assert.equal(isConflict(Error('Firestore request failed: 412')), true);
  assert.equal(isConflict(Error('Firestore request failed: 503')), false);
});

test('publication retries conflicts with fresh reads and continues after bounded exhaustion', async () => {
  const rows = ['track-a', 'track-b'].map(trackId => ({...row, trackId}));
  const jobs = rows.map(r => ({...r, resultId: r.accountId+'_'+r.trackId, queueKey: pendingSlot(r).key}));
  const results = jobs.map(j => ({resultId: j.resultId, status: 'verified', engineDigest: VERIFIER_ENGINE_DIGEST}));
  let attemptsA = 0, completedB = 0, queueReads = 0;
  const db = {write: fakeWrite, get: async (collection, id) => {
    if (collection === '0.6.2_s1_verification') {queueReads++; return queueDoc(id, [row]);}
    if (collection === '0.6.2_race_results') return {data: rows.find(r => id.endsWith(r.trackId))};
    if (collection === '0.6.2_s1_worker_jobs') return {data: {pendingTrackIds: ['keep'], cursorDocumentId: 'keep-cursor'}};
    return null;
  }, call: async (_, {writes}) => {
    assert.equal(writes.length, 3);
    assert.equal(writes[1].data.cursorDocumentId, 'keep-cursor');
    assert.ok(writes[1].data.pendingTrackIds.includes('keep'));
    if (writes[0].id === 'track-a') {attemptsA++; throw Error('Firestore request failed: 409');}
    completedB++;
  }};
  const totals = await publishResults(db, jobs, results);
  assert.equal(attemptsA, 3);
  assert.equal(completedB, 1);
  assert.equal(queueReads, 4);
  assert.equal(totals.deferred, 1);
  assert.equal(totals.verified, 1);
});

test('publication never approves superseded bindings and propagates non-conflict failures', async () => {
  const job = {...row, resultId: 'racer_track', queueKey: pendingSlot(row).key};
  const result = {resultId: job.resultId, status: 'verified', engineDigest: VERIFIER_ENGINE_DIGEST};
  const db = {write: fakeWrite, get: async collection => collection === '0.6.2_s1_verification' ? queueDoc('track', [row]) :
    collection === '0.6.2_race_results' ? {data: {...row, timeMs: 900}} : null,
    call: async () => {throw Error('must not write');}};
  assert.equal((await publishResults(db, [job], [result])).superseded, 1);
  db.get = async collection => collection === '0.6.2_s1_verification' ? queueDoc('track', [row]) :
    collection === '0.6.2_race_results' ? {data: row} : null;
  db.call = async () => {throw Error('Firestore request failed: 403');};
  await assert.rejects(publishResults(db, [job], [result]), /403/);
});


import {legacyTimingFrames, verificationKey, bootstrapSlots} from '../../workers/ranked/src/verification.js';

test('legacy detector accepts only exact integer conversion and rejects ambiguous frame fields', () => {
  for (const [timeMs, frames] of [[340033,20402], [1393183,83591], [325050,19503]]) {
    assert.equal(legacyTimingFrames({timeMs, frames}), frames);
    assert.equal(legacyTimingFrames({timeMs, raceTimeFrames: frames}), frames);
  }
  for (const invalid of [{timeMs:340034,frames:20402},{timeMs:20402,frames:20402},
    {timeMs:0,frames:0},{timeMs:340033,frames:'20402'},{timeMs:340033,frames:20402.1},
    {timeMs:340033,frames:20402,raceTimeFrames:20403}]) assert.equal(legacyTimingFrames(invalid),null);
});

const legacy = {...row, timeMs:340033, frames:20402, raceTimeFrames:20402, timingVersion:1,
  pbCount:17, pbAt:1780000000000, totalPlaytimeMs:991234, nickname:'Keep me', ownerUid:'owner',
  ingestedAt:new Date('2026-09-12T00:00:00.123Z'), replay:'unaltered-replay'};

async function correctionJobs(canonical = legacy) {
  const selected = await selectJobs({get:async()=>({data:canonical}), write:fakeWrite,
    call:async()=>{}},[queueDoc(canonical.trackId,[canonical])],100);
  return selected.jobs;
}

function correctionFixture(canonical = legacy, failCommit = false) {
  const commits = [];
  let reads = 0;
  const db = {write:fakeWrite,get:async(collection,id)=> {
    reads++;
    if(collection==='0.6.2_s1_verification') return queueDoc(canonical.trackId,[canonical]);
    if(collection==='0.6.2_race_results') return {data:canonical,updateTime:'canonical-exact-revision'};
    if(collection==='0.6.2_s1_worker_jobs') return {data:{pendingTrackIds:['existing'],cursorDocumentId:'keep'}};
    return null;
  },call:async(_,body)=>{commits.push(body.writes);if(failCommit)throw Error('Firestore request failed: 409');}};
  return {db,commits,reads:()=>reads};
}

function correctionVerdict(job,status='verified') {
  return {resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,
    status,engineDigest:VERIFIER_ENGINE_DIGEST,reason:status==='verified'?'native_match':'time_limit'};
}

test('selection simulates raw legacy frames with original key and overwrites forged stored candidate markers',async()=>{
  const [job]=await correctionJobs({...legacy,correctionCandidate:{frames:1}});
  assert.equal(job.timeMs,20402);
  assert.equal(job.queueKey,verificationKey(legacy));
  assert.deepEqual(job.correctionCandidate,{frames:20402,originalTimeMs:340033});
  assert.equal(job.replay,legacy.replay);
  const normal={...legacy,timeMs:20402,correctionCandidate:{frames:1}};
  assert.equal((await correctionJobs(normal))[0].correctionCandidate,null);
});

test('exact native correction publishes only the corrected binding with one guarded masked canonical write',async()=>{
  const jobs=await correctionJobs();
  const f=correctionFixture();
  const totals=await publishResults(f.db,jobs,[correctionVerdict(jobs[0])]);
  assert.equal(totals.corrected,1);
  assert.equal(totals.verified,1);
  assert.equal(f.commits.length,1);
  const writes=f.commits[0];
  assert.equal(writes.length,4);
  const canonical=writes.find(w=>w.collection==='0.6.2_race_results');
  assert.deepEqual(canonical.data,{timeMs:20402,timingVersion:2});
  assert.deepEqual(canonical.updateMask,{fieldPaths:['timeMs','timingVersion']});
  assert.equal(canonical.prior.updateTime,'canonical-exact-revision');
  assert.deepEqual({...legacy,...canonical.data},{...legacy,timeMs:20402,timingVersion:2});
  const key=verificationKey({...legacy,timeMs:20402,timingVersion:2});
  assert.notEqual(key,jobs[0].queueKey);
  assert.equal(writes[0].data.slots.racer.key,key);
  assert.equal(writes[0].data.slots.racer.status,'verified');
  const audit=writes.find(w=>w.collection==='0.6.2_s1_verification_audit');
  assert.equal(audit.data.key,key);
  assert.equal(audit.data.correctedFromKey,jobs[0].queueKey);
  assert.equal(writes[1].data.cursorDocumentId,'keep');
  assert.deepEqual(writes[1].data.pendingTrackIds,['existing','track']);
});

test('waiting and mismatched native candidates never change canonical time or approve the old binding',async()=>{
  const jobs=await correctionJobs();
  for(const status of ['unavailable','mismatch']) {
    const f=correctionFixture();
    const totals=await publishResults(f.db,jobs,[correctionVerdict(jobs[0],status)]);
    assert.equal(totals.corrected,0);
    assert.equal(totals.verified,0);
    assert.equal(f.commits[0].length,3);
    assert.equal(f.commits[0][0].data.slots.racer.key,verificationKey(legacy));
    const slot = f.commits[0][0].data.slots.racer;
    assert.equal(slot.status,'unavailable');
    if (status === 'mismatch') {
      assert.equal(slot.reason,'legacy_time_unconfirmed');
      assert.equal(slot.nativeReason,'time_limit');
      assert.equal(totals.mismatch,0);
      assert.equal(totals.unavailable,1);
      assert.equal(totals.reasons.legacy_time_unconfirmed,1);
      assert.ok(slot.retryAt < NEVER);
      assert.equal(f.commits[0].find(w=>w.collection==='0.6.2_s1_verification_audit').data.nativeReason,'time_limit');
    }
    assert.ok(!f.commits[0].some(w=>w.collection==='0.6.2_race_results'));
  }
});

test('publication revalidates candidate math, simulation binding and engine; forged candidates cannot repair',async()=>{
  const [job]=await correctionJobs();
  for(const forged of [{...job,correctionCandidate:{frames:1,originalTimeMs:340033}},
    {...job,correctionCandidate:null},{...job,timeMs:340033},
    {...job,correctionCandidate:{frames:20402,originalTimeMs:340034}}]) {
    const f=correctionFixture();
    assert.equal((await publishResults(f.db,[forged],[correctionVerdict(forged)])).corrected,0);
    assert.equal(f.commits.length,0);
  }
  for(const change of [{timeMs:340033},{trackId:'other'},{replayHash:'wrong'}]) {
    const f=correctionFixture();
    await publishResults(f.db,[job],[{...correctionVerdict(job),...change}]);
    assert.equal(f.commits.length,0);
  }
  const f=correctionFixture();
  await assert.rejects(publishResults(f.db,[job],[{...correctionVerdict(job),engineDigest:'wrong'}]),/engine pin/);
  assert.equal(f.commits.length,0);
  const ordinary={...legacy,timeMs:20402};
  const normalJob={...ordinary,resultId:'racer_track',queueKey:verificationKey(ordinary),correctionCandidate:{frames:20402,originalTimeMs:20402}};
  const ordinaryFixture=correctionFixture(ordinary);
  await publishResults(ordinaryFixture.db,[normalJob],[correctionVerdict(normalJob)]);
  assert.equal(ordinaryFixture.commits.length,0);
});

test('canonical correction conflicts remain atomic and a superseding PB cancels stale correction',async()=>{
  const jobs=await correctionJobs();
  const conflict=correctionFixture(legacy,true);
  const totals=await publishResults(conflict.db,jobs,[correctionVerdict(jobs[0])]);
  assert.equal(totals.corrected,0);
  assert.equal(totals.deferred,1);
  assert.equal(conflict.commits.length,3);
  assert.ok(conflict.commits.every(writes=>writes.length===4));
  const newer=correctionFixture({...legacy,timeMs:19000,uploadId:2});
  assert.equal((await publishResults(newer.db,jobs,[correctionVerdict(jobs[0])])).superseded,1);
  assert.equal(newer.commits.length,0);
});

test('versioned bootstrap wakes only matching legacy limit failures while preserving attempts and verified verdicts',()=>{
  const old=pendingSlot(legacy);
  for(const reason of ['time_limit','scan_work_limit']) {
    const slot={...old,status:'unavailable',reason,retryAt:NEVER-1,attempts:7};
    const repaired=bootstrapSlots('track',[legacy],{racer:slot}).racer;
    assert.equal(repaired.status,'waiting');
    assert.equal(repaired.attempts,7);
    assert.equal(repaired.key,old.key);
    assert.ok(!('retryAt' in repaired));
  }
  for(const slot of [{...old,status:'verified',reason:'time_limit'},
    {...old,status:'mismatch',reason:'time_limit'}, {...old,status:'unavailable',reason:'engine_unavailable'}]) {
    assert.equal(bootstrapSlots('track',[legacy],{racer:slot}).racer,slot);
  }
  const ordinary={...legacy,timeMs:20402};
  const slot={...pendingSlot(ordinary),status:'unavailable',reason:'time_limit',attempts:2,retryAt:NEVER-1};
  assert.equal(bootstrapSlots('track',[ordinary],{racer:slot}).racer,slot);
});


import {firestoreFailure} from './firestore.mjs';
test('structured precondition failures retry without exposing backend messages or treating all 400s as conflicts',async()=>{
  const conflict=await firestoreFailure(new Response(JSON.stringify({error:{status:'FAILED_PRECONDITION',message:'private backend detail'}}),{status:400}));
  assert.equal(conflict.code,'FAILED_PRECONDITION');
  assert.equal(isConflict(conflict),true);
  assert.equal(conflict.message,'Firestore request failed: 400');
  const invalid=await firestoreFailure(new Response(JSON.stringify({error:{status:'INVALID_ARGUMENT'}}),{status:400}));
  assert.equal(isConflict(invalid),false);
  assert.equal(isConflict(await firestoreFailure(new Response('not-json',{status:503}))),false);
  const jobs=await correctionJobs();
  const f=correctionFixture();
  let attempts=0;
  const commit=f.db.call;
  f.db.call=async(...args)=>{if(attempts++===0)throw conflict;return commit(...args);};
  assert.equal((await publishResults(f.db,jobs,[correctionVerdict(jobs[0])])).corrected,1);
  assert.equal(attempts,2);
});


import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {checkForWork, runVerifier} from './run.mjs';

test('idle preflight checks both lanes and emits a no-work summary without physics or writes', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'polytrack-idle-test-'));
  const env={FIREBASE_VERIFIER_SERVICE_ACCOUNT:'synthetic-test-only',
    GITHUB_OUTPUT:path.join(directory,'output'),GITHUB_STEP_SUMMARY:path.join(directory,'summary')};
  const calls=[],logs=[];
  let connections=0;
  try {
    const result=await runVerifier({check:true,env,eventCheck:async()=>({hasWork:false}),log:message=>logs.push(message),
      validateEngine:async()=>{throw Error('Idle preflight must not load engine assets');},
      connectDatabase:async raw=>{connections++;assert.equal(raw,'synthetic-test-only');return {
        call:async(p,body)=>{calls.push({p,body});return [{readTime:'2026-09-12T00:00:00Z'}];},
        get:async()=>{throw Error('No canonical reads');},write:()=>{throw Error('No writes');}
      };}});
    assert.equal(connections,1);assert.equal(calls.length,2);
    assert.deepEqual(calls.map(call=>call.body.structuredQuery.from[0].collectionId),[VERIFICATION_COLLECTION,EXTRA_VERIFICATION_COLLECTION]);
    for(const call of calls){
      assert.equal(call.p,':runQuery');
      const query=call.body.structuredQuery;
      assert.equal(query.limit,20);
      assert.deepEqual(query.select,{fields:[{fieldPath:'notBefore'},{fieldPath:'slots'}]});
      assert.equal(query.where.fieldFilter.field.fieldPath,'notBefore');
      assert.equal(query.where.fieldFilter.op,'LESS_THAN_OR_EQUAL');
      assert.equal(query.orderBy[0].field.fieldPath,'notBefore');
    }
    assert.equal(result.hasWork,false);
    assert.equal(fs.readFileSync(env.GITHUB_OUTPUT,'utf8'),'has_work=false\n');
    const summary=fs.readFileSync(env.GITHUB_STEP_SUMMARY,'utf8');
    assert.match(summary,/No verification work is due/);
    assert.match(summary,/Future-dated retries/);
    assert.ok(!summary.includes('synthetic-test-only'));
    assert.ok(!JSON.stringify(logs).includes('synthetic-test-only'));
    assert.ok(!('FIREBASE_VERIFIER_SERVICE_ACCOUNT' in env));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('preflight detects due work without counting racers and passes a deterministic query cutoff',async()=>{
  let queries=0;
  const result=await checkForWork({call:async(_,body)=>{
    queries++;assert.equal(body.structuredQuery.where.fieldFilter.value.integerValue,'1234');
    return queries===1?[{document:{name:'queue/track',fields:{notBefore:{integerValue:'1234'}}}}]:[];
  }},{now:1234,env:{},eventCheck:async()=>({hasWork:false}),log:()=>{}});
  assert.deepEqual(result,{hasWork:true,normalHasWork:true,coreHasWork:true,extraHasWork:false,eventHasWork:false,queueQueries:2,returnedDocuments:1,
    queueSample:{queuedRuns:0,averageOverdueAgeMs:0,sampledQueueDocuments:1,sampleLimitPerLane:20,truncated:false}});
  assert.equal(queries,2);
});

test('Extra selection and publication stay in the Extra collection with one lookup',async()=>{
  const doc=queueDoc('track',[row]);doc.queueCollection=EXTRA_VERIFICATION_COLLECTION;
  let canonicalReads=0,committed;
  const db={write:fakeWrite,get:async(collection)=>{
    if(collection==='0.6.2_race_results'){canonicalReads++;return {data:row};}
    if(collection===EXTRA_VERIFICATION_COLLECTION)return doc;
    return null;
  },call:async(_,body)=>{committed=body.writes;}};
  const selected=await selectJobs(db,[doc],100,{jobLimit:1,lookupLimit:1,perTrackLimit:1});
  assert.equal(canonicalReads,1);assert.equal(selected.jobs.length,1);
  assert.equal(selected.jobs[0].queueCollection,EXTRA_VERIFICATION_COLLECTION);
  const result={resultId:selected.jobs[0].resultId,status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST};
  assert.equal((await publishResults(db,selected.jobs,[result])).verified,1);
  assert.equal(committed[0].collection,EXTRA_VERIFICATION_COLLECTION);
});

test('Extra-only work wakes preflight while legacy core remains independently visible',async()=>{
  const seen=[];
  const result=await checkForWork({call:async(_,body)=>{
    const collection=body.structuredQuery.from[0].collectionId;seen.push(collection);
    return collection===EXTRA_VERIFICATION_COLLECTION?[{document:{name:'extra/track',fields:{}}}]:[];
  }},{now:1234,env:{},eventCheck:async()=>({hasWork:false}),log:()=>{}});
  assert.deepEqual(seen,[VERIFICATION_COLLECTION,EXTRA_VERIFICATION_COLLECTION]);
  assert.equal(result.coreHasWork,false);assert.equal(result.extraHasWork,true);
  assert.equal(result.hasWork,true);
  assert.equal(verificationCollectionForTrack('legacy-core-id'),VERIFICATION_COLLECTION);
});

test('all 200 pinned catalog IDs use the Extra lane',()=>{
  const ids=[...EXTRA_TRACK_IDS].sort();
  assert.equal(ids.length,200);
  assert.ok(ids.every(id=>/^[a-f0-9]{64}$/.test(id)));
  assert.equal(createHash('sha256').update(ids.join(',')).digest('hex'),
    'add9204438ea6bb8782c9eeef91cb256ca4d9a93f32f7d5ef522a141f98d674c');
  assert.ok(ids.every(id=>verificationCollectionForTrack(id)===EXTRA_VERIFICATION_COLLECTION));
});

test('eight older Extra queues cannot hide core work and Extra selection remains last',async()=>{
  const queries=[],selections=[],published=[];
  const extraIds=[...EXTRA_TRACK_IDS];
  await runVerifier({env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'synthetic'},log:()=>{},
    validateEngine:async()=>{},connectDatabase:async()=>({
      call:async(_,body)=>{
        const query=body.structuredQuery,collection=query.from[0].collectionId;
        queries.push([collection,query.limit]);
        return Array.from({length:8},(_,i)=>({document:{name:collection+'/'+i,
          fields:{trackId:{stringValue:collection===EXTRA_VERIFICATION_COLLECTION?extraIds[i]:'core-'+i},notBefore:{integerValue:'1'}}}}));
      },get:async()=>null,requests:()=>2
    }),eventRun:async()=>({checked:4,consumed:0,rejected:false,archived:null,results:[]}),
    selectNormal:async(_,docs,__,limits)=>{
      const collection=docs[0].queueCollection;
      selections.push([collection,docs.length,limits.jobLimit,limits.lookupLimit]);
      const jobs=Array.from({length:limits.jobLimit},(_,i)=>({resultId:collection+'-'+i,queueCollection:collection}));
      return {jobs,canonicalAttempts:jobs.length,selectionConflicts:0};
    },verifyNormal:async(_,jobs)=>jobs.map(job=>({resultId:job.resultId,status:'verified'})),
    publishNormal:async(_,jobs)=>{published.push(...jobs.map(job=>job.queueCollection));return {verified:jobs.length,reasons:{}};}
  });
  assert.deepEqual(queries,[[VERIFICATION_COLLECTION,8],[EXTRA_VERIFICATION_COLLECTION,8]]);
  assert.deepEqual(selections,[[VERIFICATION_COLLECTION,8,11,11],[EXTRA_VERIFICATION_COLLECTION,8,1,1]]);
  assert.deepEqual(published,[...Array(11).fill(VERIFICATION_COLLECTION),EXTRA_VERIFICATION_COLLECTION]);
});

test('preflight reports bounded Core and Extra queued-run count and overdue-age proxy',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'polytrack-queue-health-'));
  const summaryPath=path.join(directory,'summary');
  try {
    const result=await checkForWork({call:async(_,body)=>{
      const extra=body.structuredQuery.from[0].collectionId===EXTRA_VERIFICATION_COLLECTION;
      return [{document:{fields:{notBefore:{integerValue:String(extra?850000:900000)},slots:{mapValue:{fields:{
        a:{mapValue:{fields:{status:{stringValue:'waiting'}}}},
        b:{mapValue:{fields:{status:{stringValue:'unavailable'},retryAt:{integerValue:'9999999999999999'}}}},
        done:{mapValue:{fields:{status:{stringValue:'verified'}}}}
      }}}}}}];
    }},{now:1000000,env:{GITHUB_STEP_SUMMARY:summaryPath},eventCheck:async()=>({hasWork:false}),log:()=>{}});
    assert.deepEqual(result.queueSample,{queuedRuns:2,averageOverdueAgeMs:125000,sampledQueueDocuments:2,sampleLimitPerLane:20,truncated:false});
    const summary=fs.readFileSync(summaryPath,'utf8');
    assert.match(summary,/bounded sample, not an exact total/);
    assert.match(summary,/2 queued runs across Core and Extra; average overdue age 2.1 minutes/);
    assert.match(summary,/proxy from queue notBefore/);
    assert.match(summary,/sample did not reach its cap/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('preflight marks queue-health samples that reach a lane cap as possibly truncated',async()=>{
  const result=await checkForWork({call:async()=>Array.from({length:20},()=>({document:{fields:{
    notBefore:{integerValue:'100'},slots:{mapValue:{fields:{}}}
  }}}))},{now:100,env:{},eventCheck:async()=>({hasWork:false}),log:()=>{}});
  assert.equal(result.queueSample.sampledQueueDocuments,40);
  assert.equal(result.queueSample.truncated,true);
});

test('idle core work lends all available verification slots to Extra runs',async()=>{
  const ids=[...EXTRA_TRACK_IDS];let selected=0,verified=0;
  await runVerifier({env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'synthetic'},log:()=>{},borrowUnusedEvents:true,
    validateEngine:async()=>{},connectDatabase:async()=>({
      call:async(_,body)=>body.structuredQuery.from[0].collectionId===EXTRA_VERIFICATION_COLLECTION?
        ids.slice(0,6).map((trackId,i)=>({document:{name:'extra/'+i,fields:{trackId:{stringValue:trackId},notBefore:{integerValue:'1'}}}})):[],
      get:async()=>null,requests:()=>2
    }),eventRun:async()=>({checked:0,consumed:0,rejected:false,archived:null,results:[]}),
    selectNormal:async(_,docs,__,limits)=>{if(!docs.length)return {jobs:[],canonicalAttempts:0,selectionConflicts:0};selected=limits.jobLimit;return {jobs:docs.map((doc,i)=>({resultId:'extra-'+i,queueCollection:doc.queueCollection})),canonicalAttempts:docs.length,selectionConflicts:0};},
    verifyNormal:async(_,jobs)=>jobs.map(job=>({resultId:job.resultId,status:'verified'})),
    publishNormal:async(_,jobs)=>{verified=jobs.length;return {verified:jobs.length,reasons:{}};}
  });
  assert.equal(selected,16);
  assert.equal(verified,6);
});

test('processing refuses misrouted core or Extra documents until backfill is correct',async()=>{
  for(const [collection,trackId] of [[VERIFICATION_COLLECTION,[...EXTRA_TRACK_IDS][0]],
    [EXTRA_VERIFICATION_COLLECTION,'not-registered']]) {
    let selected=false;
    await assert.rejects(runVerifier({env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'synthetic'},log:()=>{},
      validateEngine:async()=>{},connectDatabase:async()=>({call:async(_,body)=>
        body.structuredQuery.from[0].collectionId===collection?
          [{document:{name:collection+'/'+trackId,fields:{trackId:{stringValue:trackId},notBefore:{integerValue:'1'}}}}]:[],
      requests:()=>2}),eventRun:async()=>({checked:0,consumed:0,rejected:false,archived:null,results:[]}),
      selectNormal:async()=>{selected=true;throw Error('Must not select misrouted work');}}),/EXTRA_QUEUE_BACKFILL_REQUIRED/);
    assert.equal(selected,false);
  }
});

test('preflight errors fail closed rather than producing a false empty-queue success',async()=>{
  await assert.rejects(checkForWork({call:async()=>{throw Error('Firestore request failed: 403');}},
    {env:{},log:()=>{throw Error('Must not report no work');}}),/403/);
  await assert.rejects(checkForWork({call:async()=>null},{env:{},log:()=>{}}),/Unexpected verification queue response/);
  await assert.rejects(checkForWork({call:async(_,body)=>{
    if(body.structuredQuery.from[0].collectionId===EXTRA_VERIFICATION_COLLECTION)throw Error('Extra queue read failed');
    return [{document:{}}];
  }},{env:{},log:()=>{throw Error('Must not report partial work');}}),/Extra queue read failed/);
});

test('processing mode still validates engine before authentication or queue access',async()=>{
  let connected=false;
  await assert.rejects(runVerifier({env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'synthetic'},
    validateEngine:async()=>{throw Error('pin mismatch');},
    connectDatabase:async()=>{connected=true;}}),/pin mismatch/);
  assert.equal(connected,false);
});

test('workflow keeps all expensive steps due-gated and credentials restricted to preflight and processing',()=>{
  const workflow=fs.readFileSync(new URL('../../.github/workflows/verify-runs.yml',import.meta.url),'utf8');
  assert.match(workflow,/cron: '7,22,37,52 \* \* \* \*'/);
  assert.match(workflow,/contents: read/);
  assert.match(workflow,/persist-credentials: false/);
  assert.match(workflow,/cancel-in-progress: false/);
  assert.match(workflow,/default_branch/);
  for(const name of ['Install pinned verifier dependencies','Test verifier safeguards','Install Chromium',
    'Allow the pinned browser sandbox on Ubuntu','Verify queued runs']) {
    const step=workflow.split('- name: '+name)[1]?.split('      - name:')[0];
    assert.ok(step,name);
    assert.match(step,/if: steps.queue.outputs.has_work == 'true'/,name);
  }
  assert.equal((workflow.match(/FIREBASE_VERIFIER_SERVICE_ACCOUNT:/g)||[]).length,2);
  assert.ok(!workflow.includes('repository_dispatch'));
});

test('event-only work wakes preflight and both sources are checked when normal work exists', async () => {
  for (const normal of [false, true]) {
    let checks=0;
    const result=await checkForWork({call:async()=>normal?[{document:{}}]:[]},
      {env:{},now:1234,log:()=>{},eventCheck:async(_,options)=>{
        checks++;assert.equal(options.now,1234);return {hasWork:true};
      }});
    assert.equal(checks,1);assert.equal(result.hasWork,true);
    assert.equal(result.normalHasWork,normal);assert.equal(result.eventHasWork,true);
  }
});

test('event preflight failures never masquerade as no work', async () => {
  for (const eventCheck of [async()=>null,async()=>({}),async()=>{throw Error('event query failed');}]) {
    await assert.rejects(checkForWork({call:async()=>[]},{env:{},log:()=>{},eventCheck}));
  }
});

test('event work processes with normal queue empty without invoking normal physics', async () => {
  const calls=[];
  await runVerifier({env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'synthetic'},log:()=>{},
    validateEngine:async()=>{calls.push('pin');},
    connectDatabase:async()=>({call:async()=>{calls.push('normal-query');return [];}}),
    eventRun:async(_,root,options)=>{
      assert.equal(options.limit,4);assert.equal(options.intakeLimit,16);
      assert.equal(root,path.resolve(fileURLToPath(new URL('../..',import.meta.url))));
      calls.push('event');return {checked:1,consumed:1,rejected:false,archived:null,results:[]};
    },
    verifyNormal:async()=>{throw Error('No normal simulation expected');}});
  assert.deepEqual(calls,['pin','event','normal-query','normal-query']);
});

test('mixed backlog reserves twelve normal simulations and four event jobs', async () => {
  const selected=Array.from({length:16},(_,n)=>({resultId:'job-'+n}));
  const events=[];
  await runVerifier({env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'synthetic'},log:()=>{},
    validateEngine:async()=>{},connectDatabase:async()=>({call:async()=>[],requests:()=>1}),
    eventRun:async(_,__,options)=>{
      events.push(options.limit);return {checked:4,consumed:0,rejected:false,archived:null,results:[]};
    },
    selectNormal:async()=>({jobs:selected,canonicalAttempts:16,selectionConflicts:0}),
    verifyNormal:async(_,jobs)=>{assert.equal(jobs.length,12);return jobs.map(j=>({...j,status:'verified'}));},
    publishNormal:async(_,jobs,results)=>{
      assert.equal(jobs.length,12);assert.equal(results.length,12);
      return {verified:12,corrected:0,unavailable:0,deferred:0,reasons:{}};
    }});
  assert.deepEqual(events,[4]);assert.equal(selected.length,16);
});

test('normal engine pin failure prevents any event processing', async () => {
  await assert.rejects(runVerifier({env:{},validateEngine:async()=>{throw Error('pin mismatch');},
    eventRun:async()=>{throw Error('must not run events');}}),/pin mismatch/);
});

test('real event module idle preflight performs five bounded read operations and no writes', async () => {
  const calls=[];
  const result=await checkForWork({call:async(p,body)=>{
    calls.push({p,body});
    if(p===':runQuery'){const collection=body.structuredQuery.from[0].collectionId;
      assert.equal(body.structuredQuery.limit,[VERIFICATION_COLLECTION,EXTRA_VERIFICATION_COLLECTION].includes(collection)?20:1);
      if(collection!=='0.6.2_event_retries')assert.ok(body.structuredQuery.select);return [];}
    assert.ok(['/0.6.2_event_catalog/main','/0.6.2_event_cursors/scan'].includes(p),p);return null;
  }},{env:{},log:()=>{},now:1234});
  assert.equal(result.hasWork,false);assert.equal(calls.length,6);
});

test('real event queue due with canonical empty wakes workflow without replay reads', async () => {
  const result=await checkForWork({call:async(p,body)=>{
    if(p===':runQuery')return [];
    if(p==='/0.6.2_event_catalog/main')return {fields:encode({periods:[{id:'period',enabled:true,startsAt:1,endsAt:2000,graceMs:100,archived:false}]}).mapValue.fields};
    if(p==='/0.6.2_event_queues/period')return {fields:encode({slots:[{notBefore:1,leaseUntil:0,attempts:0}]}).mapValue.fields};
    assert.equal(p,'/0.6.2_event_cursors/scan');return null;
  }},{env:{},log:()=>{},now:1234});
  assert.equal(result.normalHasWork,false);assert.equal(result.eventHasWork,true);assert.equal(result.hasWork,true);
});

test('real event receipt scan wakes workflow when canonical and period queues are empty', async () => {
  const result=await checkForWork({call:async(p,body)=>{
    if(p===':runQuery')return body.structuredQuery.from[0].collectionId==='0.6.2_event_inbox'
      ? [{document:{name:'inbox/doc',fields:{receivedAt:{timestampValue:'2026-09-13T00:00:00Z'}}}}]:[];
    return null;
  }},{env:{},log:()=>{},now:1234});
  assert.equal(result.normalHasWork,false);assert.equal(result.eventHasWork,true);assert.equal(result.hasWork,true);
});

test('real default event processor safely handles both queues empty', async () => {
  let requests=0;
  await runVerifier({env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'synthetic'},log:()=>{},validateEngine:async()=>{},
    connectDatabase:async()=>({call:async(p)=>{
      requests++;
      if(p===':runQuery')return [];
      assert.ok(['/0.6.2_event_catalog/main','/0.6.2_event_cursors/scan'].includes(p),p);return null;
    }}),verifyNormal:async()=>{throw Error('No simulation should run');}});
  assert.equal(requests,9);
});

test('shared budget gives events unused normal capacity without exceeding sixteen total', async () => {
  for (const count of [0,1,4,8,12,16]) {
    const selected=Array.from({length:count},(_,i)=>({resultId:'job-'+i}));
    let reserved=0, simulated=0;
    await runVerifier({env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'synthetic'},log:()=>{},
      validateEngine:async()=>{},connectDatabase:async()=>({call:async()=>[],requests:()=>0}),
      selectNormal:async()=>({jobs:selected,canonicalAttempts:count,selectionConflicts:0}),
      eventRun:async(_,__,options)=>{
        reserved=options.limit;assert.equal(options.intakeLimit,16);
        return {checked:reserved,consumed:16,rejected:false,archived:null,results:[]};
      },verifyNormal:async(_,jobs)=>{simulated=jobs.length;return jobs;},
      publishNormal:async()=>({reasons:{}})});
    assert.equal(simulated,Math.min(12,count));
    assert.equal(reserved,4);assert.equal(reserved+simulated<=16,true);
  }
});


test('event-only coordinator test is independent of checkout name and working directory', {timeout:40000}, () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'polytrack-relocation-'));
  const sourceRoot=fileURLToPath(new URL('../..',import.meta.url));
  const files=['tools/verifier/queue.test.mjs','tools/verifier/queue.mjs','tools/verifier/run.mjs',
    'tools/verifier/runner.mjs','tools/verifier/firestore.mjs','tools/verifier/throughput.mjs',
    'tools/verifier/weekly-track.mjs',
    'workers/ranked/src/verification.js','workers/ranked/src/extra-track-ids.js','workers/ranked/package.json'];
  // Copy only coordinator source. No credentials, engine assets, browser, or network are needed.
  const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','HOME','USERPROFILE']
    .filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
  try {
    for (const name of ['Polytrack-0.6.2','unrelated checkout with spaces']) {
      const checkout=path.join(directory,name);
      for (const file of files) {
        const destination=path.join(checkout,file);
        fs.mkdirSync(path.dirname(destination),{recursive:true});
        fs.copyFileSync(path.join(sourceRoot,file),destination);
      }
      const result=spawnSync(process.execPath,['--test',
        '--test-name-pattern=^event work processes with normal queue empty without invoking normal physics$',
        path.join(checkout,'tools/verifier/queue.test.mjs')],
      {cwd:directory,env,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:256*1024});
      assert.ifError(result.error);
      assert.equal(result.status,0,name+'\n'+result.stdout+result.stderr);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
