import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {encryptCaptureRecovery,restoreCaptureRecovery} from './capture-recovery.mjs';
import {preflightLocalCaptureCheckpoints,createLocalCaptureCheckpoint,retainLocalCaptureFailure,createLocalNativePhaseReceipt} from './local-capture-checkpoint.mjs';

const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const recipientPublicKey=keys.publicKey.export({type:'spki',format:'pem'});
const sourceCommit='a'.repeat(40),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const binding={sourceCommit,captureSha256:'b'.repeat(64)},ledgerManifestHash='c'.repeat(64);
async function fixture(t){
  t.mock.method(globalThis,'fetch',()=>assert.fail('Offline checkpoint tests forbid network'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'local-checkpoint-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'private'),staging=path.join(root,'local-reports/snapshot-staging');
  await fs.mkdir(directory);await fs.mkdir(staging,{recursive:true});
  const recoveryPublicKeyFile=path.join(directory,'recipient.public.pem');
  await fs.writeFile(recoveryPublicKeyFile,recipientPublicKey);
  await fs.writeFile(path.join(staging,'manifest.json'),'{}\n');
  const baseFile=path.join(root,'local-reports/snapshot-staging-base.json');
  const baseBytes=Buffer.from('{"schemaVersion":1,"generation":72}\n');await fs.writeFile(baseFile,baseBytes);
  const options={root,directory,recipientPublicKey,sourceCommit};
  const preflight=()=>preflightLocalCaptureCheckpoints({workspace:root,directory,recoveryPublicKeyFile});
  const read=name=>fs.readFile(path.join(directory,name),'utf8').then(JSON.parse);
  return {root,directory,staging,baseFile,baseBytes,recoveryPublicKeyFile,options,preflight,read};
}

test('preflight is offline, leaves no probe, and reserves no future output',async t=>{
  const f=await fixture(t),before=(await fs.readdir(f.directory)).sort();
  assert.equal((await f.preflight()).recipientPublicKey,recipientPublicKey);
  assert.deepEqual((await fs.readdir(f.directory)).sort(),before);
  await f.preflight();
});

test('preflight rejects every reserved archive and receipt without overwriting',async t=>{
  const f=await fixture(t);
  for(const name of ['capture','failure','proofs','timeout'])for(const suffix of ['.ptenc','.receipt.json']){
    const file=path.join(f.directory,name+suffix);await fs.writeFile(file,'existing');
    await assert.rejects(f.preflight(),{code:'EEXIST'});assert.equal(await fs.readFile(file,'utf8'),'existing');
    await fs.unlink(file);
  }
});

test('preflight rejects malformed, private, and oversized recipients',async t=>{
  const f=await fixture(t);
  for(const bytes of ['not a key',keys.privateKey.export({type:'pkcs8',format:'pem'}),'x'.repeat(6145)]){
    await fs.writeFile(f.recoveryPublicKeyFile,bytes);await assert.rejects(f.preflight());
    assert.deepEqual(await fs.readdir(f.directory),['recipient.public.pem']);
  }
});

test('preflight fails before capture on an unwritable output directory',async t=>{
  const f=await fixture(t),open=fs.open;
  t.mock.method(fs,'open',async(file,...args)=>{
    if(path.basename(file).startsWith('.checkpoint-preflight-'))throw Object.assign(Error('private detail'),{code:'EACCES'});
    return open.call(fs,file,...args);
  });
  await assert.rejects(f.preflight(),{code:'EACCES'});
});

for(const [phase,name] of [['pre-native','capture'],['failure-state','failure'],['native-proofs','proofs']])
test(phase+' persists real encryption evidence and exact staging-base identity',async t=>{
  const f=await fixture(t);await f.preflight();
  const proof=phase==='native-proofs'?{sourceBinding:binding,ledgerManifestHash}:{};
  const result=await createLocalCaptureCheckpoint(f.options)({directory:f.staging,sourceCommit,phase,...proof});
  const receipt=await f.read(name+'.receipt.json'),bytes=await fs.readFile(path.join(f.directory,name+'.ptenc'));
  assert.equal(receipt.status,'complete');assert.equal(receipt.authority,false);assert.equal(receipt.sourceCommit,sourceCommit);
  assert.equal(receipt.phase,phase);assert.equal(receipt.encryption.ciphertextSha256,sha(bytes));
  assert.equal(receipt.encryption.ciphertextSha256,result.ciphertextSha256);
  assert.deepEqual(receipt.stagingBase,{path:'local-reports/snapshot-staging-base.json',present:true,schemaVersion:1,
    generation:72,sha256:sha(f.baseBytes),bytes:f.baseBytes.length});
  assert.deepEqual(receipt.sourceBinding,proof.sourceBinding??null);
  assert.equal(receipt.ledgerManifestHash,proof.ledgerManifestHash??null);
  const restored=path.join(f.root,'restored');
  await restoreCaptureRecovery({inputFile:path.join(f.directory,name+'.ptenc'),destination:restored,
    privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}),expectedSha256:receipt.encryption.ciphertextSha256,sourceCommit,
    attempt:'overnight-capture',expectedPhase:phase,
    ...(phase==='native-proofs'?{expectedSourceBinding:binding,expectedLedgerManifestHash:ledgerManifestHash}:{})});
  assert.equal(await fs.readFile(path.join(restored,'manifest.json'),'utf8'),'{}\n');
  await assert.rejects(createLocalCaptureCheckpoint(f.options)({directory:f.staging,phase,...proof}),{code:'EEXIST'});
  assert((await fs.readFile(path.join(f.directory,name+'.ptenc'))).equals(bytes));
});

