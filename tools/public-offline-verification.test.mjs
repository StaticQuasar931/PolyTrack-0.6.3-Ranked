import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {writeLedger,ledgerBinding,ledgerKey} from './native-verification-ledger.mjs';
import {verifyLocalSnapshot} from './verifier/local-snapshot-verification.mjs';
import {preparePublishedOfflineVerification,preparePublic76OfflineVerification,PUBLIC_76_VERIFICATION_BASELINE} from './public-offline-verification.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const write=async(root,file,value)=>{await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),JSON.stringify(value)+'\n');};

async function fixture(t){
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'public-offline-test-')),root=path.join(parent,'public');
  t.after(async()=>{assert.equal(path.dirname(parent),os.tmpdir());await fs.rm(parent,{recursive:true,force:true});});
  await fs.mkdir(root);const ledger=writeLedger({root:path.join(root,'verification-ledger'),entries:[],expectedManifestHash:null});
  await write(root,'verification-ledger-current.json',{schemaVersion:1,directory:'verification-ledger',manifestHash:ledger.manifestHash});
  await write(root,'snapshot-current.json',{currentdir:'public-snapshots76'});
  await write(root,'public-snapshots76/index.json',{generation:76,fixture:true});
  const pins={generation:76,indexSha256:sha(await fs.readFile(path.join(root,'public-snapshots76/index.json'))),ledgerManifestHash:ledger.manifestHash,ledgerEntries:0};
  const options={root,runDirectory:path.join(parent,'private-run'),sourceCommit:'a'.repeat(40),publishedBaseline:pins};
  let native=0,compiled=0,disposed=0;
  const capabilities={validateRuntime:async()=>({fixture:true}),hydrate:async(source,target)=>{assert.equal(source,root);await write(target,'manifest.json',{source:'public-76'});},
    prepare:async({root:source,directory})=>{assert.equal(source,root);assert.equal(directory,path.join(options.runDirectory,'candidate'));return {fixture:true};},
    loadTotals:async({root:source,expectedGeneration,expectedIndexSha256})=>{assert.equal(source,root);assert.equal(expectedGeneration,76);assert.equal(expectedIndexSha256,pins.indexSha256);return {fixture:true};},
    preflightPhase:async input=>{
      assert.equal(input.reuseOnly,true);assert.equal(input.publicationRoot,options.runDirectory);assert.equal(native,0);
      assert.notEqual(input.directory,path.join(options.runDirectory,'candidate'));
      await write(input.directory,'manifest.json',{source:'disposable-preflight'});
      return {backendReads:0,backendWrites:0,counts:{nativeDispatched:0},ledgerManifestHash:pins.ledgerManifestHash,
        sourceBinding:{captureSha256:'b'.repeat(64)},scoringPreflight:{sourceSha256:'c'.repeat(64)}};
    },
    verifyPhase:async input=>{
      native++;assert.equal(input.root,root);assert.equal(input.publicationRoot,options.runDirectory);
      assert.equal(input.maxJobs,512);assert.equal(input.maxRuntimeMs,480000);
      assert.equal(input.expectedCaptureSha256,'b'.repeat(64));assert.equal(input.expectedScoringSha256,'c'.repeat(64));
      assert.equal(JSON.parse(await fs.readFile(path.join(input.directory,'manifest.json'),'utf8')).source,'public-76');
      return {receipt:{authority:false,actualAttestations:true},compile:async()=>{compiled++;return {fixture:true};},dispose:async()=>{disposed++;}};
    }};
  return {root,options,capabilities,counts:()=>({native,compiled,disposed})};
}

