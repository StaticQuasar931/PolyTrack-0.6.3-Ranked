import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {summarizeSnapshotReadiness} from './snapshot-readiness.mjs';
test('offline readiness includes all archived periods, pending jobs and missing assets without native clearance',()=>{
  const replay=deflateSync(Buffer.alloc(15)).toString('base64url'),replayHash=createHash('sha256').update(replay).digest('hex');
  const job={resultId:'test',trackId:'a'.repeat(64),timeMs:1,replay,replayHash,kind:'normal',bindingStatus:'orphan_recording'};
  const period={id:'old-period',trackId:'b'.repeat(64),archived:true};
  const audit={jobs:[job],pendingJobs:[{...job,kind:'event-pending',trackId:period.trackId,periodId:period.id}],issues:[{kind:'gap'}],coverage:{complete:false},manifest:{generation:'fixture'}};
  const r=summarizeSnapshotReadiness(audit,{staticTracks:[{id:job.trackId,hash:'c'.repeat(64)}],eventPeriods:[period]});
  assert.equal(r.totals.jobs,2);assert.equal(r.totals.inputValid,2);assert.equal(r.totals.unmappedIdentityJobs,1);
  assert.deepEqual(r.issueCounts,{gap:1});assert.equal(r.eventPeriods[0].archived,true);
  assert.equal(r.nativeSimulationPerformed,false);assert.equal(r.publicationAuthorized,false);
  assert.doesNotMatch(JSON.stringify(r),new RegExp('"replay"'));assert.equal(r.tracks[1].kinds['event-pending'],1);
});
