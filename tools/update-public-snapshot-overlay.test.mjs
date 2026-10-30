import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {updatePublicSnapshot} from './update-public-snapshot.mjs';
import {decodeSnapshot} from './snapshot-package.mjs';
import {nativePolicyFingerprint} from './native-verification-ledger.mjs';

const commit='a'.repeat(40),manifestHash='b'.repeat(64);
async function write(root,file,value){const target=path.join(root,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,JSON.stringify(value)+'\n');}
const read=async(root,file)=>JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
async function fixture(t,{pointer=true,mode='firestore'}={}){
  const deny=()=>assert.fail('stored-proof updater test attempted transport');
  t.mock.method(globalThis,'fetch',deny);
  for(const [object,keys]of [[http,['request','get']],[https,['request','get']],[net,['connect','createConnection']],[tls,['connect']]])
    for(const key of keys)t.mock.method(object,key,deny);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'snapshot-overlay-update-')),directory=path.join(root,'local-reports','snapshot-staging');
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(root,'index.html'),'<html><head></head></html>');
  await write(root,'tools/verification-authority.json',{schemaVersion:1,mode});
  if(pointer)await write(root,'verification-ledger-current.json',{schemaVersion:1,directory:'verification-ledger',manifestHash});
  await write(directory,'manifest.json',{tracks:{},events:{}});
  await write(directory,'overall.json',{entries:[],complete:true,totalEntries:0});
  const calls=[],context={ledger:{manifestHash},canonicalRows:[],ledgerRoot:path.join(root,'verification-ledger'),policy:{
    engineDigest:'c'.repeat(64),compatibleEngines:[],verifierVersion:'fixture-native-v1',verifierFingerprint:'d'.repeat(64),
    resourceProfiles:['standard'],reviewPolicyVersions:['snapshot-controls-v1'],trackContentHashes:{},trackGeometries:{}}};
  const env={GITHUB_ENV:path.join(root,'github-env')};await fs.writeFile(env.GITHUB_ENV,'');
  const options={root,env,offline:true,log:()=>{},
    resolveSourceCommit:async value=>{assert.equal(value,root);calls.push('pin');return commit;},
    prepareNativeCapture:async value=>{
      calls.push('prepare');assert.deepEqual(value,{root,directory});
      assert.equal(await fs.readFile(env.GITHUB_ENV,'utf8'),'SNAPSHOT_NATIVE_SOURCE_COMMIT='+commit+'\n');return context;
    },
    nativePhase:async value=>{
      calls.push('phase');assert.equal(value.captureContext,context);assert.equal(value.sourceCommit,commit);
      assert.equal(value.root,root);assert.equal(value.directory,directory);assert.equal(value.reuseOnly,mode==='firestore');
      return {authority:'phase-fixture',backendReads:0,backendWrites:0,complete:false,
        counts:{reusedPhysics:2,nativeDispatched:0,newProofs:0},ledgerManifestHash:manifestHash};
    },
    capture:async()=>assert.fail('offline overlay must not capture'),
    exportPublic:async()=>assert.fail('offline overlay must not export'),
    exportFetch:deny};
  return {root,directory,calls,context,env,options};
}

test('offline Firestore publication reuses stored proof context, pins source before phase and never claims native backend authority',async t=>{
  const f=await fixture(t),before=await read(f.root,'tools/verification-authority.json');
  const result=await updatePublicSnapshot({...f.options,refreshReplays:true,fullPublic:true,
    nativePhaseOptions:{reuseOnly:false,verify:()=>assert.fail('new physics is forbidden')}});
  assert.deepEqual(f.calls,['pin','prepare','phase']);
  assert.equal(result.published,true);assert.deepEqual(result.nativeVerification,{authority:'firestore',reuseOnly:true,complete:false,
    counts:{reusedPhysics:2,nativeDispatched:0,newProofs:0},ledgerManifestHash:manifestHash,backendReads:0,backendWrites:0});
  assert.deepEqual(await read(f.root,'tools/verification-authority.json'),before);
});

