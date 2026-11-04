import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {overnightSnapshotPlan,assertOvernightCapture,OVERNIGHT_SNAPSHOT as N} from './overnight-snapshot-plan.mjs';
const base={eventName:'schedule',schedule:N.cron,now:N.start,runAttempt:1,configuredMode:'firestore'};
test('only Nov5 exact scheduled occurrence gets one-off native bounds',()=>{
  const p=overnightSnapshotPlan(base);assert.equal(p.mode,'snapshot-native');assert.equal(p.overnight,true);
  assert.equal(p.maxJobs,10000);assert.equal(p.maxRuntimeMs,1500000);assert.equal(p.packReserveMs,60000);
  assert.equal(p.replayDocumentLimit,2000);assert.equal(N.replayDocumentLimit,2000);
  assert.equal(N.start,Date.parse('2026-11-05T08:45:00Z'));assert.equal(N.deadline,Date.parse('2026-11-05T13:00:00Z'));
});
test('manual dispatch, other windows and other days never force native',()=>{
  for(const patch of [{eventName:'workflow_dispatch'},{schedule:'5 8 * * *'},{schedule:'50 0,12,20 * * *'},{schedule:'50 0,8,12,20 * * *'},
    {now:Date.parse('2026-11-04T08:45:00Z')},{now:Date.parse('2026-11-06T08:45:00Z')}]){
    const p=overnightSnapshotPlan({...base,...patch});assert.equal(p.mode,'firestore');assert.equal(p.overnight,false);assert.equal(p.skip,false);
    assert.equal(Object.hasOwn(p,'replayDocumentLimit'),false);
  }
});

test('explicit manual kickoff uses the same bounds and cannot run on another date or retry',()=>{
  const manual={...base,eventName:'workflow_dispatch',manualOvernight:true};
  assert.equal(overnightSnapshotPlan(manual).overnight,true);
  assert.equal(overnightSnapshotPlan({...manual,now:N.start-1}).skip,true);
  assert.equal(overnightSnapshotPlan({...manual,now:N.latestCaptureStart}).skip,true);
  assert.equal(overnightSnapshotPlan({...manual,now:Date.parse('2026-11-04T08:45:00Z')}).skip,true);
  assert.equal(overnightSnapshotPlan({...manual,runAttempt:2}).skip,true);
  assert.equal(overnightSnapshotPlan({...manual,previousCaptureStartedAt:N.reset+1}).skip,true);
  assert.throws(()=>overnightSnapshotPlan({...manual,manualOvernight:'true'}));
});
test('late, early, retried or previously recorded occurrence stops without legacy drain fallback',()=>{
  for(const patch of [{now:N.start-1},{now:N.latestCaptureStart},{now:N.latestFallback},{now:N.deadline},
    {runAttempt:2},{previousCaptureStartedAt:N.start}])assert.equal(overnightSnapshotPlan({...base,...patch}).skip,true);
  assert.equal(overnightSnapshotPlan({...base,now:N.latestCaptureStart-1}).overnight,true);
});
test('parent capture rechecks window and attempt after acquiring the capture lock',()=>{
  assert.deepEqual(assertOvernightCapture({mode:'snapshot-native',now:N.start,runAttempt:1}),{maxJobs:10000,maxRuntimeMs:1500000});
  for(const patch of [{mode:'firestore'},{now:N.latestCaptureStart},{runAttempt:2},{previousCaptureStartedAt:N.start}])
    assert.throws(()=>assertOvernightCapture({mode:'snapshot-native',now:N.start,runAttempt:1,...patch}),/denied/);
});
test('invalid inputs fail closed and explicitly configured native mode is not silently downgraded',()=>{
  for(const patch of [{configuredMode:'typo'},{now:NaN},{runAttempt:0}])assert.throws(()=>overnightSnapshotPlan({...base,...patch}));
  assert.equal(overnightSnapshotPlan({...base,eventName:'workflow_dispatch',configuredMode:'snapshot-native'}).mode,'snapshot-native');
});
test('private workflow proposal keeps four daily windows, capture lock and zero-queue-write native branch',async()=>{
  const verify=await fs.readFile(new URL('../.github/workflows/verify-runs.yml',import.meta.url),'utf8');
  const capture=await fs.readFile(new URL('../.github/workflows/publish-verified-snapshots.yml',import.meta.url),'utf8');
  assert.match(verify,/cron: '50 0,12,20 \* \* \*'/);assert.match(verify,/cron: '45 8 \* \* \*'/);
  assert.match(verify,/steps.authority.outputs.skip != 'true' && steps.authority.outputs.mode == 'firestore'/);
  assert.match(verify,/overnight_native: \$\{\{ needs.verify.outputs.overnight_native == 'true' \}\}/);
  assert.match(capture,/group: public-repository-captures-\$\{\{ github.repository \}\}/);assert.match(capture,/cancel-in-progress: false/);
  assert.match(capture,/inputs.overnight_native && 50 \|\| 35/);
  assert.ok(capture.indexOf('Guard the one-time overnight capture')<capture.indexOf('Capture public event assignments'));
  assert.match(capture,/nativePhaseOptions/);assert.match(capture,/assertOvernightCapture/);
  assert.match(capture,/replayDocumentLimit:OVERNIGHT_SNAPSHOT.replayDocumentLimit/);
  assert.match(verify,/overnight_capture:/);assert.match(verify,/EXPECTED_SOURCE_COMMIT/);
  assert.match(capture,/acquireOvernightCaptureClaim/);
  assert.match(capture,/steps.overnight_guard.outputs.admitted == 'true'/);
  assert.doesNotMatch(capture,/acknowledge-native-event-queues|secrets: inherit/);
});
