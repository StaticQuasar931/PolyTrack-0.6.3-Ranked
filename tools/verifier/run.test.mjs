import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runRound, runVerifier, verifierAccounting} from './run.mjs';
import {createFirestoreCaller} from './firestore.mjs';
import {VerificationEventConflictError} from './throughput.mjs';
import {prioritizeQueueDocuments} from './runner.mjs';
import {VERIFICATION_COLLECTION, EXTRA_VERIFICATION_COLLECTION} from '../../workers/ranked/src/verification.js';
import {EXTRA_TRACK_IDS} from '../../workers/ranked/src/extra-track-ids.js';

const noop = () => {};
const eventRun = async () => ({checked: 0, consumed: 0, rejected: false, archived: null, results: []});
const options = {env: {}, log: noop, eventRun, prioritizeNormal: async (_db, docs) => docs,
  selectNormal: async (_db, docs, _now, limits) => ({jobs: [], canonicalAttempts: 0, selectionConflicts: 0, limits}),
  verifyNormal: async () => [], publishNormal: async () => ({verified: 0}), borrowUnusedEvents: true};

test('event-only rounds retain every published status and native reason without replay data', async () => {
  const logs=[];
  const results=[
    {status:'verified',reason:'native_exact_finish'},
    {status:'mismatch',reason:'native_finish_mismatch'},
    {status:'waiting',reason:'trusted_track_part_limit'},
    {status:'unavailable_final',reason:'scan_work_limit'},
  ].map(row=>({...row,replay:'private replay',accountId:'private identity'}));
  const result=await runRound({remainingRequests:()=>0,call:()=>assert.fail('no reads')},
    {...options,log:line=>logs.push(line),eventRun:async()=>({checked:4,consumed:0,results})});
  assert.deepEqual(result.events.statuses,{verified:1,mismatch:1,waiting:1,unavailable_final:1});
  assert.deepEqual(result.events.reasons,{native_exact_finish:1,native_finish_mismatch:1,trusted_track_part_limit:1,scan_work_limit:1});
  assert.equal(result.events.reported,4);assert.equal(result.events.countsComplete,true);
  assert.equal(result.verified,undefined,'normal counts must not silently include event outcomes');
  assert.doesNotMatch(logs.join('\n'),/private replay|private identity/);
});

test('missing event outcomes are explicitly incomplete rather than zero verified', async () => {
  const result=await runRound({remainingRequests:()=>0},
    {...options,eventRun:async()=>({checked:2,consumed:0})});
  assert.equal(result.events.reported,0);assert.equal(result.events.countsComplete,false);
  assert.deepEqual(result.events.reasons,{});
});

test('small remaining publication reserve lowers each due-lane query bound', async () => {
  const queries = [];
  const db = {remainingRequests: () => 30, call: async (_path, body) => {
    const query = body.structuredQuery; queries.push(query);
    if (query.from[0].collectionId === VERIFICATION_COLLECTION) return [
      {document: {fields: {trackId: {stringValue: 'core-a'}}}},
      {document: {fields: {trackId: {stringValue: 'core-b'}}}},
    ];
    return [];
  }};

  await runRound(db, options);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries.map(query => query.limit), [1, 1]);
  assert.equal(queries.reduce((sum, query) => sum + query.limit, 0), 2);
});

test('no runnable publication reserve skips both repeated queue scans', async () => {
  let queries = 0;
  const db = {remainingRequests: () => 14, call: async () => { queries++; return []; }};
  await runRound(db, options);
  assert.equal(queries, 0);
});

test('one round shares priority metadata between lanes but the next round rereads it', async () => {
  const core = ['core-a', 'core-b'].map(trackId => ({document: {fields: {
    trackId: {stringValue: trackId}, notBefore: {integerValue: '0'}, slots: {mapValue: {fields: {}}},
  }}}));
  const extraIds = [...EXTRA_TRACK_IDS].slice(0, 2);
  assert.equal(extraIds.length, 2);
  const extra = extraIds.map(trackId => ({document: {fields: {
    trackId: {stringValue: trackId}, notBefore: {integerValue: '0'}, slots: {mapValue: {fields: {}}},
  }}}));
  let overallReads = 0;
  const db = {remainingRequests: () => 400, call: async (_path, body) =>
    body.structuredQuery.from[0].collectionId === VERIFICATION_COLLECTION ? core : extra,
  get: async () => { overallReads++; return {data: {trackSummaries: []}}; }};
  const priority = async (connection, docs, now, cache) => {
    const {prioritizeQueueDocuments} = await import('./runner.mjs');
    return prioritizeQueueDocuments(connection, docs, now, cache);
  };
  const roundOptions = {...options, prioritizeNormal: priority};

  await runRound(db, roundOptions);
  await runRound(db, roundOptions);
  assert.equal(overallReads, 2);
});