// Real local orchestration and ledger validation; only native/review adapters are synthetic.
async function publishedFixture(t){
 const f=await fixture(t),track='d'.repeat(64),content='e'.repeat(64),replay=deflateSync(Buffer.alloc(15)).toString('base64url');
 let clock=1000000,calls=0,compiled=0;
 const jobs=[1,2,3].map(n=>{const accountId=sha('account'+n);return {lane:'normal',accountId,trackId:track,
  timeMs:900+n,frames:900+n,uploadId:n,replay,replayHash:sha(replay),resultId:accountId+'_'+track};});
 const policy={engineDigest:'b'.repeat(64),compatibleEngines:[],verifierVersion:'polytrack-native-bounded-v1',
  verifierFingerprint:'c'.repeat(64),resourceProfiles:['standard'],reviewPolicyVersions:['snapshot-controls-v1'],
  trackContentHashes:{[track]:content},trackGeometries:{[track]:{geometryPolicy:'default',trackGeometry:{parts:20,spanX:100,spanZ:120}}}};
 Object.assign(f.options,{mode:'postpublication-offline',maxJobs:10000,maxRuntimeMs:5400000,
  finishDeadlineMs:clock+7000000,packagingReserveMs:900000});
 f.capabilities.now=()=>clock;
 f.capabilities.verifyPhase=async input=>{
  f.seenRuntime=input.maxRuntimeMs;
  const ledgerRoot=path.join(f.options.runDirectory,'native-test-ledger');
  await fs.cp(path.join(f.options.runDirectory,'verification-ledger'),ledgerRoot,{recursive:true,errorOnExist:true,force:false});
  const result=await verifyLocalSnapshot({root:f.root,jobs,allJobs:jobs,sourceBinding:{sourceCommit:input.sourceCommit,captureSha256:input.expectedCaptureSha256},
   ledgerRoot,expectedManifestHash:f.options.publishedBaseline.ledgerManifestHash,policy,validateEngine:async()=>{},
   maxJobs:input.maxJobs,maxRuntimeMs:input.maxRuntimeMs,batchSize:1,now:()=>clock,
   verify:async(_root,batch,_tracks,{profile})=>{
    assert.equal(profile,'standard');calls++;clock+=2700000;
    return batch.map(job=>{
     if(calls===2)return {resultId:job.resultId,trackId:track,timeMs:job.timeMs,replayHash:job.replayHash,status:'unavailable',reason:'fixture_unavailable'};
     const binding={verifierVersion:policy.verifierVersion,verifierFingerprint:policy.verifierFingerprint,resourceProfile:'standard',
      resultId:job.resultId,trackId:track,timeMs:job.timeMs,replayHash:job.replayHash,actualReplayHash:sha(replay),nativeTrackId:track,trackContentHash:content,engineDigest:policy.engineDigest};
     return {resultId:job.resultId,trackId:track,timeMs:job.timeMs,replayHash:job.replayHash,status:'verified',reason:'native_exact_finish',
      deterministic:true,engineDigest:policy.engineDigest,trackContentHash:content,...policy.trackGeometries[track],binding,boundInputFingerprint:sha(JSON.stringify(binding))};
    });
   },review:async({jobs:batch,nativeResults})=>({complete:true,results:nativeResults,reviews:batch.map(job=>({complete:true,disposition:'approved',
    bindingKey:ledgerKey(ledgerBinding(job)),policyVersion:'snapshot-controls-v1',attestationHash:sha('review'+job.resultId)}))})});
  const receipt={schemaVersion:1,kind:'completed-in-process-native-verification',authority:false,verificationComplete:result.complete,sourceCoverage:{complete:true,gaps:[]}};
  for(const key of ['sourceBinding','previousLedgerManifestHash','ledgerManifestHash','counts','decisions','engineDigest','verifierFingerprint','policySha256'])receipt[key]=result[key];
  f.actual=result;await input.nativeCompleted(receipt);
  if(f.throwAfterCallback)throw Error('phase failed after native callback');
  return {receipt,compile:async()=>{compiled++;const eligible=new Set(result.eligibleKeys);
   return {schemaVersion:1,authority:'snapshot-native',backendReads:0,backendWrites:0,compilationComplete:true,
    complete:result.complete,coverageComplete:result.complete,verificationCoverageComplete:result.complete,sourceCoverageComplete:true,
    sourceCoverage:receipt.sourceCoverage,sourceBinding:result.sourceBinding,ledgerManifestHash:result.ledgerManifestHash,
    rows:jobs.map(job=>({resultId:job.resultId,verified:eligible.has(ledgerKey(ledgerBinding(job)))}))};},dispose:async()=>{}};
 };
 return {...f,setClock:value=>{clock=value;},getClock:()=>clock,calls:()=>calls,compiled:()=>compiled,
  setThrow:()=>{f.throwAfterCallback=true;},runtime:()=>f.seenRuntime};
}