test('missing staging base is explicit, never invented',async t=>{
  const f=await fixture(t);await fs.unlink(f.baseFile);
  await createLocalCaptureCheckpoint(f.options)({directory:f.staging});
  assert.deepEqual((await f.read('capture.receipt.json')).stagingBase,{path:'local-reports/snapshot-staging-base.json',present:false});
});

test('encryption failure persists sanitized failure and throws the identical original error',async t=>{
  const f=await fixture(t),error=Object.assign(Error('secret token private/key/path'),{code:'SECRET_TOKEN'});
  const checkpoint=createLocalCaptureCheckpoint({...f.options,encrypt:async()=>{throw error;}});
  await assert.rejects(checkpoint({directory:f.staging}),actual=>actual===error);
  const receipt=await f.read('capture.receipt.json');
  assert.equal(receipt.status,'failed');assert.equal(receipt.encryption,null);
  assert.deepEqual(receipt.failure,{operation:'encryption',code:'CHECKPOINT_FAILED'});
  assert(!JSON.stringify(receipt).includes('secret'));assert(!JSON.stringify(receipt).includes('private/key'));
  await assert.rejects(fs.stat(path.join(f.directory,'capture.ptenc')),{code:'ENOENT'});
  await assert.rejects(checkpoint({directory:f.staging}),{code:'EEXIST'});
});

test('real encryption errors are recorded, including safe errno only',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.staging,'private-key.pem'),'synthetic unsafe inventory');
  await assert.rejects(createLocalCaptureCheckpoint(f.options)({directory:f.staging}));
  assert.equal((await f.read('capture.receipt.json')).status,'failed');
  const diskError=Object.assign(Error('secret path'),{code:'ENOSPC'});
  await assert.rejects(createLocalCaptureCheckpoint({...f.options,encrypt:async()=>{throw diskError;}})
    ({directory:f.staging,phase:'failure-state'}),actual=>actual===diskError);
  assert.equal((await f.read('failure.receipt.json')).failure.code,'ENOSPC');
});

test('invalid callback bindings never invoke encryption or create receipts',async t=>{
  const f=await fixture(t),checkpoint=createLocalCaptureCheckpoint({...f.options,encrypt:async()=>assert.fail('invalid capability call')});
  for(const patch of [{sourceCommit:'d'.repeat(40)},{phase:'unknown'},{phase:'toString'},
    {sourceBinding:binding},{phase:'native-proofs',sourceBinding:{...binding,sourceCommit:'d'.repeat(40)},ledgerManifestHash}]){
    await assert.rejects(checkpoint({directory:f.staging,...patch}));
  }
  assert.deepEqual(await fs.readdir(f.directory),['recipient.public.pem']);
});

