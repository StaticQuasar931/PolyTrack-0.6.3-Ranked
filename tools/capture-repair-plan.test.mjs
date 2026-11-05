import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {CAPTURE_REPAIR as R,assertCaptureRepair} from './capture-repair-plan.mjs';
import {OVERNIGHT_SNAPSHOT as N} from './overnight-snapshot-plan.mjs';
import {overnightClaimRef,acquireOvernightCaptureClaim} from './overnight-capture-claim.mjs';
test('replacement is manual, first-attempt, time-bounded and cannot repeat a recorded capture',()=>{
 const args={eventName:'workflow_dispatch',now:R.start,runAttempt:1};
 const plan=assertCaptureRepair(args);assert.equal(plan.mode,'snapshot-native');
 assert.equal(plan.maxJobs,N.maxJobs);assert.equal(plan.maxRuntimeMs,N.maxRuntimeMs);assert.equal(plan.replayDocumentLimit,N.replayDocumentLimit);
 for(const patch of [{eventName:'schedule'},{runAttempt:2},{now:R.start-1},{now:R.latestStart},{now:NaN},{previousCaptureStartedAt:N.reset}])assert.throws(()=>assertCaptureRepair({...args,...patch}));
 assert.equal(overnightClaimRef(),'refs/tags/polytrack-oneoff-2026-11-05');
 assert.equal(overnightClaimRef({replacement:true}),R.claimRef);
});
test('replacement claim is independently exclusive and never deletes or overwrites the old one',async()=>{
 let held=false;const ref=R.claimRef,sha='a'.repeat(40);
 const fetchImpl=async(url,options)=>{
  assert.ok(url.startsWith('https://api.github.com/repos/StaticQuasar931/PolyTrack-0.6.3-Ranked/git/'));
  if(options.method==='POST'){assert.deepEqual(JSON.parse(options.body),{ref,sha});if(held)return {status:422};held=true;return {status:201,json:async()=>({ref,object:{sha}})};}
  assert.equal(options.method,'GET');assert.ok(url.endsWith('/git/ref/tags/polytrack-oneoff-2026-11-05-repair-1'));
  return {status:200,json:async()=>({ref,object:{sha}})};
 };
 const args={repository:'StaticQuasar931/PolyTrack-0.6.3-Ranked',sourceCommit:sha,token:'fixture',replacement:true,fetchImpl};
 assert.equal((await acquireOvernightCaptureClaim(args)).acquired,true);assert.equal((await acquireOvernightCaptureClaim(args)).acquired,false);
});
test('replacement workflow cannot drain server verification and uses the existing capture lock and caps',async()=>{
 const wrapper=await fs.readFile(new URL('../.github/workflows/repair-snapshot.yml',import.meta.url),'utf8');
 assert.match(wrapper,/workflow_dispatch:/);assert.doesNotMatch(wrapper,/schedule:|catch_up|check-queue|verify-runs\.mjs/);
 assert.match(wrapper,/replacement_capture: true/);assert.match(wrapper,/overnight_native: true/);assert.match(wrapper,/verification_authority: snapshot-native/);
 assert.ok(wrapper.indexOf('Confirm private access')<wrapper.indexOf('  publish:'));
 const pipeline=await fs.readFile(new URL('../.github/workflows/publish-verified-snapshots.yml',import.meta.url),'utf8');
 assert.match(pipeline,/group: public-repository-captures-/);assert.match(pipeline,/cancel-in-progress: false/);
 assert.match(pipeline,/if\(replacement\)assertCaptureRepair/);assert.match(pipeline,/else assertOvernightCapture/);
 assert.match(pipeline,/replayDocumentLimit:OVERNIGHT_SNAPSHOT.replayDocumentLimit/);
 assert.match(pipeline,/nativeVerification\?\.backendReads!==0/);
 const configuration=JSON.parse(await fs.readFile(new URL('../workers/ranked/wrangler.jsonc',import.meta.url),'utf8'));
 assert.ok(configuration.secrets.required.includes('CAPTURE_SERVICE_ACCOUNT_EMAIL'));
});