test('postpublication 90-minute clean partial return compiles only ledger-proven successes and retains pending rows',async t=>{
 const f=await publishedFixture(t),prepared=await preparePublishedOfflineVerification(f.options,f.capabilities),verified=await prepared.verify();
 assert.equal(f.calls(),2);assert.equal(f.runtime(),5400000);
 assert.equal(verified.receipt.verificationComplete,false);assert.equal(verified.compilationEligible,true);
 assert.equal(verified.terminalReceipt.boundedTerminalPass,true);assert.equal(verified.terminalReceipt.coverageComplete,false);
 assert.equal(verified.terminalReceipt.ledgerProvenKeys.length,1);assert.equal(verified.terminalReceipt.nativeNegativeOutcomesDurable,false);
 assert.deepEqual((await verified.compile()).rows.map(row=>row.verified),[true,false,false]);
 await assert.rejects(prepared.verify(),/already requested/);assert.equal(f.calls(),2);await verified.dispose();
 assert.equal(JSON.parse(await fs.readFile(path.join(f.options.runDirectory,'terminal-pass.json'))).compilationEligible,true);
});

test('preparation time is outside physics budget and deadline clamp reserves fifteen minutes',async t=>{
 const f=await publishedFixture(t),preflight=f.capabilities.preflightPhase;
 f.capabilities.preflightPhase=async input=>{f.setClock(f.getClock()+3000000);return preflight(input);};
 const prepared=await preparePublishedOfflineVerification(f.options,f.capabilities),verified=await prepared.verify();
 assert.equal(f.runtime(),3100000);assert.equal(verified.terminalReceipt.budget.maxRuntimeMs,3100000);
 assert.equal(verified.terminalReceipt.budget.packagingReserveMs,900000);await verified.dispose();
});

test('native entry reclamps after phase preparation, not only after public preparation',async t=>{
 const f=await publishedFixture(t),phase=f.capabilities.verifyPhase;
 f.capabilities.verifyPhase=input=>{f.setClock(f.getClock()+3000000);return phase(input);};
 const prepared=await preparePublishedOfflineVerification(f.options,f.capabilities),verified=await prepared.verify();
 assert.equal(f.runtime(),5400000);assert.equal(verified.terminalReceipt.budget.maxRuntimeMs,3100000);
 await verified.dispose();
});

test('expired preparation window dispatches nothing and cannot renew verification budget',async t=>{
 const f=await publishedFixture(t),prepared=await preparePublishedOfflineVerification(f.options,f.capabilities);
 f.setClock(f.options.finishDeadlineMs-900000);
 await assert.rejects(prepared.verify(),/no native time/);assert.equal(f.calls(),0);
 f.setClock(1000000);await assert.rejects(prepared.verify(),/already requested/);
});

test('absolute finish deadline blocks starting compilation without deleting completed receipts',async t=>{
 const f=await publishedFixture(t),prepared=await preparePublishedOfflineVerification(f.options,f.capabilities),verified=await prepared.verify();
 f.setClock(f.options.finishDeadlineMs);await assert.rejects(verified.compile(),/finish deadline/);
 assert.equal(f.compiled(),0);assert.equal(JSON.parse(await fs.readFile(path.join(f.options.runDirectory,'terminal-pass.json'))).boundedTerminalPass,true);
 await verified.dispose();
});

test('postpublication callback receipt followed by exception grants no compile or terminal-pass receipt',async t=>{
 const f=await publishedFixture(t);f.setThrow();const prepared=await preparePublishedOfflineVerification(f.options,f.capabilities);
 await assert.rejects(prepared.verify(),/phase failed/);assert.equal(f.compiled(),0);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.options.runDirectory,'verified.json'))).verificationComplete,false);
 await assert.rejects(fs.stat(path.join(f.options.runDirectory,'terminal-pass.json')),error=>error.code==='ENOENT');
 await assert.rejects(prepared.verify(),/already requested/);
});

