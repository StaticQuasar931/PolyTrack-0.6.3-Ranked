import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeLedger} from './native-verification-ledger.mjs';
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