test('top-weight due track gets one targeted lookup inside the existing eight-document lane cap',async()=>{
  const target='summer-priority-track';
  const broad=Array.from({length:7},(_,i)=>({document:{fields:{trackId:{stringValue:`older-${i}`},notBefore:{integerValue:'0'},slots:{mapValue:{fields:{}}}}}}));
  const queries=[];let targetReads=0,selected=[];
  const db={remainingRequests:()=>400,call:async(_path,body)=>{queries.push(body.structuredQuery);return body.structuredQuery.from[0].collectionId===VERIFICATION_COLLECTION?broad:[];},
    get:async(collection,id)=>{
      if(collection==='0.6.2_s1_leaderboards_overall')return {data:{trackSummaries:[{trackId:target,weight:50},{trackId:'low-priority',weight:1}]}};
      if(collection===VERIFICATION_COLLECTION&&id===target){targetReads++;return {data:{trackId:target,notBefore:0,slots:{}}};}
      return null;
    }};
  const selectedOptions={...options,prioritizeNormal:prioritizeQueueDocuments,
    selectNormal:async(_db,docs)=>{selected.push(...docs.map(doc=>doc.data.trackId));return {jobs:[],canonicalAttempts:0,selectionConflicts:0};}};
  await runRound(db,selectedOptions);
  assert.equal(queries[0].limit,7,'one broad candidate slot is exchanged for priority discovery');
  assert.equal(queries[1].limit,8);
  assert.equal(targetReads,1);
  assert.ok(selected.includes(target));
  assert.equal(selected.length,8,'the Core candidate count remains capped at eight');
});



test('event intake contention lends unused slots to normal work instead of crashing',async()=>{
 const logs=[];let seenCapacity=0;
 const result=await runRound({call:async()=>[],requests:()=>1}, {...options,log:message=>logs.push(message),eventRun:async()=>({checked:0,consumed:0,rejected:false,archived:null,results:[],budgetDeferred:true,conflictDeferred:true}),selectNormal:async(_db,_docs,_now,limits)=>{seenCapacity=limits.jobLimit;return {jobs:[],canonicalAttempts:0,selectionConflicts:0};}});
 assert.equal(result.events.conflictDeferred,true);assert.equal(result.infrastructureFailure,false);assert.equal(seenCapacity,16);assert.ok(logs.some(s=>s.includes('normal verification continues')));
});

function failureFixture(failure, {summaryPath, drain = false, catchUp = false} = {}) {
  let eventCalls = 0;
  const logs = [];
  return {logs, eventCalls: () => eventCalls, options: {
    drain, catchUp, clock: () => 0,
    env: {FIREBASE_VERIFIER_SERVICE_ACCOUNT: 'offline-synthetic', GITHUB_EVENT_NAME: 'workflow_dispatch',
      ...(summaryPath ? {GITHUB_STEP_SUMMARY: summaryPath} : {})},
    log: message => logs.push(message), validateEngine: async () => {},
    connectDatabase: async () => ({call: async () => assert.fail('no database work after event conflict')}),
    eventRun: async () => { eventCalls++; throw failure; },
    selectNormal: async () => assert.fail('no normal selection after event conflict'),
    verifyNormal: async () => assert.fail('no normal verification after event conflict'),
    publishNormal: async () => assert.fail('no normal publication after event conflict'),
  }};
}

function summaryFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'polytrack-event-conflict-summary-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return path.join(directory, 'summary.md');
}

const aborted = () => Object.assign(Error('Firestore request failed: 409'), {status: 409, code: 'ABORTED'});
function assertConflictExplanation(text) {
  assert.match(text, /Earlier writes may have committed/);
  assert.match(text, /interrupted-round publication counts are incomplete/);
  assert.match(text, /No write was replayed/);
  assert.match(text, /next invocation will reread queue state/);
  assert.doesNotMatch(text, /Firestore throttled|deferred throttle response/);
}