test('an old private terminal receipt cannot substitute for this live pass or renew verification',async t=>{
 const f=await publishedFixture(t),prepared=await preparePublishedOfflineVerification(f.options,f.capabilities);
 const file=path.join(f.options.runDirectory,'terminal-pass.json');await fs.writeFile(file,'old private receipt');
 await assert.rejects(prepared.verify(),error=>error.code==='EEXIST');assert.equal(f.compiled(),0);
 assert.equal(await fs.readFile(file,'utf8'),'old private receipt');
 await assert.rejects(prepared.verify(),/already requested/);
});

test('partial compilation cannot be relabelled complete or claim successful compilation without its stage flag',async t=>{
 for(const patch of [{complete:true},{coverageComplete:true},{compilationComplete:false},{sourceCoverageComplete:false}]){
  const f=await publishedFixture(t),phase=f.capabilities.verifyPhase;
  f.capabilities.verifyPhase=async input=>{const live=await phase(input);return {...live,compile:async()=>({...await live.compile(),...patch})};};
  const prepared=await preparePublishedOfflineVerification(f.options,f.capabilities),verified=await prepared.verify();
  await assert.rejects(verified.compile(),/compilation completion|compiled coverage/);await verified.dispose();
 }
});

test('partial compile rejects changed fresh receipt and changed public pins',async t=>{
 for(const change of ['receipt','generation']){
  const f=await publishedFixture(t),prepared=await preparePublishedOfflineVerification(f.options,f.capabilities),verified=await prepared.verify();
  if(change==='receipt')await fs.appendFile(path.join(f.options.runDirectory,'terminal-pass.json'),' ');
  else await write(f.root,'snapshot-current.json',{currentdir:'public-snapshots77'});
  await assert.rejects(verified.compile());assert.equal(f.compiled(),0);await verified.dispose();
 }
});

test('ordinary capture budgets stay at 25 minutes and postpublication policy is explicit and bounded',async t=>{
 const f=await fixture(t);
 for(const patch of [{maxRuntimeMs:5400000},{mode:'unknown'},
  {mode:'postpublication-offline',maxRuntimeMs:5400001,finishDeadlineMs:Date.now()+10000000},
  {mode:'postpublication-offline',maxJobs:10001,finishDeadlineMs:Date.now()+10000000},
  {mode:'postpublication-offline'},{mode:'postpublication-offline',finishDeadlineMs:Date.now()+10000000,packagingReserveMs:0}])
  await assert.rejects(preparePublishedOfflineVerification({...f.options,...patch},f.capabilities));
 assert.equal(f.counts().native,0);
});

test('postpublication does not accept a phase return without the live local terminal result',async t=>{
 const f=await fixture(t);Object.assign(f.options,{mode:'postpublication-offline',finishDeadlineMs:Date.now()+10000000});
 const prepared=await preparePublishedOfflineVerification(f.options,f.capabilities);
 await assert.rejects(prepared.verify(),/clean terminal/);await assert.rejects(prepared.verify(),/already requested/);
});

test('prepares only public inputs, dry-compiles old proofs, then explicitly verifies once in isolation',async t=>{
  const f=await fixture(t),before=await fs.readFile(path.join(f.root,'verification-ledger-current.json'));
  const prepared=await preparePublishedOfflineVerification(f.options,f.capabilities);
  assert.deepEqual(f.counts(),{native:0,compiled:0,disposed:0});assert.equal(prepared.receipt.authority,false);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.options.runDirectory,'prepared.json'),'utf8')).publishedBaseline.ledgerEntries,0);
  const verified=await prepared.verify();
  assert.equal(JSON.parse(await fs.readFile(path.join(f.options.runDirectory,'verified.json'),'utf8')).actualAttestations,true);
  await assert.rejects(prepared.verify(),/already requested/);
  await verified.compile();await verified.dispose();
  assert.deepEqual(f.counts(),{native:1,compiled:1,disposed:1});
  assert((await fs.readFile(path.join(f.root,'verification-ledger-current.json'))).equals(before));
});

test('public 76 wrapper fixes the exact 4358-entry public ledger pins',async()=>{
  assert.equal(PUBLIC_76_VERIFICATION_BASELINE.ledgerEntries,4358);
  assert.equal(PUBLIC_76_VERIFICATION_BASELINE.generation,76);
  assert.throws(()=>preparePublic76OfflineVerification({publishedBaseline:{}}),/cannot be overridden/);
});