test('a changing staging base cannot produce a successful receipt',async t=>{
  const f=await fixture(t);
  const checkpoint=createLocalCaptureCheckpoint({...f.options,encrypt:async options=>{
    const result=await encryptCaptureRecovery(options);
    await fs.writeFile(f.baseFile,'{"schemaVersion":1,"generation":73}\n');return result;
  }});
  await assert.rejects(checkpoint({directory:f.staging}),/staging base changed/);
  const receipt=await f.read('capture.receipt.json');assert.equal(receipt.status,'failed');
  assert.equal(receipt.failure.operation,'staging-base-recheck');assert.equal(receipt.stagingBase.generation,72);
  assert.equal(receipt.encryption.ciphertextSha256,sha(await fs.readFile(path.join(f.directory,'capture.ptenc'))));
});

test('receipt persistence failure remains visible without masking encryption error',async t=>{
  const f=await fixture(t),open=fs.open,error=Error('original secret encryption failure'),messages=[];
  t.mock.method(console,'error',message=>messages.push(message));
  t.mock.method(fs,'open',async(file,...args)=>{
    const handle=await open.call(fs,file,...args);
    if(file.endsWith('.receipt.json'))return {truncate:async()=>{throw Error('private storage detail');},close:()=>handle.close()};
    return handle;
  });
  await assert.rejects(createLocalCaptureCheckpoint({...f.options,encrypt:async()=>{throw error;}})
    ({directory:f.staging}),actual=>actual===error);
  assert.deepEqual(messages,['Local capture checkpoint failure receipt could not be persisted.']);
});

test('receipt sync failure cannot return success or leave a successful receipt',async t=>{
  const f=await fixture(t),open=fs.open,error=Object.assign(Error('private sync detail'),{code:'EIO'});
  t.mock.method(fs,'open',async(file,...args)=>{
    const handle=await open.call(fs,file,...args);
    if(!file.endsWith('.receipt.json'))return handle;
    let calls=0;
    return {truncate:size=>handle.truncate(size),write:(...values)=>handle.write(...values),
      sync:()=>++calls===1?Promise.reject(error):handle.sync(),close:()=>handle.close()};
  });
  await assert.rejects(createLocalCaptureCheckpoint(f.options)({directory:f.staging}),actual=>actual===error);
  const receipt=await f.read('capture.receipt.json');
  assert.equal(receipt.status,'failed');assert.deepEqual(receipt.failure,{operation:'receipt',code:'EIO'});
  assert.equal(receipt.encryption.ciphertextSha256,sha(await fs.readFile(path.join(f.directory,'capture.ptenc'))));
});

test('a reserved receipt alone prevents encryption and remains byte-identical',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'capture.receipt.json');await fs.writeFile(file,'prior failure');
  await assert.rejects(createLocalCaptureCheckpoint({...f.options,encrypt:async()=>assert.fail('must not encrypt')})
    ({directory:f.staging}),{code:'EEXIST'});
  assert.equal(await fs.readFile(file,'utf8'),'prior failure');
});

test('failure recovery logs secondary errors and preserves the capture exception',async t=>{
  const f=await fixture(t),messages=[],original=Error('capture failed');
  t.mock.method(console,'error',message=>messages.push(message));
  const checkpoint=createLocalCaptureCheckpoint({...f.options,encrypt:async()=>{throw Error('private encryption error');}});
  await assert.rejects((async()=>{try{throw original;}catch(error){
    await retainLocalCaptureFailure({staging:f.staging,sourceCommit,checkpoint});throw error;
  }})(),error=>error===original);
  assert.equal((await f.read('failure.receipt.json')).status,'failed');
  assert.deepEqual(messages,['Local capture recovery checkpoint failed; original capture error preserved.']);
});

