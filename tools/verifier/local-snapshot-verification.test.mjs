import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {verifyLocalSnapshot,verifyLocalNativeBatch,verificationAuthority,readRepositoryVerificationAuthority,withOfflineVerification,writeLocalVerificationReceipt} from './local-snapshot-verification.mjs';
import {ledgerBinding,ledgerKey,applyLedgerToBoard} from '../native-verification-ledger.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const track='a'.repeat(64),engine='b'.repeat(64),fingerprint='c'.repeat(64),content='d'.repeat(64);
const policy={engineDigest:engine,compatibleEngines:[],verifierVersion:'polytrack-native-bounded-v1',
  verifierFingerprint:fingerprint,resourceProfiles:['standard'],reviewPolicyVersions:['snapshot-controls-v1'],
  trackContentHashes:{[track]:content},trackGeometries:{[track]:{geometryPolicy:'default',trackGeometry:{parts:20,spanX:100,spanZ:120}}}};
const sourceBinding={sourceCommit:'a'.repeat(40),captureSha256:'e'.repeat(64)};
function job(number=1,lane='normal') {
  const replay=deflateSync(Buffer.alloc(15)).toString('base64url');
  const value={lane,accountId:sha('account'+number),trackId:track,timeMs:900+number,frames:900+number,
    uploadId:lane==='event'?null:number,replayHash:sha(replay),replay};
  if(lane==='event') Object.assign(value,{periodId:'w_20261026',runId:sha('run'+number)});
  value.resultId=lane==='event'?value.runId:value.accountId+'_'+track;
  return value;
}
function native(value,currentPolicy=policy) {
  const binding={verifierVersion:currentPolicy.verifierVersion,verifierFingerprint:currentPolicy.verifierFingerprint,
    resourceProfile:value.resourceProfile || 'standard',resultId:value.resultId,trackId:value.trackId,timeMs:value.timeMs,replayHash:value.replayHash,
    actualReplayHash:sha(value.replay),nativeTrackId:value.trackId,trackContentHash:currentPolicy.trackContentHashes[value.trackId],engineDigest:currentPolicy.engineDigest};
  return {resultId:value.resultId,trackId:value.trackId,timeMs:value.timeMs,replayHash:value.replayHash,status:'verified',
    reason:'native_exact_finish',deterministic:true,engineDigest:currentPolicy.engineDigest,trackContentHash:binding.trackContentHash,
    ...structuredClone(currentPolicy.trackGeometries[value.trackId]),binding,boundInputFingerprint:sha(JSON.stringify(binding))};
}
function review(disposition='approved') {
  return async ({jobs,nativeResults,allJobs})=>{
    assert(Object.isFrozen(allJobs));
    return {complete:true,results:nativeResults.map(result=>result.status==='verified'&&disposition!=='approved'
      ? {...result,status:'unavailable',reason:'similar_replay_pending_manual_review'}:result),
    reviews:jobs.map(value=>({complete:true,disposition,bindingKey:ledgerKey(ledgerBinding(value)),
      policyVersion:'snapshot-controls-v1',attestationHash:sha('completed-review:'+disposition+value.resultId)}))};
  };
}
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'local-snapshot-native-'));
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});
  const options={root,ledgerRoot:path.join(root,'verification-ledger'),expectedManifestHash:null,
    jobs:[job()],sourceBinding,policy,review:review(),validateEngine:async()=>{},
    verify:async(_root,jobs)=>jobs.map(value=>native(value)),env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'test-secret'},now:()=>Date.now()-1000};
  return {root,options};
}

test('authority defaults only when absent and rejects every unknown explicit mode',()=>{
  for(const value of [undefined,'','firestore']) assert.equal(verificationAuthority(value),'firestore');
  assert.equal(verificationAuthority('snapshot-native'),'snapshot-native');
  for(const value of [null,0,true,'native','snapshot-native ','FIRESTORE']) assert.throws(()=>verificationAuthority(value),/authority/);
});

