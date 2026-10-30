import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {loadCapturedNativeJobs,verifyCapturedSnapshot} from './local-snapshot-capture.mjs';
import {ledgerBinding,ledgerKey} from '../native-verification-ledger.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const track='a'.repeat(64),account='b'.repeat(64),engine='c'.repeat(64),fingerprint='d'.repeat(64),content='e'.repeat(64);
const replay=deflateSync(Buffer.alloc(15)).toString('base64url'),replayHash=sha(replay);
const policy={engineDigest:engine,compatibleEngines:[],verifierVersion:'polytrack-native-bounded-v1',verifierFingerprint:fingerprint,
  resourceProfiles:['standard','extended-local'],reviewPolicyVersions:['snapshot-controls-v1'],
  trackContentHashes:{[track]:content},trackGeometries:{[track]:{geometryPolicy:'default',trackGeometry:{parts:1,spanX:10,spanZ:20}}}};
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'captured-native-source-')),directory=path.join(root,'candidate');
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});
  const write=async(relative,value)=>{const file=path.join(directory,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value)+'\n');};
  const row={accountId:account,trackId:track,timeMs:900,frames:900,uploadId:1,replayHash,runVerified:false,verified:false};
  await write('manifest.json',{tracks:{[track]:{path:`tracks/${track}.json`}},events:{}});
  await write(`tracks/${track}.json`,{trackId:track,entries:[row],updatedAt:100});
  await write(`canonical/${track}/${account}.json`,row);
  await write('recordings/1.json',{...row,recording:replay});
  const native=async(_root,jobs)=>jobs.map(job=>{
    const binding={verifierVersion:policy.verifierVersion,verifierFingerprint:fingerprint,resourceProfile:job.resourceProfile||'standard',
      resultId:job.resultId,trackId:track,timeMs:job.timeMs,replayHash,actualReplayHash:replayHash,nativeTrackId:track,trackContentHash:content,engineDigest:engine};
    return {resultId:job.resultId,trackId:track,timeMs:job.timeMs,replayHash,status:'verified',reason:'native_exact_finish',
      deterministic:true,engineDigest:engine,trackContentHash:content,...structuredClone(policy.trackGeometries[track]),binding,
      boundInputFingerprint:sha(JSON.stringify(binding))};
  });
  const reviewFactory=async({jobs,sourceBinding})=>{
    assert(Object.isFrozen(jobs));assert.equal(jobs.length,1);assert.equal(sourceBinding.sourceCommit,'a'.repeat(40));
    return async({jobs,nativeResults})=>({complete:true,results:nativeResults,reviews:jobs.map(job=>({complete:true,
      disposition:'approved',bindingKey:ledgerKey(ledgerBinding(job)),policyVersion:'snapshot-controls-v1',attestationHash:sha('review fixture')}))});
  };
  return {root,directory,row,write,options:{root,directory,ledgerRoot:path.join(root,'ledger'),sourceCommit:'a'.repeat(40),
    expectedManifestHash:null,policy,verify:native,validateEngine:async()=>{},reviewFactory,env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'test secret'}}};
}

test('real capture wrapper hydrates exact source and invokes native plus full-inventory review capability without transport',async t=>{
  const {options}=await fixture(t),result=await verifyCapturedSnapshot(options);
  assert.equal(result.inputs.jobs.length,1);assert.equal(result.inputs.coverage.complete,true);
  assert.equal(result.verification.counts.verified,1);
  assert.equal(result.verification.sourceBinding.captureSha256,result.inputs.captureSha256);
  assert.equal(options.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT,undefined);
});

test('missing retained bytes remain explicit coverage; present wrong bytes/identity fail closed',async t=>{
  const {directory,row,write}=await fixture(t);
  await fs.unlink(path.join(directory,'recordings/1.json'));
  const missing=await loadCapturedNativeJobs({directory});
  assert.equal(missing.coverage.knownBindings,1);assert.equal(missing.coverage.missingBindings,1);
  assert.equal(missing.jobs.length,0);assert.equal(missing.coverage.complete,false);
  await write('recordings/1.json',{...row,recording:replay,accountId:'f'.repeat(64)});
  await assert.rejects(loadCapturedNativeJobs({directory}),/binding mismatch/);
  await write('recordings/1.json',{...row,recording:'tampered'});
  await assert.rejects(loadCapturedNativeJobs({directory}),/hash mismatch/);
});

test('explicit extended opt-in chooses existing bounds and retains over-limit legacy rows for unavailable decisions',async t=>{
  const {directory,row,write}=await fixture(t);
  async function duration(timeMs){const next={...row,timeMs,frames:timeMs};await write(`tracks/${track}.json`,{trackId:track,entries:[next]});
    await write(`canonical/${track}/${account}.json`,next);await write('recordings/1.json',{...next,recording:replay});}
  await duration(400000);
  assert.equal((await loadCapturedNativeJobs({directory})).jobs[0].resourceProfile,undefined);
  assert.equal((await loadCapturedNativeJobs({directory,allowExtendedLocal:true})).jobs[0].resourceProfile,'extended-local');
  await duration(3800000);
  const long=await loadCapturedNativeJobs({directory,allowExtendedLocal:true});
  assert.equal(long.jobs.length,1);assert.equal(long.jobs[0].timeMs,3800000);assert.equal(long.jobs[0].resourceProfile,undefined);
});

test('waiting event retained payload binds period/run and carries no RP authority',async t=>{
  const {directory,row,write}=await fixture(t),periodId='w_20261026',runId='f'.repeat(64);
  const pending={accountId:account,runId,timeMs:900,submittedAt:123,pending:true,verified:false,eventRpEligible:false};
  await write('manifest.json',{tracks:{[track]:{path:`tracks/${track}.json`}},events:{[periodId]:{path:`events/${periodId}.json`}}});
  await write(`events/${periodId}.json`,{id:periodId,period:{id:periodId,trackId:track},entries:[],pendingPlaybacks:[pending]});
  await write(`event-playbacks/${periodId}/${runId}.json`,{...pending,periodId,trackId:track,frames:900,replayHash,replay,
    name:'Public Racer',carStyle:'style',privateCredential:'never copied'});
  const loaded=await loadCapturedNativeJobs({directory});
  const event=loaded.jobs.find(value=>value.lane==='event');assert.equal(event.runId,runId);assert.equal(event.uploadId,null);
  assert.equal(loaded.coverage.knownBindings,2);assert(!Object.hasOwn(event,'rp'));
  const recording=loaded.recordings.find(value=>value.lane==='event');
  assert.equal(recording.name,'Public Racer');assert.equal(recording.carStyle,'style');
  assert.equal(event.name,undefined);assert.equal(event.carStyle,undefined);
  assert.equal(recording.privateCredential,undefined);
  await write(`event-playbacks/${periodId}/${runId}.json`,{...pending,periodId:'other',trackId:track,frames:900,replayHash,replay});
  await assert.rejects(loadCapturedNativeJobs({directory}),/binding mismatch/);
});

test('capture changes during review abort before final compilation rather than applying stale source decisions',async t=>{
  const {options,row,write}=await fixture(t),factory=options.reviewFactory;
  options.reviewFactory=async input=>{
    await write(`tracks/${track}.json`,{trackId:track,entries:[row],updatedAt:999});return factory(input);
  };
  await assert.rejects(verifyCapturedSnapshot(options),/source changed/);
});