test('worker uses preflight before admission/credentials and routes both callback capabilities',async()=>{
  const worker=await fs.readFile(fileURLToPath(new URL('./local-capture-worker.mjs',import.meta.url)),'utf8');
  const start=worker.indexOf('export async function captureLocalSource'),body=worker.slice(start);
  assert(body.indexOf('await preflightLocalCaptureCheckpoints')<body.indexOf('await assertLocalCaptureOwner'));
  assert(body.indexOf('await preflightLocalCaptureCheckpoints')<body.indexOf('process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT='));
  assert(body.includes('captureCheckpoint:checkpoint'));assert(body.includes('proofCheckpoint:'));
  assert(body.includes('await retainLocalCaptureFailure'));assert(!body.includes('.catch(()=>{})'));
  assert(worker.includes("import {runNativeSnapshotPhase} from './native-snapshot-phase.mjs'"));
  assert(body.includes('nativePhase:createLocalNativePhaseReceipt({root,directory,owner,testedCommit:receipt.testedCommit,nativePhase:runNativeSnapshotPhase})'));
});

const owner='11111111-1111-1111-1111-111111111111';
function nativeResult(){
  return {schemaVersion:1,authority:'snapshot-native',backendReads:0,backendWrites:0,complete:true,
    sourceBinding:{...binding},ledgerManifestHash,counts:{known:1,verified:1,held:0,excluded:0,mismatch:0,
      unavailable:0,unprocessed:0,reusedPhysics:0,nativeDispatched:1,nativeBatches:1,sourceJobs:1,targets:1,serverAccepted:0}};
}
function nativeOptions(f){return {root:f.root,directory:f.staging,sourceCommit,reuseOnly:false};}
function nativeWrapper(f,nativePhase){
  return createLocalNativePhaseReceipt({root:f.root,directory:f.directory,owner,testedCommit:sourceCommit,nativePhase});
}

test('preflight rejects an existing native completion receipt without modifying it',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'native-complete.receipt.json');
  await fs.writeFile(file,'prior');await assert.rejects(f.preflight(),{code:'EEXIST'});
  assert.equal(await fs.readFile(file,'utf8'),'prior');
});

test('native receipt is written only after the awaited phase and before packaging',async t=>{
  const f=await fixture(t),result=nativeResult(),options=nativeOptions(f),order=[];
  result.privateProofCheckpoint={privateKey:'must not copy'};result.secret='must not copy';
  const run=nativeWrapper(f,async actual=>{
    assert.strictEqual(actual,options);order.push('native-start');
    await assert.rejects(fs.stat(path.join(f.directory,'native-complete.receipt.json')),{code:'ENOENT'});
    await Promise.resolve();order.push('native-return');return result;
  });
  assert.strictEqual(await run(options),result);
  const receipt=await f.read('native-complete.receipt.json');order.push('packaging');
  assert.deepEqual(order,['native-start','native-return','packaging']);
  assert.deepEqual(receipt,{schemaVersion:1,kind:'private-native-phase-completion',owner,testedCommit:sourceCommit,
    sourceBinding:binding,ledgerManifestHash,backendReads:0,backendWrites:0,counts:result.counts,complete:true});
  assert(!Object.hasOwn(receipt,'authority'));assert(!JSON.stringify(receipt).includes('must not copy'));
});

test('a returned but incomplete native phase is recorded honestly',async t=>{
  const f=await fixture(t),result=nativeResult();result.complete=false;result.counts.unprocessed=1;result.counts.verified=0;
  await nativeWrapper(f,async()=>result)(nativeOptions(f));
  const receipt=await f.read('native-complete.receipt.json');assert.equal(receipt.complete,false);
  assert.equal(receipt.counts.unprocessed,1);
});

test('a throwing native phase never creates a completion receipt and retains the original error',async t=>{
  const f=await fixture(t),error=Error('native verification failed');let calls=0;
  await assert.rejects(nativeWrapper(f,async()=>{calls++;throw error;})(nativeOptions(f)),actual=>actual===error);
  assert.equal(calls,1);await assert.rejects(fs.stat(path.join(f.directory,'native-complete.receipt.json')),{code:'ENOENT'});
});

test('invalid invocation cannot dispatch native physics or write a receipt',async t=>{
  const f=await fixture(t),run=nativeWrapper(f,async()=>assert.fail('must not invoke native phase'));
  for(const patch of [{root:path.dirname(f.root)},{directory:f.directory},{sourceCommit:'d'.repeat(40)},
    {reuseOnly:true},{reuseOnly:undefined}])await assert.rejects(run({...nativeOptions(f),...patch}));
  await assert.rejects(fs.stat(path.join(f.directory,'native-complete.receipt.json')),{code:'ENOENT'});
});