test('repository authority inherits checked-in activation, validates overrides and never silently downgrades a native ledger',async t=>{
  const {root}=await fixture(t),file=path.join(root,'tools/verification-authority.json');
  assert.equal(await readRepositoryVerificationAuthority(root),'firestore');
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file,JSON.stringify({schemaVersion:1,mode:'snapshot-native'}));
  for(const override of [undefined,'']) assert.equal(await readRepositoryVerificationAuthority(root,override),'snapshot-native');
  assert.equal(await readRepositoryVerificationAuthority(root,'firestore'),'firestore');
  for(const override of ['typo','native','firestore ']) await assert.rejects(readRepositoryVerificationAuthority(root,override),/authority/);
  for(const value of [{schemaVersion:2,mode:'snapshot-native'},{schemaVersion:1,mode:'typo'},
    {schemaVersion:1,mode:'snapshot-native',url:'https://evil.invalid'},null]) {
    await fs.writeFile(file,JSON.stringify(value));await assert.rejects(readRepositoryVerificationAuthority(root));
  }
  await fs.unlink(file);await fs.writeFile(path.join(root,'verification-ledger-current.json'),'{}');
  await assert.rejects(readRepositoryVerificationAuthority(root),/native ledger exists/);
});

test('native and review execute without capture credentials or fetch capability, with guard cleanup',async()=>{
  const before=globalThis.fetch,env={FIREBASE_VERIFIER_SERVICE_ACCOUNT:'secret',GOOGLE_APPLICATION_CREDENTIALS:'secret-path',PATH:'keep'};
  await assert.rejects(withOfflineVerification(async()=>{
    assert.deepEqual(env,{PATH:'keep'});assert.throws(()=>fetch('https://firestore.googleapis.com'),/forbids fetch/);
    await assert.rejects(withOfflineVerification(async()=>{}),/already active/);throw Error('mock failure');
  },{env}),/mock failure/);
  assert.equal(globalThis.fetch,before);assert.deepEqual(env,{PATH:'keep'});
});

for(const lane of ['normal','event']) test(lane+' exact proof is durable and returned as branded authority without writing boards',async t=>{
  const {root,options}=await fixture(t);options.jobs=[job(1,lane)];
  let pins=false;options.validateEngine=async()=>{pins=true;};
  options.verify=async(_root,jobs)=>{assert(pins);assert.equal(options.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT,undefined);return jobs.map(value=>native(value));};
  const source=structuredClone(options.jobs),result=await verifyLocalSnapshot(options);
  assert.equal(result.complete,true);assert.equal(result.counts.verified,1);assert.equal(result.counts.nativeDispatched,1);
  assert.deepEqual(options.jobs,source);
  const value=source[0],applied=applyLedgerToBoard({ledger:result.ledger,board:{trackId:track,
    ...(lane==='event'?{periodId:value.periodId}:{}),entries:[value]},canonicalRows:source,recordings:source,policy,lane});
  assert.equal(applied.report.verified,1);
  const receipt=await writeLocalVerificationReceipt(path.join(root,'receipt.json'),result);
  const bytes=await fs.readFile(receipt.path,'utf8');
  assert(!bytes.includes(value.replay));assert(!bytes.includes('test-secret'));assert(!bytes.includes('nativeResults'));
});

test('native batches are serial and bounded; reuse skips native but never current whole-source review',async t=>{
  const {options}=await fixture(t);options.jobs=Array.from({length:18},(_,i)=>job(i+1));
  let active=0,calls=0,reviews=0;
  options.verify=async(_root,jobs)=>{assert.equal(++active,1);assert(jobs.length<=16);calls++;await Promise.resolve();active--;return jobs.map(value=>native(value));};
  options.review=async input=>{assert.equal(input.allJobs.length,18);reviews++;return review()(input);};
  const first=await verifyLocalSnapshot(options);assert.equal(calls,2);assert.equal(reviews,2);
  const second=await verifyLocalSnapshot({...options,expectedManifestHash:first.ledgerManifestHash,
    sourceBinding:{...sourceBinding,captureSha256:'f'.repeat(64)},verify:async()=>assert.fail('cached native dispatch')});
  assert.equal(second.counts.nativeDispatched,0);assert.equal(second.counts.reusedPhysics,18);assert.equal(reviews,4);
  assert.equal(second.ledgerManifestHash,first.ledgerManifestHash,'unchanged proofs do not grow a witness on every scheduled pass');
});

