import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {overnightSnapshotPlan,assertOvernightCapture,localOvernightCapturePlan,OVERNIGHT_SNAPSHOT as N} from './overnight-snapshot-plan.mjs';
const receipt={ready:true,targetDate:N.date,execution:'local',oneOffAuthority:'snapshot-native',testedCommit:'a'.repeat(40),scheduledCaptureAt:new Date(N.start).toISOString(),replayDocumentLimit:1000};
test('local run is November 6 at 00:05 PST, with unchanged bounds',()=>{
  assert.equal(N.execution,'local');assert.equal(N.start,Date.parse('2026-11-06T08:05:00Z'));
  assert.deepEqual(localOvernightCapturePlan({now:N.start,receipt}),{mode:'snapshot-native',maxJobs:10000,maxRuntimeMs:1500000,replayDocumentLimit:1000,deadline:N.deadline});
});
test('hosted morning windows and manual overnight attempts reserve local work',()=>{
  for(const now of [N.reset,N.start,Date.parse('2026-11-06T08:45:00Z')])for(const schedule of [N.cron,'50 0,12,20 * * *'])for(const configuredMode of ['firestore','snapshot-native']){
    const p=overnightSnapshotPlan({eventName:'schedule',schedule,now,configuredMode});assert.equal(p.skip,true);assert.equal(p.reason,'reserved-for-local-capture');assert.equal(p.overnight,false);
  }
  assert.equal(overnightSnapshotPlan({eventName:'workflow_dispatch',manualOvernight:true,now:N.start}).skip,true);
  assert.equal(overnightSnapshotPlan({eventName:'workflow_dispatch',manualOvernight:false,now:N.start}).skip,true);
  assert.throws(()=>assertOvernightCapture({mode:'snapshot-native',now:N.start,runAttempt:1}),/denied/);
});
test('local admission rejects stale, untested, hosted and out-of-window receipts',()=>{
  for(const patch of [{ready:false},{execution:'hosted'},{targetDate:'2026-11-05'},{testedCommit:'bad'},{oneOffAuthority:'firestore'},{replayDocumentLimit:2000},{scheduledCaptureAt:'2026-11-06T08:45:00.000Z'}])assert.throws(()=>localOvernightCapturePlan({now:N.start,receipt:{...receipt,...patch}}));
  for(const now of [N.start-1,N.latestCaptureStart,N.deadline,NaN])assert.throws(()=>localOvernightCapturePlan({now,receipt}));
});
test('ordinary windows outside the one-time reservation are unchanged',()=>{
  for(const now of [Date.parse('2026-11-05T20:50:00Z'),Date.parse('2026-11-06T12:50:00Z'),Date.parse('2026-11-06T20:50:00Z'),Date.parse('2026-11-07T08:45:00Z')]){
    const p=overnightSnapshotPlan({eventName:'schedule',schedule:'50 0,12,20 * * *',now,configuredMode:'firestore'});assert.equal(p.skip,false);assert.equal(p.overnight,false);assert.equal(p.mode,'firestore');
  }
  for(const patch of [{configuredMode:'typo'},{now:NaN},{runAttempt:0}])assert.throws(()=>overnightSnapshotPlan({eventName:'schedule',schedule:N.cron,now:N.start,...patch}));
});
test('hosted workflow keeps four daily windows and capture safeguards',async()=>{
  const verify=await fs.readFile(new URL('../.github/workflows/verify-runs.yml',import.meta.url),'utf8'),capture=await fs.readFile(new URL('../.github/workflows/publish-verified-snapshots.yml',import.meta.url),'utf8');
  assert.match(verify,/cron: '50 0,12,20 \* \* \*'/);assert.match(verify,/cron: '45 8 \* \* \*'/);
  assert.match(verify,/steps.authority.outputs.skip != 'true' && steps.authority.outputs.mode == 'firestore'/);
  assert.match(capture,/group: public-repository-captures-\$\{\{ github.repository \}\}/);assert.match(capture,/cancel-in-progress: false/);assert.match(capture,/assertOvernightCapture/);assert.match(capture,/acquireOvernightCaptureClaim/);assert.doesNotMatch(capture,/secrets: inherit/);
});