test('invalid usage, source/ledger binding, flags and counts cannot mint completion evidence',async t=>{
  const f=await fixture(t);
  const patches=[{backendReads:1},{backendWrites:1},{backendReads:undefined},{schemaVersion:2},
    {authority:'stored-proof-overlay'},{complete:undefined},{ledgerManifestHash:'bad'},
    {sourceBinding:{...binding,sourceCommit:'d'.repeat(40)}},{sourceBinding:{...binding,captureSha256:'bad'}},
    {sourceBinding:{...binding,extra:'secret'}},{counts:null},{counts:{...nativeResult().counts,secret:'key'}},
    {counts:{...nativeResult().counts,nativeDispatched:-1}},{counts:{...nativeResult().counts,known:1.5}},
    {counts:{...nativeResult().counts,unavailable:1}},{counts:{...nativeResult().counts,unprocessed:1}}];
  for(const patch of patches){
    await assert.rejects(nativeWrapper(f,async()=>({...nativeResult(),...patch}))(nativeOptions(f)));
    await assert.rejects(fs.stat(path.join(f.directory,'native-complete.receipt.json')),{code:'ENOENT'});
  }
});

test('completion receipt remains wx and an existing receipt prevents repeat native work',async t=>{
  const f=await fixture(t);let calls=0;
  const run=nativeWrapper(f,async()=>{calls++;return nativeResult();});await run(nativeOptions(f));
  const file=path.join(f.directory,'native-complete.receipt.json'),before=await fs.readFile(file);
  await assert.rejects(run(nativeOptions(f)),{code:'EEXIST'});assert.equal(calls,1);
  assert((await fs.readFile(file)).equals(before));
});

test('a receipt appearing during native work cannot be overwritten or removed',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'native-complete.receipt.json');
  await assert.rejects(nativeWrapper(f,async()=>{
    await fs.writeFile(file,'other evidence',{flag:'wx'});return nativeResult();
  })(nativeOptions(f)),{code:'EEXIST'});
  assert.equal(await fs.readFile(file,'utf8'),'other evidence');
});

test('receipt write/sync failure blocks packaging, removes owned evidence, and preserves the error',async t=>{
  const f=await fixture(t),open=fs.open,error=Object.assign(Error('private storage detail'),{code:'EIO'});
  t.mock.method(fs,'open',async(file,...args)=>{
    const handle=await open.call(fs,file,...args);if(!file.endsWith('native-complete.receipt.json'))return handle;
    return {truncate:size=>handle.truncate(size),write:(...values)=>handle.write(...values),
      sync:async()=>{throw error;},close:()=>handle.close()};
  });
  await assert.rejects(nativeWrapper(f,async()=>nativeResult())(nativeOptions(f)),actual=>actual===error);
  await assert.rejects(fs.stat(path.join(f.directory,'native-complete.receipt.json')),{code:'ENOENT'});
});


test('preflight rejects output inside staging through a workspace junction',async t=>{
  const f=await fixture(t),alias=path.join(f.root,'workspace-alias'),directory=path.join(f.staging,'private');
  await fs.mkdir(directory);await fs.symlink(f.root,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(preflightLocalCaptureCheckpoints({workspace:alias,directory,
    recoveryPublicKeyFile:f.recoveryPublicKeyFile}),/outside staging/);
  assert.deepEqual(await fs.readdir(directory),[]);
});

test('preflight resolves workspace ancestors before staging exists',async t=>{
  const f=await fixture(t),alias=path.join(f.root,'workspace-alias');
  await fs.rm(f.staging,{recursive:true});
  await fs.symlink(f.root,alias,process.platform==='win32'?'junction':'dir');
  assert.equal((await preflightLocalCaptureCheckpoints({workspace:alias,directory:f.directory,
    recoveryPublicKeyFile:f.recoveryPublicKeyFile})).recipientPublicKey,recipientPublicKey);
  assert.deepEqual(await fs.readdir(f.directory),['recipient.public.pem']);
});