test('parent policy builder sees pinned ledger entries and newly observed geometry before authority creation',async t=>{
  const {options}=await fixture(t);delete options.policy;let calls=0;
  options.buildPolicy=async input=>{calls++;assert.deepEqual(input.jobs,options.jobs);assert(Array.isArray(input.entries));return policy;};
  const result=await verifyLocalSnapshot(options);assert.equal(calls,2);assert.equal(result.counts.verified,1);
});

test('compatible old physics can receive a new hold; neither reuse nor later approval erases it',async t=>{
  const {options}=await fixture(t),first=await verifyLocalSnapshot(options);
  const held=await verifyLocalSnapshot({...options,expectedManifestHash:first.ledgerManifestHash,review:review('held'),verify:async()=>assert.fail('reuse physics')});
  assert.equal(held.counts.held,1);assert.equal(held.counts.verified,0);
  const again=await verifyLocalSnapshot({...options,expectedManifestHash:held.ledgerManifestHash});
  assert.equal(again.counts.held,1);assert.equal(again.counts.verified,0);
});

test('engine/fingerprint/track content changes invalidate cached proof',async t=>{
  const {options}=await fixture(t),first=await verifyLocalSnapshot(options);
  const changed=structuredClone(policy);changed.verifierFingerprint='f'.repeat(64);
  let calls=0;
  const result=await verifyLocalSnapshot({...options,policy:changed,expectedManifestHash:first.ledgerManifestHash,
    verify:async(_root,jobs)=>{calls++;return jobs.map(value=>native(value,changed));}});
  assert.equal(calls,1);assert.equal(result.counts.reusedPhysics,0);
});

test('partial budget and unavailable native results remain explicit, never positive ledger entries',async t=>{
  const {options}=await fixture(t);options.jobs=[job(),job(2),job(3)];
  const result=await verifyLocalSnapshot({...options,maxJobs:1});
  assert.equal(result.complete,false);assert.equal(result.counts.verified,1);assert.equal(result.counts.unprocessed,2);
  assert.equal(result.decisions.length,3);assert.equal(result.ledger.entries.length,1);
  const retry=await verifyLocalSnapshot({...options,expectedManifestHash:result.ledgerManifestHash,
    verify:async(_root,jobs)=>jobs.map(value=>({...native(value),status:'unavailable',reason:'timeout'}))});
  assert.equal(retry.complete,false);assert.equal(retry.counts.reusedPhysics,1);assert.equal(retry.counts.unavailable,2);
  assert.equal(retry.ledger.entries.length,1);
});

test('tampered result IDs, native bindings, review and ledger anchors fail closed',async t=>{
  for(const corrupt of ['duplicate','identity','hash','geometry','review','anchor']) {
    const {options}=await fixture(t);
    if(corrupt==='duplicate') options.jobs.push(job());
    if(corrupt==='anchor') options.expectedManifestHash='0'.repeat(64);
    options.verify=async(_root,jobs)=>jobs.map(value=>{
      const result=native(value);
      if(corrupt==='identity') result.resultId='other';
      if(corrupt==='hash') result.binding.actualReplayHash='f'.repeat(64);
      if(corrupt==='geometry') result.trackGeometry.parts++;
      return result;
    });
    if(corrupt==='review') options.review=async()=>({complete:false,results:[],reviews:[]});
    await assert.rejects(verifyLocalSnapshot(options),undefined,corrupt);
  }
});

test('missing review, invalid replay and failed engine pin never dispatch native',async t=>{
  for(const fault of ['review','replay','engine']) {
    const {options}=await fixture(t);options.verify=async()=>assert.fail('dispatch before safety gate');
    if(fault==='review') delete options.review;
    if(fault==='replay') options.jobs[0].replay='bad';
    if(fault==='engine') options.validateEngine=async()=>{throw Error('pinned engine mismatch');};
    await assert.rejects(verifyLocalSnapshot(options));
  }
});

