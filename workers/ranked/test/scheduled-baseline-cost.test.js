import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {scheduledIntervalDue} from '../src/index.js';
import {VERIFICATION_BOOTSTRAP_ID} from '../src/verification.js';
import {EXTRA_TRACK_IDS} from '../src/extra-track-ids.js';
import {PERMANENT_ROLLING_HILLS} from '../src/permanent-rolling-hills.js';
import {eventEncode} from '../src/events-store.js';
import {recordFirestoreReads} from '../src/firestore-read-cost.js';

async function checkDailyBaseline(jitterMs) {
  const audit = {documentReadEstimate:0, collections:{}}, errors = [], logs = [];
  const jobs = '/0.6.2_s1_worker_jobs/', calls = [];
  const env = {EVENTS_ENABLED:'false', __TEST_FIRESTORE:async (path, init = {}) => {
    calls.push(path);
    let data;
    if (path === ':runQuery') {
      recordFirestoreReads(audit, path, init, []);
      return [];
    }
    if (path === jobs + VERIFICATION_BOOTSTRAP_ID) data = {complete:true};
    else if (path === jobs + 'canonical_reconcile_v2') data = {backfillComplete:true, pendingTrackIds:[]};
    else if (path === jobs + 'extra_verification_queue_migration_v1') data = {
      complete:true, cursor:EXTRA_TRACK_IDS.size, registry:[...EXTRA_TRACK_IDS].sort().join(',')};
    else if (path === jobs + 'release_migration') data = {kind:'migration', completedAt:1, migrationVersion:999};
    else if (path === '/0.6.2_s1_leaderboards_track/' + PERMANENT_ROLLING_HILLS.trackId)
      data = {entries:[], schemaVersion:999};
    else if (path === '/0.6.2_s1_release_meta/current') data = {dirty:false,
      plannerPublicationVersion:999, plannerBundleVersion:999, cosmeticEntitlementVersion:999,
      averagePlacementVersion:999, derivedMetricsVersion:999, builtRevision:1,
      lastOverallBuildAt:Date.now(),
      // Isolate polling overhead. Actual six-hour source scans are additional work.
      sourceCatalog:{version:1, complete:true, scannedAt:Date.now(), count:0, tracks:{}}};
    else throw Error('Unexpected baseline operation: ' + path);
    const result = {fields:eventEncode(data).mapValue.fields, updateTime:'2026-10-20T00:00:00Z'};
    recordFirestoreReads(audit, path, init, result);
    return result;
  }};
  const previousLog = console.log, previousError = console.error;
  console.log = (...args) => logs.push(args);
  console.error = (...args) => errors.push(args);
  try {
    for (let minute = 0; minute < 1440; minute++) {
      const crons = [...(minute % 2 === 0 ? ['*/2 * * * *'] : []),
        ...(minute % 5 === 0 ? ['*/5 * * * *'] : []), ...(minute % 5 === 1 ? ['1-59/5 * * * *'] : []), ...(minute % 5 === 2 ? ['2-59/5 * * * *'] : [])];
      for (const cron of crons) {
        let completion;
        worker.scheduled({cron, scheduledTime:Date.UTC(2026, 9, 20) + minute * 60000 + jitterMs}, env,
          {waitUntil:promise => {completion = promise;}});
        await completion;
      }
    }
  } finally {console.log = previousLog; console.error = previousError;}
  assert.deepEqual(errors, []);
  assert.equal(audit.documentReadEstimate, 1440);
  assert.equal(audit.writeEstimate || 0, 0);
  assert.equal(calls.length, 1440);
  assert.equal(calls.filter(path => path === ':runQuery').length, 384);
  const scheduled = logs.filter(([message]) => message === 'Ranked scheduled Firestore reads')
    .map(([, payload]) => JSON.parse(payload));
  assert.equal(scheduled.length, 912);
  const aggregates=scheduled.filter(row=>row.cron==='1-59/5 * * * *');
  assert.equal(aggregates.length,288);
  assert(aggregates.every(row=>row.documentReadEstimate===1&&Object.keys(row.collections).length===1&&row.collections['0.6.2_s1_release_meta']===1));
  assert(scheduled.filter(row=>row.cron==='*/5 * * * *').every(row=>!row.collections['0.6.2_s1_release_meta']),'quiet reconciliation must not start aggregation');
  assert.ok(scheduled.every(row => row.quotaPolicy === 'rev171-event-activity' && Number.isSafeInteger(row.scheduledTime)));
  assert.equal(scheduled.reduce((total, row) => total + row.documentReadEstimate, 0), 1440);
}

for (const jitter of [0,39338,59999]) {
  test('24h non-event baseline stays at 1440 reads and zero writes with cron jitter '+jitter+'ms',()=>checkDailyBaseline(jitter));
}

test('cron interval gating uses the scheduled minute and rejects malformed timestamps/intervals',()=>{
 const base=Date.UTC(2026,9,26,14,0,0),scan=15*60000,repair=30*60000;
 for(const jitter of [0,1,39338,59999]) {
  assert.equal(scheduledIntervalDue(base+jitter,scan),true);assert.equal(scheduledIntervalDue(base+jitter,repair),true);
  assert.equal(scheduledIntervalDue(base+15*60000+jitter,scan),true);assert.equal(scheduledIntervalDue(base+15*60000+jitter,repair),false);
  assert.equal(scheduledIntervalDue(base+2*60000+jitter,scan),false);
 }
 for(const value of [undefined,null,NaN,Infinity,-1,1.5,'0'])assert.equal(scheduledIntervalDue(value,scan),false);
 for(const interval of [undefined,NaN,0,-60000,30000,90000])assert.equal(scheduledIntervalDue(base,interval),false);
});

test('quota exhaustion stops later catch-and-continue maintenance calls in the same invocation',async()=>{
 let requests=0,completion;const errors=[];
 const original=console.error;console.error=(...args)=>errors.push(args);
 try{
   worker.scheduled({cron:'*/2 * * * *',scheduledTime:Date.UTC(2026,9,26,12)},
     {__TEST_FIRESTORE:async()=>{requests++;throw Error('FIRESTORE_429');}},
     {waitUntil:value=>{completion=value;}});
   await completion;
   assert.equal(requests,1,'Rolling Hills failure cannot cause follow-up migration reads');
   worker.scheduled({cron:'*/2 * * * *',scheduledTime:Date.UTC(2026,9,26,12,30)},
     {__TEST_FIRESTORE:async()=>{requests++;throw Error('FIRESTORE_429');}},
     {waitUntil:value=>{completion=value;}});
   await completion;
   assert.equal(requests,2,'a later invocation can detect quota recovery; no permanent circuit lock');
 }finally{console.error=original;}
});