test('Firestore stored-proof context precedes capture; reuse-only overlay follows totals/replay export and precedes packaging',async t=>{
  const f=await fixture(t),phase=f.options.nativePhase;
  const overall={updatedAt:100,sourceRevision:1,builtRevision:1,algorithmVersion:'fixture',entries:[],trackSummaries:[]};
  const result=await updatePublicSnapshot({...f.options,offline:false,refreshReplays:true,
    captureOverall:async()=>{f.calls.push('source');return {files:new Map([['overall.json',overall],
      ['overall-results.json',{...overall,resultBundle:'e30=',resultBundleVersion:1,resultBundleComplete:true}]]),
      confirmedTracks:new Map(),capturedTracks:new Map(),report:{projectionReady:false,projectionReason:'fixture'}};},
    capture:async value=>{f.calls.push('capture');assert.equal(value.nativeVerification,f.context);return {};},
    calculateOverall:async()=>assert.fail('pre-overlay scoring must not run'),
    captureTotals:async()=>{f.calls.push('totals');return {deferred:false};},
    exportPublic:async()=>{f.calls.push('replays');return {complete:false,coverage:{complete:false},counts:{}};},
    nativePhase:async value=>{const receipt=await phase(value);await write(f.directory,'overlay-receipt.json',{reuseOnly:value.reuseOnly});return receipt;}});
  assert.deepEqual(f.calls,['pin','prepare','source','capture','totals','replays','phase']);
  const index=await read(f.root,result.directory+'/index.json'),record=index.files['overlay-receipt.json'];
  const packed=await fs.readFile(path.join(f.root,result.directory,record.path));
  assert.deepEqual(JSON.parse(Buffer.from(await decodeSnapshot(packed)).toString()),{reuseOnly:true});
});

test('Firestore without a ledger pointer keeps legacy packaging and never resolves or invokes proof capabilities',async t=>{
  const f=await fixture(t,{pointer:false});
  const result=await updatePublicSnapshot(f.options);
  assert.deepEqual(f.calls,[]);assert.equal(result.nativeVerification,undefined);
  assert.equal(await fs.readFile(f.env.GITHUB_ENV,'utf8'),'');assert.equal(result.published,true);
});

test('snapshot-native mode retains new-verification phase and does not become reuse-only',async t=>{
  const f=await fixture(t,{pointer:false,mode:'snapshot-native'});
  const result=await updatePublicSnapshot({...f.options,nativePhaseOptions:{reuseOnly:true}});
  assert.deepEqual(f.calls,['pin','prepare','phase']);
  assert.equal(result.nativeVerification.authority,'snapshot-native');assert.equal(result.nativeVerification.reuseOnly,false);
});

test('resolved workflow Firestore mode overrides a native repository default without changing backend authority',async t=>{
  const f=await fixture(t,{mode:'snapshot-native'});f.env.VERIFICATION_AUTHORITY='firestore';
  const result=await updatePublicSnapshot({...f.options,nativePhase:async value=>{
    assert.equal(value.reuseOnly,true);
    return {backendReads:0,backendWrites:0,complete:false,counts:{nativeDispatched:0,newProofs:0},ledgerManifestHash:manifestHash};
  }});
  assert.equal(result.nativeVerification.authority,'firestore');assert.equal(result.nativeVerification.reuseOnly,true);
  f.env.VERIFICATION_AUTHORITY='invalid';
  await assert.rejects(updatePublicSnapshot(f.options),/invalid authority mode/);
});

test('an existing validated source pin is forwarded before capture without invoking Git fallback',async t=>{
  const f=await fixture(t);f.env.SNAPSHOT_NATIVE_SOURCE_COMMIT=commit;
  await updatePublicSnapshot({...f.options,resolveSourceCommit:()=>assert.fail('existing pin must not be replaced')});
  assert.deepEqual(f.calls,['prepare','phase']);
});