test('old long runs and resource-invalid profiles become unavailable without poisoning healthy peers',async t=>{
  const {options}=await fixture(t),long=job(2);long.timeMs=3800000;long.frames=3800000;
  const invalid=job(3);invalid.resourceProfile='not-a-profile';
  options.jobs=[long,invalid,job()];
  let dispatched=[];options.verify=async(_root,jobs)=>{dispatched=jobs;return jobs.map(value=>native(value));};
  const result=await verifyLocalSnapshot(options);
  assert.equal(dispatched.length,1);assert.equal(dispatched[0].resultId,job().resultId);
  assert.equal(result.counts.unavailable,2);assert.equal(result.counts.verified,1);assert.equal(result.complete,false);
  assert.equal(result.decisions.find(value=>value.binding.timeMs===3800000).reason,'time_limit');
});

test('native adapter groups standard jobs <=16, extended singly, preserving input order and normalizing only unavailable bindings',async()=>{
  const jobs=Array.from({length:18},(_,i)=>job(i+1));
  const extended=[job(50),job(51)].map(value=>({...value,resourceProfile:'extended-local',timeMs:400000,frames:400000}));
  jobs.push(...extended);const calls=[];
  const result=await verifyLocalNativeBatch('fixture',jobs,[],{verifyBatch:async(_root,selected,_tracks,{profile})=>{
    calls.push([profile,selected.length]);
    return selected.map(value=>({...native(value),status:'unavailable',trackId:null,timeMs:null,replayHash:null}));
  }});
  assert.deepEqual(calls,[['standard',16],['standard',2],['extended-local',1],['extended-local',1]]);
  assert.deepEqual(result.map(value=>value.resultId),jobs.map(value=>value.resultId));
  assert(result.every(value=>value.trackId===track&&value.status==='unavailable'));
});

test('explicit extended policy works within unchanged limits and full-call plus packaging reserve',async t=>{
  const {options}=await fixture(t),extended={...job(),resourceProfile:'extended-local',timeMs:400000,frames:400000};
  options.jobs=[extended];options.policy={...policy,resourceProfiles:['standard','extended-local']};
  let calls=0;options.verify=async(_root,jobs,_tracks,capability)=>{
    assert.equal(jobs.length,1);assert.equal(capability.profile,'extended-local');assert(Number.isFinite(capability.deadline));
    calls++;return jobs.map(value=>native(value,options.policy));
  };
  const deferred=await verifyLocalSnapshot({...options,maxRuntimeMs:180000,packReserveMs:60000});
  assert.equal(calls,0);assert.equal(deferred.counts.unprocessed,1);
  const passed=await verifyLocalSnapshot({...options,expectedManifestHash:deferred.ledgerManifestHash,maxRuntimeMs:200000,packReserveMs:60000});
  assert.equal(calls,1);assert.equal(passed.counts.verified,1);
});

test('independent unknown track metadata avoids repeated native boot without conferring proof',async t=>{
  const {options}=await fixture(t);options.policy={...policy,knownTrackIds:[]};
  options.verify=async()=>assert.fail('missing trusted asset must not boot native');
  const result=await verifyLocalSnapshot(options);assert.equal(result.counts.unavailable,1);
  assert.equal(result.decisions[0].reason,'missing_trusted_track');assert.equal(result.ledger.entries.length,0);
});

test('bounded per-binding review incompleteness defers affected rows but preserves healthy peers',async t=>{
  const {options}=await fixture(t);options.jobs=[job(),job(2)];
  options.review=async input=>{
    const result=await review()(input);return {...result,complete:false,reason:'captured_controls_coverage_incomplete',
      incompleteKeys:[ledgerKey(ledgerBinding(input.jobs[0]))]};
  };
  const result=await verifyLocalSnapshot(options);
  assert.equal(result.counts.verified,1);assert.equal(result.counts.unavailable,1);assert.equal(result.complete,false);
  assert.equal(result.ledger.entries.length,1);
});
