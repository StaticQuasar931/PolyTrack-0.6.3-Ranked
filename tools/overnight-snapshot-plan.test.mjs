import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {overnightSnapshotPlan,assertOvernightCapture,localOvernightCapturePlan,OVERNIGHT_SNAPSHOT as N,ORIGINAL_OVERNIGHT_SNAPSHOT as O} from './overnight-snapshot-plan.mjs';
const receipt={ready:true,targetDate:N.date,execution:'local',oneOffAuthority:'firestore',captureOnly:true,testedCommit:'a'.repeat(40),claimTag:N.claimTag,
  scheduledCaptureAt:new Date(N.start).toISOString(),replayDocumentLimit:1000,
  replacementAuthorization:{id:N.authorizationId,requestedBy:'user',publicationMode:'capture-first',automaticRetry:false},
  priorAccounting:{directDocumentReadReservations:37,workerRequests:88}};
test('explicit replacement is capture-first before 01:00 PST, deadline 05:00, shared budget is not reset',()=>{
 assert.equal(N.latestCaptureStart,Date.parse('2026-11-14T09:00:00Z'));assert.equal(N.deadline,Date.parse('2026-11-14T13:00:00Z'));
 assert.deepEqual(localOvernightCapturePlan({now:N.start,receipt}),{mode:'firestore',maxJobs:10000,maxRuntimeMs:1500000,replayDocumentLimit:1000,deadline:N.deadline});
 assert.deepEqual([N.priorDirectReservations,N.priorWorkerRequests],[37,88]);assert.equal(40000-N.priorDirectReservations,39963);assert.equal(1024-N.priorWorkerRequests,936);
 assert.doesNotThrow(()=>localOvernightCapturePlan({now:N.latestCaptureStart-1,receipt}));
});
test('historical midnight attempt stays immutable and new tag/prior failed source are distinct',()=>{
 assert.equal(O.claimTag,'polytrack-oneoff-2026-11-14');assert.equal(O.latestCaptureStart,Date.parse('2026-11-14T08:15:00Z'));assert.equal(O.priorDirectReservations,0);
 assert.equal(N.claimTag,'polytrack-oneoff-2026-11-14-replacement-1');assert.equal(N.priorClaimTag,O.claimTag);assert.equal(N.priorOutcome,'failed');
 assert.equal(N.priorSource,'84c96100853a10002036d0fbba75c21fe999d40a');assert.equal(N.privateDirectorySuffix,'2026-11-14/replacement-local');
});
test('old authority, unapproved replacement, reset counters and changed mode cannot admit',()=>{
 for(const patch of [{ready:false},{captureOnly:false},{oneOffAuthority:'snapshot-native'},{claimTag:O.claimTag},{replacementAuthorization:undefined},
 {replacementAuthorization:{...receipt.replacementAuthorization,automaticRetry:true}},{priorAccounting:{directDocumentReadReservations:0,workerRequests:0}},
 {priorAccounting:{directDocumentReadReservations:37,workerRequests:0}},{testedCommit:'bad'},{execution:'hosted'},{replayDocumentLimit:2000}])
 assert.throws(()=>localOvernightCapturePlan({now:N.start,receipt:{...receipt,...patch}}));
 for(const now of [N.start-1,N.latestCaptureStart,N.deadline,NaN])assert.throws(()=>localOvernightCapturePlan({now,receipt}));
});
test('hosted/manual workflows stay reserved through 05:00 including 04:50 verification',()=>{
 for(const now of [N.reset,N.start,Date.parse('2026-11-14T08:45:00Z'),Date.parse('2026-11-14T12:50:00Z'),N.deadline-1])
 for(const eventName of ['schedule','workflow_dispatch']){const p=overnightSnapshotPlan({eventName,schedule:N.cron,now});assert.equal(p.skip,true);assert.equal(p.reason,'reserved-for-local-capture');}
 assert.throws(()=>assertOvernightCapture({mode:'snapshot-native',now:N.start,runAttempt:1}),/denied/);
 assert.equal(overnightSnapshotPlan({eventName:'schedule',schedule:'50 0,12,20 * * *',now:N.deadline}).skip,false);
});
test('ordinary dates and existing workflow safeguards remain unchanged',async()=>{
 assert.equal(overnightSnapshotPlan({eventName:'schedule',schedule:'50 0,12,20 * * *',now:Date.parse('2026-11-15T12:50:00Z')}).skip,false);
 const capture=await fs.readFile(new URL('../.github/workflows/publish-verified-snapshots.yml',import.meta.url),'utf8');assert.match(capture,/cancel-in-progress: false/);assert.match(capture,/acquireOvernightCaptureClaim/);
});