test('default missing-env source pin reads actual local Git HEAD without capture, authentication or native work',async t=>{
  const f=await fixture(t),repository=fileURLToPath(new URL('../',import.meta.url));
  const gitDir=execFileSync('git',['rev-parse','--absolute-git-dir'],{cwd:repository,encoding:'utf8'}).trim();
  const head=execFileSync('git',['rev-parse','--verify','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
  // A temporary gitfile permits read-only HEAD lookup without creating commits
  // or changing anything in the actual checkout's Git directory.
  await fs.writeFile(path.join(f.root,'.git'),'gitdir: '+gitDir.replace(/\\/g,'/')+'\n');
  // The Windows test sandbox has a different owner from the real Git directory.
  // Trust only this temporary fixture for these child reads, never global config.
  const index=Number(process.env.GIT_CONFIG_COUNT||0),overrides={GIT_CONFIG_COUNT:String(index+1),
    ['GIT_CONFIG_KEY_'+index]:'safe.directory',['GIT_CONFIG_VALUE_'+index]:f.root.replace(/\\/g,'/')};
  const previous=Object.fromEntries(Object.keys(overrides).map(key=>[key,process.env[key]]));
  Object.assign(process.env,overrides);
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const result=await updatePublicSnapshot({...f.options,resolveSourceCommit:undefined,
    prepareNativeCapture:async()=>{
      assert.equal(await fs.readFile(f.env.GITHUB_ENV,'utf8'),'SNAPSHOT_NATIVE_SOURCE_COMMIT='+head+'\n');return f.context;
    },nativePhase:async value=>{
      assert.equal(value.sourceCommit,head);assert.equal(value.reuseOnly,true);
      return {backendReads:0,backendWrites:0,complete:false,counts:{nativeDispatched:0,newProofs:0},ledgerManifestHash:manifestHash};
    }});
  assert.equal(result.nativeVerification.authority,'firestore');assert.equal(result.published,true);
});

test('invalid source pins and context failures stop before all capture/export/publication',async t=>{
  for(const failure of ['pin','context']){
    const f=await fixture(t);
    await assert.rejects(updatePublicSnapshot({...f.options,offline:false,
      env:{...f.env,...failure==='pin'?{SNAPSHOT_NATIVE_SOURCE_COMMIT:'bad\nINJECTED=yes'}:{}},
      prepareNativeCapture:async()=>{assert.equal(failure,'context');throw Error('protected proof context invalid');},
      capture:async()=>assert.fail('capture before source/context safety gate'),
      captureOverall:async()=>assert.fail('source read before source/context safety gate')}),
      failure==='pin'?/pinned snapshot source commit/:/protected proof context invalid/);
    await assert.rejects(fs.stat(path.join(f.root,'snapshot-current.json')),/ENOENT/);
    if(failure==='pin')assert.equal(await fs.readFile(f.env.GITHUB_ENV,'utf8'),'');
  }
});

test('stored-proof overlay receipt must establish zero backend usage before packaging',async t=>{
  for(const receipt of [null,{backendReads:1,backendWrites:0},{backendReads:0,backendWrites:1}]){
    const f=await fixture(t);
    await assert.rejects(updatePublicSnapshot({...f.options,nativePhase:async()=>receipt}),/zero Firebase publication usage/);
    await assert.rejects(fs.stat(path.join(f.root,'snapshot-current.json')),/ENOENT/);
  }
});

test('Firestore publication refuses missing or nonzero new-physics/new-proof counts',async t=>{
  for(const counts of [undefined,{nativeDispatched:1,newProofs:0},{nativeDispatched:0,newProofs:1},{nativeDispatched:0}]){
    const f=await fixture(t);
    await assert.rejects(updatePublicSnapshot({...f.options,nativePhase:async()=>({backendReads:0,backendWrites:0,counts})}),
      /zero new physics\/proofs/);
    await assert.rejects(fs.stat(path.join(f.root,'snapshot-current.json')),/ENOENT/);
  }
});

test('offline packaging validates a matching stored overlay but never reapplies already-overlaid event totals',async t=>{
  const f=await fixture(t);
  await write(f.directory,'manifest.json',{tracks:{},events:{},nativeVerificationLedger:{
    sourceRepositoryPath:'verification-ledger/manifest.json',manifestHash,authority:'snapshot-native',
    policyFingerprint:nativePolicyFingerprint(f.context.policy)}});
  const totals={updatedAt:123,entries:[],complete:true,totalEntries:0,nativeEventOverlay:{version:'fixture',totalsBaselineDigest:'c'.repeat(64)}};
  await write(f.directory,'event-totals.json',totals);
  const result=await updatePublicSnapshot({...f.options,nativePhase:()=>assert.fail('already-overlaid totals must not be applied twice')});
  assert.deepEqual(f.calls,['pin','prepare']);
  assert.deepEqual(result.nativeVerification,{authority:'firestore',reuseOnly:true,reusedOverlay:true,ledgerManifestHash:manifestHash,backendReads:0,backendWrites:0});
  const index=await read(f.root,result.directory+'/index.json'),record=index.files['event-totals.json'];
  const packed=await fs.readFile(path.join(f.root,result.directory,record.path));
  assert.deepEqual(JSON.parse(Buffer.from(await decodeSnapshot(packed)).toString()),totals);
});

test('stale or orphan offline event overlays fail before phase rather than guessing a pristine totals baseline',async t=>{
  for(const stale of [true,false]){
    const f=await fixture(t);
    if(stale)await write(f.directory,'manifest.json',{tracks:{},events:{},nativeVerificationLedger:{manifestHash:'f'.repeat(64)}});
    await write(f.directory,'event-totals.json',{nativeEventOverlay:{version:'fixture'},entries:[]});
    await assert.rejects(updatePublicSnapshot({...f.options,nativePhase:()=>assert.fail('unsafe offline reapplication')}),
      stale?/Offline stored-proof overlay is stale/:/no matching stored-proof manifest/);
    assert.deepEqual(f.calls,['pin','prepare']);
    await assert.rejects(fs.stat(path.join(f.root,'snapshot-current.json')),/ENOENT/);
  }
});

test('offline overlay reuse rejects missing or mismatched policy receipts despite matching ledger hash',async t=>{
  for(const policyFingerprint of [undefined,'f'.repeat(64)]){
    const f=await fixture(t);
    await write(f.directory,'manifest.json',{tracks:{},events:{},nativeVerificationLedger:{manifestHash,
      ...(policyFingerprint===undefined?{}:{policyFingerprint})}});
    await write(f.directory,'event-totals.json',{entries:[],nativeEventOverlay:{version:'fixture'}});
    const before=await fs.readFile(path.join(f.directory,'event-totals.json'));
    await assert.rejects(updatePublicSnapshot({...f.options,nativePhase:()=>assert.fail('stale policy cannot reapply totals')}),
      /overlay policy is missing or stale; pristine source and policy revalidation are required/);
    assert.deepEqual(f.calls,['pin','prepare']);
    assert.deepEqual(await fs.readFile(path.join(f.directory,'event-totals.json')),before);
    await assert.rejects(fs.stat(path.join(f.root,'snapshot-current.json')),/ENOENT/);
  }
});

test('engine and review-policy changes invalidate an otherwise matching offline overlay receipt',async t=>{
  for(const field of ['engineDigest','verifierFingerprint','reviewPolicyVersions']){
    const f=await fixture(t),policyFingerprint=nativePolicyFingerprint(f.context.policy);
    await write(f.directory,'manifest.json',{tracks:{},events:{},nativeVerificationLedger:{manifestHash,policyFingerprint}});
    f.context.policy[field]=field==='reviewPolicyVersions'?['snapshot-controls-v2']:'e'.repeat(64);
    await assert.rejects(updatePublicSnapshot({...f.options,nativePhase:()=>assert.fail('changed policy requires pristine source/revalidation')}),
      /overlay policy is missing or stale/);
    assert.deepEqual(f.calls,['pin','prepare']);
    await assert.rejects(fs.stat(path.join(f.root,'snapshot-current.json')),/ENOENT/);
  }
});