test('missing native runtime fails before creating a run or copying public data',async t=>{
 const f=await fixture(t);f.capabilities.validateRuntime=async()=>{throw Error('Missing pinned Playwright');};
 f.capabilities.hydrate=()=>assert.fail('No hydration before dependency acceptance');
 await assert.rejects(preparePublishedOfflineVerification(f.options,f.capabilities),/Missing pinned Playwright/);
 await assert.rejects(fs.stat(f.options.runDirectory),error=>error.code==='ENOENT');assert.equal(f.counts().native,0);
});

test('changed runtime after preparation cannot dispatch native work',async t=>{
 let changed=false;const f=await fixture(t);f.capabilities.validateRuntime=async()=>({version:changed?'other':'pinned'});
 const prepared=await preparePublishedOfflineVerification(f.options,f.capabilities);changed=true;
 await assert.rejects(prepared.verify(),/runtime changed/);assert.equal(f.counts().native,0);
});

test('native completion is durable before the phase returns and matches the returned receipt',async t=>{
 const f=await fixture(t),original=f.capabilities.verifyPhase;
 f.capabilities.verifyPhase=async input=>{
   const result=await original(input);await input.nativeCompleted(result.receipt);
   assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.options.runDirectory,'verified.json'),'utf8')),result.receipt);
   return result;
 };
 const prepared=await preparePublishedOfflineVerification(f.options,f.capabilities),verified=await prepared.verify();
 await verified.dispose();assert.deepEqual(f.counts(),{native:1,compiled:0,disposed:1});
});

test('failure after native completion retains exact receipt without compilation or native retry',async t=>{
 const f=await fixture(t),original=f.capabilities.verifyPhase;
 const receipt={authority:false,actualAttestations:true};
 f.capabilities.verifyPhase=async input=>{
   await original(input);await input.nativeCompleted(receipt);throw Error('Synthetic phase rename failed');
 };
 const prepared=await preparePublishedOfflineVerification(f.options,f.capabilities);
 await assert.rejects(prepared.verify(),/phase rename failed/);
 assert.equal(await fs.readFile(path.join(f.options.runDirectory,'verified.json'),'utf8'),JSON.stringify(receipt)+'\n');
 await assert.rejects(prepared.verify(),/already requested/);
 assert.deepEqual(f.counts(),{native:1,compiled:0,disposed:0});
});

for(const mode of ['different-return','repeated','repeated-different','caught-repeat'])
test('native completion rejects '+mode+' without replacing the first receipt or granting compile',async t=>{
 const f=await fixture(t),original=f.capabilities.verifyPhase;
 const receipt={authority:false,actualAttestations:true};
 f.capabilities.verifyPhase=async input=>{
   const result=await original(input);await input.nativeCompleted(receipt);
   if(mode==='different-return')return {...result,receipt:{...receipt,changed:true}};
   const again=()=>input.nativeCompleted(mode==='repeated-different'?{...receipt,changed:true}:receipt);
   if(mode==='caught-repeat')await assert.rejects(again(),/repeated/);
   else await again();
   return result;
 };
 const prepared=await preparePublishedOfflineVerification(f.options,f.capabilities);
 await assert.rejects(prepared.verify(),mode==='different-return'?/differs/:/repeated/);
 assert.equal(await fs.readFile(path.join(f.options.runDirectory,'verified.json'),'utf8'),JSON.stringify(receipt)+'\n');
 await assert.rejects(prepared.verify(),/already requested/);
 assert.deepEqual(f.counts(),{native:1,compiled:0,disposed:['different-return','caught-repeat'].includes(mode)?1:0});
});

test('early receipt write is exclusive and a caught write failure still blocks compilation',async t=>{
 const f=await fixture(t),original=f.capabilities.verifyPhase;
 f.capabilities.verifyPhase=async input=>{
   const result=await original(input);
   await assert.rejects(input.nativeCompleted(result.receipt),error=>error.code==='EEXIST');return result;
 };
 const prepared=await preparePublishedOfflineVerification(f.options,f.capabilities);
 const target=path.join(f.options.runDirectory,'verified.json');await fs.writeFile(target,'preserved');
 await assert.rejects(prepared.verify(),error=>error.code==='EEXIST');
 assert.equal(await fs.readFile(target,'utf8'),'preserved');
 await assert.rejects(prepared.verify(),/already requested/);
 assert.deepEqual(f.counts(),{native:1,compiled:0,disposed:1});
});

