import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {generateKeyPairSync,createHash,privateDecrypt,createDecipheriv,constants} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {validateRecoveryRecipient,encryptCaptureRecovery} from './capture-recovery.mjs';
import {pushPublicCapture} from './push-public-capture.mjs';
const workflow=(await fs.readFile(new URL('../.github/workflows/publish-verified-snapshots.yml',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const step=name=>{const value=workflow.split(/(?=^      - )/m).find(block=>block.startsWith('      - name: '+name+'\n'));assert.ok(value,name);return value;};
const heredoc=(name,marker)=>{const match=new RegExp("<<'"+marker+"'\\n([\\s\\S]*?)^          "+marker+'$','m').exec(step(name));assert.ok(match,marker);return match[1].replace(/^          /gm,'').replace(/^import [^\n]+\n/gm,'');};
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const keys=generateKeyPairSync('rsa',{modulusLength:2048}),publicKey=keys.publicKey.export({type:'spki',format:'pem'}),sourceCommit='a'.repeat(40);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function decrypt(bytes){
  const magic=Buffer.from('PTREC01\n');assert(bytes.subarray(0,magic.length).equals(magic));
  const start=magic.length+4,end=start+bytes.readUInt32BE(magic.length),encoded=bytes.subarray(start,end),header=JSON.parse(encoded);
  const secret=privateDecrypt({key:keys.privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(header.wrappedKey,'base64'));
  const cipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(header.iv,'base64'));cipher.setAAD(encoded);cipher.setAuthTag(bytes.subarray(-16));
  let decoded;try{decoded=gunzipSync(Buffer.concat([cipher.update(bytes.subarray(end,-16)),cipher.final()]));}finally{secret.fill(0);}
  const [inventory,...records]=decoded.toString('utf8').trimEnd().split('\n').map(row=>JSON.parse(row));
  assert.equal(inventory.entries.length,records.length);
  for(const [index,record]of records.entries())assert.equal(hash(Buffer.from(record.data,'base64')),inventory.entries[index].sha256);
  return {header,records};
}
async function authority(env={}){
  let output='';
  const run=new AsyncFunction('fs','validateRecoveryRecipient','verificationAuthority','readRepositoryVerificationAuthority','process',
    heredoc('Validate verification authority','AUTHORITY'));
  await run({appendFileSync:(_file,text)=>{output+=text;}},validateRecoveryRecipient,
    value=>{assert(['firestore','snapshot-native'].includes(value));},async(_root,value)=>value||'firestore',
    {cwd:()=>'/fixture',env:{GITHUB_OUTPUT:'output',...env}});
  return output;
}
test('recovery preflight requires a valid public recipient before native admission and preserves repair-2 input validation',async()=>{
  for(const env of [{OVERNIGHT_NATIVE:'true'},{VERIFICATION_AUTHORITY:'snapshot-native'}]){
    await assert.rejects(authority(env),/requires a recovery public key/);
    assert.match(await authority({...env,RECOVERY_PUBLIC_KEY_FALLBACK:publicKey}),/recovery_enabled=true/);
  }
  assert.match(await authority(),/mode=firestore\nrecovery_enabled=false/);
  assert.match(await authority({RECOVERY_PUBLIC_KEY:publicKey,RECOVERY_PUBLIC_KEY_FALLBACK:'invalid'}),/recovery_enabled=true/);
  await assert.rejects(authority({RECOVERY_PUBLIC_KEY:'invalid',RECOVERY_PUBLIC_KEY_FALLBACK:publicKey}));
  await assert.rejects(authority({RECOVERY_PUBLIC_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'})}));
  const repair={VERIFICATION_AUTHORITY:'snapshot-native',OVERNIGHT_NATIVE:'true',REPLACEMENT_CAPTURE:'true',GITHUB_EVENT_NAME:'workflow_dispatch',REPAIR_ATTEMPT:'repair-2'};
  await assert.rejects(authority({...repair,RECOVERY_PUBLIC_KEY_FALLBACK:publicKey}),/Public recovery recipient/);
  assert.match(await authority({...repair,RECOVERY_PUBLIC_KEY:publicKey}),/recovery_enabled=true/);
  await assert.rejects(authority({...repair,REPLACEMENT_CAPTURE:'false',RECOVERY_PUBLIC_KEY:publicKey}),/replacement authority/);
  assert.ok(workflow.indexOf(step('Validate verification authority'))<workflow.indexOf(step('Guard the one-time overnight capture')));
});

test('workflow binds fallback keys and source pins, and uploads only explicit ciphertext files for three days after failed publication',()=>{
  for(const name of ['Capture bounded public snapshots','Preserve encrypted failure checkpoint when needed'])
    assert.match(step(name),/RECOVERY_PUBLIC_KEY: \$\{\{ inputs.recovery_public_key \|\| vars.POLYTRACK_CAPTURE_RECOVERY_PUBLIC_KEY \}\}/);
  const pin=step('Pin offline verification source commit');assert.match(pin,/recovery_enabled == 'true'/);
  assert.ok(workflow.indexOf(pin)<workflow.indexOf(step('Capture public event assignments')));
  const capture=step('Capture bounded public snapshots');assert.match(capture,/sourceCommit=process.env.SNAPSHOT_NATIVE_SOURCE_COMMIT/);
  assert.match(capture,/else\n            node tools\/update-public-snapshot.mjs --refresh-replays\n          fi/);
  for(const [name,file] of [['Retain encrypted recovery checkpoint','polytrack-recovery.ptenc'],['Retain encrypted private proof checkpoint','polytrack-native-proofs.ptenc']]){
    const upload=step(name);assert.match(upload,/actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
    assert(upload.includes('path: ${{ runner.temp }}/'+file));assert.match(upload,/retention-days: 3/);assert.match(upload,/if-no-files-found: error/);
    assert.doesNotMatch(upload,/snapshot-staging|local-reports|PRIVATE_KEY|SERVICE_ACCOUNT|\*\.ptenc/);
    assert.ok(workflow.indexOf(upload)>workflow.indexOf(step('Commit changed assignments')));
  }
  assert.match(step('Preserve encrypted failure checkpoint when needed'),/if: always\(\) && steps.authority.outputs.recovery_enabled == 'true'/);
  assert.match(step('Locate encrypted private proof checkpoint'),/if: always\(\)/);
  assert.match(step('Retain encrypted private proof checkpoint'),/if: always\(\) && steps.proof_recovery.outputs.ready == 'true'/);
  assert.match(step('Test offline native authority contracts'),/tools\/native-snapshot-phase.test.mjs/);
  assert.match(step('Test conflict-safe publishing'),/tools\/snapshot-recovery-workflow.test.mjs/);
  assert.match(step('Test snapshot integrity and resumable capture'),/tools\/snapshot-replay-completeness.test.mjs/);
});

async function captureFixture(t){
  t.mock.method(globalThis,'fetch',()=>assert.fail('workflow recovery must remain offline'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'snapshot-recovery-workflow-')),runner=path.join(root,'runner');await fs.mkdir(runner);
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});
  const staging=path.join(root,'local-reports/snapshot-staging');await fs.mkdir(staging,{recursive:true});
  await fs.writeFile(path.join(staging,'capture.json'),JSON.stringify({replay:'private-fixture-replay',sourceCommit}));
  const proof=path.join(root,'proof');await fs.mkdir(proof);await fs.writeFile(path.join(proof,'receipt.json'),'{}\n');
  const run=new AsyncFunction('updatePublicSnapshot','reportCaptureOutcome','OVERNIGHT_SNAPSHOT','path','fs','CAPTURE_REPAIR_SECOND',
    'encryptCaptureRecovery','process','console',heredoc('Capture bounded public snapshots','ONEOFF'));
  const sourceBinding={sourceCommit,captureSha256:'c'.repeat(64)},ledgerManifestHash='d'.repeat(64);
  return {root,runner,staging,proof,sourceBinding,ledgerManifestHash,execute:async({stage='success',mode='snapshot-native',oneOff=true,repair=false}={})=>{
    let received;
    await run(async options=>{
      received=options;assert.equal(options.verificationAuthority,mode);
      if(stage==='legacy')return {};
      if(stage==='early-gate')throw Error('injected early-gate');
      await options.captureCheckpoint({directory:staging,sourceCommit});
      if(stage==='native')throw Error('injected native');
      await options.nativePhaseOptions.proofCheckpoint({directory:proof,sourceBinding,ledgerManifestHash});
      if(stage==='strict-gate')throw Error('injected strict-gate');
      return {nativeVerification:{backendReads:0,backendWrites:0}};
    },async()=>{}, {maxJobs:10000,maxRuntimeMs:1500000,replayDocumentLimit:1000},
    {...path,resolve:value=>path.resolve(root,value)},fs,{replayDocumentLimit:1000},encryptCaptureRecovery,
    {env:{RUNNER_TEMP:runner,RECOVERY_PUBLIC_KEY:publicKey,SNAPSHOT_NATIVE_SOURCE_COMMIT:sourceCommit,VERIFICATION_AUTHORITY:mode,
      ONE_OFF_NATIVE:String(oneOff),REPAIR_ATTEMPT:repair?'repair-2':'repair-1'}},{log:()=>{}});
    return received;
  }};
}

for(const stage of ['native','strict-gate','early-gate'])test('actual keyed capture script retains decryptable exact-source ciphertext after '+stage+' failure',async t=>{
  const f=await captureFixture(t);
  await assert.rejects(f.execute({stage}),new RegExp('injected '+stage));
  const raw=await fs.readFile(path.join(f.runner,'polytrack-recovery.ptenc')),decoded=decrypt(raw);
  assert.equal(decoded.header.sourceCommit,sourceCommit);assert.equal(decoded.header.attempt,'overnight-capture');assert.equal(decoded.header.phase,stage==='early-gate'?'failure-state':'pre-native');
  assert.equal(raw.includes(Buffer.from('private-fixture-replay')),false);
  assert.equal(decoded.records[0].path,'capture.json');
  assert.deepEqual(JSON.parse(Buffer.from(decoded.records[0].data,'base64')),JSON.parse(await fs.readFile(path.join(f.staging,'capture.json'),'utf8')));
  if(stage==='strict-gate')assert.deepEqual(decrypt(await fs.readFile(path.join(f.runner,'polytrack-native-proofs.ptenc'))).header.sourceBinding,f.sourceBinding);
});

test('ordinary keyed Firestore keeps its normal replay budget and ciphertext survives a rejected push without a retry',async t=>{
  const f=await captureFixture(t),options=await f.execute({mode:'firestore',oneOff:false});
  assert.equal(Object.hasOwn(options,'replayDocumentLimit'),false);assert.equal(Object.hasOwn(options.nativePhaseOptions,'maxJobs'),false);
  const file=path.join(f.runner,'polytrack-recovery.ptenc'),before=await fs.readFile(file);let pushes=0;
  assert.throws(()=>pushPublicCapture({branch:'main',sourceCommit,run:(_cmd,args)=>{
    if(args[0]==='rev-parse')return sourceCommit;
    if(args[0]==='push'){pushes++;throw Error('mock push rejected');}
    assert(!['fetch','rebase'].includes(args[0]));
  }}),/publication deferred/);
  assert.equal(pushes,1);assert((await fs.readFile(file)).equals(before));assert.equal(decrypt(before).header.sourceCommit,sourceCommit);
});

test('ordinary keyed legacy Firestore may omit nativeVerification without failing or manufacturing proofs',async t=>{
  const f=await captureFixture(t);await f.execute({mode:'firestore',oneOff:false,stage:'legacy'});
  assert.equal(decrypt(await fs.readFile(path.join(f.runner,'polytrack-recovery.ptenc'))).header.attempt,'routine-capture');
  assert.equal(await fs.stat(path.join(f.runner,'polytrack-native-proofs.ptenc')).then(()=>true,()=>false),false);
});

test('native capture still requires its zero-backend-usage receipt',async t=>{
  const f=await captureFixture(t);await assert.rejects(f.execute({stage:'legacy'}),/Offline proof usage assertion failed/);
  assert.equal(decrypt(await fs.readFile(path.join(f.runner,'polytrack-recovery.ptenc'))).header.attempt,'overnight-capture');
});

test('repair-2 still emits its original branded ciphertext format and bounded replay limit',async t=>{
  const f=await captureFixture(t),options=await f.execute({repair:true});
  assert.equal(options.replayDocumentLimit,1000);
  const raw=await fs.readFile(path.join(f.runner,'polytrack-recovery.ptenc'));assert(raw.subarray(0,8).equals(Buffer.from('PTREC01\n')));
});

test('failure retention predicates preserve native/gate/push failures after publication',()=>{
  const expression=name=>/^        if: (.*)$/m.exec(step(name))[1];
  for(const outcome of ['success','failure']){
    const context={always:()=>true,inputs:{replacement_capture:false,repair_attempt:'repair-1'},steps:{authority:{outputs:{recovery_enabled:'true'}},snapshot:{outcome,outputs:{capture_status:outcome==='success'?'complete':'deferred'}},publication:{outcome:'failure'},recovery:{outputs:{ready:'true'}},proof_recovery:{outputs:{ready:'true'}}}};
    for(const name of ['Preserve encrypted failure checkpoint when needed','Retain encrypted recovery checkpoint','Retain encrypted private proof checkpoint'])
      assert.equal(vm.runInNewContext(expression(name),context),true);
  }
});

test('ordinary successful publication skips redundant uploads; deferred/unpublished captures and repair-2 retain them',()=>{
  const condition=name=>/^        if: (.*)$/m.exec(step(name))[1];
  const required=['Preserve encrypted failure checkpoint when needed','Locate encrypted private proof checkpoint'];
  const base={always:()=>true,inputs:{replacement_capture:false,repair_attempt:'repair-1'},
    steps:{authority:{outputs:{recovery_enabled:'true'}},snapshot:{outcome:'success',outputs:{capture_status:'complete'}},publication:{outcome:'success'}}};
  for(const name of required){
    assert.equal(vm.runInNewContext(condition(name),base),false,'ordinary successful publication');
    for(const publicationOutcome of ['failure','skipped','cancelled'])
      assert.equal(vm.runInNewContext(condition(name),{...base,steps:{...base.steps,publication:{outcome:publicationOutcome}}}),true,publicationOutcome);
    assert.equal(vm.runInNewContext(condition(name),{...base,steps:{...base.steps,snapshot:{outcome:'success',outputs:{capture_status:'deferred'}}}}),true,'deferred capture');
    assert.equal(vm.runInNewContext(condition(name),{...base,inputs:{replacement_capture:true,repair_attempt:'repair-2'}}),true,'repair-2 compatibility');
    assert.equal(vm.runInNewContext(condition(name),{...base,steps:{...base.steps,authority:{outputs:{recovery_enabled:'false'}}}}),false,'no recovery key');
    assert.equal(vm.runInNewContext(condition(name),{...base,steps:{...base.steps,snapshot:{outcome:'skipped',outputs:{}}}}),false,'no capture attempted');
  }
});