test('non-drain exact tagged event conflict defers once with incomplete counts and a truthful summary', async t => {
  for (const summaryPath of [undefined, summaryFile(t)]) {
    const f = failureFixture(new VerificationEventConflictError(aborted()), {summaryPath});
    const result = await runVerifier(f.options);
    assert.deepEqual(result, {deferred: true, reason: 'event_conflict', interruptedRound: true, countsComplete: false});
    assert.equal(f.eventCalls(), 1);
    assert.deepEqual(f.logs.map(line => JSON.parse(line)).filter(row=>!row.firestoreUsage), [result]);
    assert.equal(JSON.parse(f.logs.at(-1)).firestoreUsage.outcome,'deferred');
    if (summaryPath) {
      const text = fs.readFileSync(summaryPath, 'utf8');
      assert.match(text, /## Verification deferred/);
      assertConflictExplanation(text);
      assert.ok(text.includes(JSON.stringify(result)));
    }
  }
});

test('non-drain event deferral rejects untagged conflicts, lookalikes and non-ABORTED causes', async t => {
  const cause = aborted();
  const denied = Object.assign(Error('denied'), {status: 403, code: 'PERMISSION_DENIED'});
  const timeout = Error('timeout');
  const failures = [cause, denied, timeout,
    Object.assign(Error('lookalike'), {code: 'VERIFICATION_EVENT_CONFLICT', deferred: true, cause}),
    {name: 'VerificationEventConflictError', code: 'VERIFICATION_EVENT_CONFLICT', deferred: true, cause},
    new VerificationEventConflictError(denied), new VerificationEventConflictError(timeout),
    new VerificationEventConflictError(undefined),
    ...[['409', 'ABORTED'], [503, 'ABORTED'], [409, 'event_lease_lost'], [409, 'FAILED_PRECONDITION'],
      [409, undefined], [undefined, 'ABORTED']].map(([status, code]) =>
      new VerificationEventConflictError(Object.assign(Error('not an exact abort'), {status, code}))),
  ];
  const summaryPath = summaryFile(t);
  for (const failure of failures) {
    const f = failureFixture(failure, {summaryPath});
    await assert.rejects(runVerifier(f.options), error => error === failure);
    assert.equal(f.eventCalls(), 1);
    assert.equal(f.logs.length,1);
    assert.equal(JSON.parse(f.logs[0]).firestoreUsage.outcome,'failed');
    const text=fs.readFileSync(summaryPath,'utf8');
    assert.match(text,/## Firestore accounting/);
    assert.doesNotMatch(text,/## Verification deferred|## Bounded drain/);
  }
});

test('drain and Catch-Up summaries explain event-conflict publication uncertainty and rereading', async t => {
  for (const catchUp of [false, true]) {
    const summaryPath = summaryFile(t);
    const f = failureFixture(new VerificationEventConflictError(aborted()), {summaryPath, drain: true, catchUp});
    const result = await runVerifier(f.options);
    assert.equal(result.stop, 'event_conflict');
    assert.equal(result.interruptedRound, true);
    assert.equal(result.countsComplete, false);
    assert.equal(result.rounds, 0);
    assert.equal(f.eventCalls(), 1);
    const text = fs.readFileSync(summaryPath, 'utf8');
    assert.match(text, /## Bounded drain/);
    assertConflictExplanation(text);
    assert.ok(text.includes(JSON.stringify(result)));
  }
});

test('non-drain and drain throttle deferrals keep their existing distinct explanations', async t => {
  for (const drain of [false, true]) {
    const summaryPath = summaryFile(t);
    const failure = Object.assign(Error('throttled'), {status: 429, code: 'FIRESTORE_COMMIT_THROTTLED', deferred: true});
    const f = failureFixture(failure, {summaryPath, drain});
    const result = await runVerifier(f.options);
    assert.equal(drain ? result.stop : result.reason, 'firestore_throttled');
    assert.equal(result.countsComplete, false);
    assert.equal(f.eventCalls(), 1);
    const text = fs.readFileSync(summaryPath, 'utf8');
    assert.match(text, /Firestore throttled|Firestore returned a deferred throttle response/);
    assert.doesNotMatch(text, /An event transaction conflicted/);
  }
});


test('new committed review findings raise workflow warnings without another query',async()=>{
 const {announceReviewFindings}=await import('./run.mjs');const messages=[];
 for(const count of [0,-1,NaN,1.5,undefined])announceReviewFindings(count,m=>messages.push(m));
 assert.equal(messages.length,0);announceReviewFindings(1,m=>messages.push(m));announceReviewFindings(2,m=>messages.push(m));
 assert.equal(messages.length,2);assert.match(messages[0],/^::warning title=Replay review required::1 new replay review finding\./);
 assert.match(messages[1],/2 new replay review findings\./);assert.match(messages[0],/remain held pending human review/);
});


test('failure accounting survives preflight throttle, parse failures and unexpected drain exceptions', async t => {
  for (const check of [true,false]) for (const kind of ['throttle','parse','network']) {
    const summaryPath=summaryFile(t), logs=[];
    const failure=Error('PRIVATE_TRANSPORT_PAYLOAD');let calls=0;
    const raw=createFirestoreCaller({base:'https://offline.invalid',access:'PRIVATE_ACCESS',mode:'scheduled',
      fetchImpl:async()=>{
        calls++;
        if(kind==='network')throw failure;
        if(kind==='throttle')return new Response('{}',{status:429});
        return {status:200,ok:true,json:async()=>{throw Error('PRIVATE_PARSE_BODY');}};
      }});
    const options={check,drain:!check,clock:()=>0,env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'PRIVATE_CREDENTIAL',GITHUB_STEP_SUMMARY:summaryPath},
      validateEngine:async()=>{},connectDatabase:async()=>raw,log:line=>logs.push(line),
      eventRun:async db=>{await db.call(':runQuery',{});assert.fail('must stop');},
      eventCheck:()=>assert.fail('No extra preflight discovery')};
    if(kind==='throttle')await runVerifier(options);
    else await assert.rejects(runVerifier(options),error=>kind==='network'?error===failure:error.message==='Firestore response decoding failed');
    const receipt=JSON.parse(logs.at(-1)).firestoreUsage;
    assert.equal(receipt.phase,check?'preflight':'drain');
    assert.equal(receipt.outcome,kind==='throttle'?'deferred':'failed');
    assert.equal(receipt.firestoreHttpRequests,1);assert.equal(receipt.firestoreFailedRequests,1);
    assert.equal(receipt.firestoreRequestReservations,check?null:1);
    assert.equal(receipt.firestoreUnknownReadOutcomes,kind==='throttle'?0:1);
    assert.equal(receipt.firestoreEstimatedDocumentReads,0);assert.equal(calls,1);
    assert.doesNotMatch(logs.join('')+fs.readFileSync(summaryPath,'utf8'),/PRIVATE_|offline.invalid/);
    assert.equal('FIREBASE_VERIFIER_SERVICE_ACCOUNT' in options.env,false);
  }
});

test('accounting getters are numeric-only, tolerate unavailable counters and cannot leak details', () => {
  const result=verifierAccounting({requests:()=>7,returnedDocuments:()=>{throw Error('PRIVATE');},
    failedRequests:()=>-1,writeAttempts:()=>({token:'PRIVATE'}),unknownReadOutcomes:()=>Infinity});
  assert.equal(result.firestoreHttpRequests,7);assert.equal(result.firestoreRequestReservations,null);
  assert.equal(result.firestoreReturnedDocuments,null);assert.equal(result.firestoreFailedRequests,null);
  assert.ok(Object.values(result).every(value=>value===null||Number.isSafeInteger(value)&&value>=0));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
});

test('accounting reporter failures do not replace original exceptions', async t => {
  const failure=Error('original'),summaryPath=path.join(path.dirname(summaryFile(t)),'missing','summary');
  await assert.rejects(runVerifier({check:true,
    env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'fake',GITHUB_STEP_SUMMARY:summaryPath},
    connectDatabase:async()=>({call:async()=>{throw failure;}}),log:()=>{throw Error('logger');}}),error=>error===failure);
});

test('accounting getter failures cannot change successful work', async () => {
  const result=await runVerifier({check:true,env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'fake'},log:()=>{},
    connectDatabase:async()=>({call:async()=>[],failedRequests:()=>{throw Error('PRIVATE_COUNTER');}}),
    eventCheck:async()=>({hasWork:false})});
  assert.equal(result.hasWork,false);
});

test('unavailable transport counters never fall back to budget reservations', async () => {
  const {budgetDatabase}=await import('./throughput.mjs');
  const raw={call:async()=>[],httpRequests:()=>null,requests:()=>999};
  const bounded=budgetDatabase(raw,2);
  await bounded.call(':runQuery',{});
  const result=verifierAccounting(bounded);
  assert.equal(result.firestoreHttpRequests,null);assert.equal(result.firestoreRequestReservations,1);
});

test('authentication exceptions emit unavailable accounting and clear credentials without a DB probe', async t => {
  const logs=[],summaryPath=summaryFile(t),failure=Error('PRIVATE_AUTH');
  const env={FIREBASE_VERIFIER_SERVICE_ACCOUNT:'PRIVATE_CREDENTIAL',GITHUB_STEP_SUMMARY:summaryPath};
  await assert.rejects(runVerifier({check:true,env,log:line=>logs.push(line),connectDatabase:async()=>{throw failure;}}),error=>error===failure);
  const receipt=JSON.parse(logs[0]).firestoreUsage;
  assert.equal(receipt.phase,'connect');assert.equal(receipt.outcome,'failed');
  assert.equal(receipt.firestoreHttpRequests,null);assert.equal('FIREBASE_VERIFIER_SERVICE_ACCOUNT' in env,false);
  assert.doesNotMatch(logs.join('')+fs.readFileSync(summaryPath,'utf8'),/PRIVATE/);
});