for(const field of ['proofCheckpoint','ledgerRoot','captureContext','directory','verify','publicationRoot'])test('rejects private or alternate authority input: '+field,async t=>{
  const f=await fixture(t);
  await assert.rejects(preparePublishedOfflineVerification({...f.options,[field]:'private-failed-proof'},f.capabilities),/unknown option/);
  assert.equal(f.counts().native,0);
  await assert.rejects(fs.stat(f.options.runDirectory),error=>error.code==='ENOENT');
});

test('changed public pin stops preparation before writing a run or dispatching native',async t=>{
  const f=await fixture(t);f.options.publishedBaseline.indexSha256='f'.repeat(64);
  await assert.rejects(preparePublishedOfflineVerification(f.options,f.capabilities),/index changed/);
  await assert.rejects(fs.stat(f.options.runDirectory),error=>error.code==='ENOENT');
});

test('changed public baseline after preparation stops the one-shot native request',async t=>{
  const f=await fixture(t),prepared=await preparePublishedOfflineVerification(f.options,f.capabilities);
  await write(f.root,'snapshot-current.json',{currentdir:'public-snapshots77'});
  await assert.rejects(prepared.verify(),/generation changed/);assert.equal(f.counts().native,0);
});

test('changed public baseline after actual verification blocks compilation without promoting receipts',async t=>{
  const f=await fixture(t),prepared=await preparePublishedOfflineVerification(f.options,f.capabilities),verified=await prepared.verify();
  await write(f.root,'snapshot-current.json',{currentdir:'public-snapshots77'});
  await assert.rejects(verified.compile(),/generation changed/);assert.equal(f.counts().compiled,0);
  await verified.dispose();
});

test('nonzero native preflight, reused directories and excess budgets fail closed',async t=>{
  const f=await fixture(t);
  for(const patch of [{maxJobs:10001},{maxRuntimeMs:1500001},{maxRuntimeMs:60000},{runDirectory:f.root}])
    await assert.rejects(preparePublishedOfflineVerification({...f.options,...patch},f.capabilities));
  await assert.rejects(preparePublishedOfflineVerification(f.options,{...f.capabilities,
    preflightPhase:async()=>({backendReads:0,backendWrites:0,counts:{nativeDispatched:1},ledgerManifestHash:f.options.publishedBaseline.ledgerManifestHash})}),/changed proof authority/);
  await assert.rejects(preparePublishedOfflineVerification(f.options,f.capabilities),error=>error.code==='EEXIST');
});


test('above16MiB index passes public preparation, lower published budget and partial compilation without widened physics limits',async t=>{
 const f=await publishedFixture(t),file=path.join(f.root,'public-snapshots76/index.json'),head=await fs.readFile(file);await fs.writeFile(file,Buffer.concat([head,Buffer.alloc(17*1024*1024-head.length,32)]));f.options.publishedBaseline.indexSha256=sha(await fs.readFile(file));
 const prepared=await preparePublishedOfflineVerification(f.options,f.capabilities),verified=await prepared.verify();assert.equal(f.runtime(),5400000);assert.equal(verified.compilationEligible,true);assert.equal((await verified.compile()).compilationComplete,true);await verified.dispose();
});
test('above20MiB public index stops before preparation/native and ledger pointer size remains2048',async t=>{
 const f=await fixture(t),file=path.join(f.root,'public-snapshots76/index.json');let h=await fs.open(file,'r+');await h.truncate(20*1024*1024+1);await h.close();await assert.rejects(preparePublishedOfflineVerification(f.options,f.capabilities),/unsafe public input/);assert.equal(f.counts().native,0);
 await write(f.root,'public-snapshots76/index.json',{generation:76,fixture:true});f.options.publishedBaseline.indexSha256=sha(await fs.readFile(file));await fs.appendFile(path.join(f.root,'verification-ledger-current.json'),' '.repeat(2048));await assert.rejects(preparePublishedOfflineVerification(f.options,f.capabilities),/unsafe public input/);assert.equal(f.counts().native,0);
});
