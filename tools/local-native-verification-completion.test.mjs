import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {createLocalNativeVerificationCompletion} from './local-native-verification-completion.mjs';
import {ledgerKey} from './native-verification-ledger.mjs';
import {preflightLocalCaptureCheckpoints} from './local-capture-checkpoint.mjs';

const sourceCommit='a'.repeat(40),owner='11111111-1111-4111-8111-111111111111';
const HASH='b'.repeat(64),LEDGER='c'.repeat(64),RAW='verification-completed.json',ENV='verification-completed.receipt.json';
const sha=v=>createHash('sha256').update(v).digest('hex');
function receipt(statuses=['verified','held']){
  const decisions=statuses.map((status,i)=>{const binding={lane:'normal',accountId:sha('account'+i),trackId:HASH,timeMs:1000,frames:1000,uploadId:i+1,replayHash:sha('replay'+i)};return {key:ledgerKey(binding),binding,status,reason:''};});
  const counts={known:decisions.length,verified:0,held:0,excluded:0,mismatch:0,unavailable:0,unprocessed:0,reusedPhysics:0,nativeDispatched:decisions.length,nativeBatches:decisions.length?1:0};
  for(const d of decisions)counts[d.status]++;
  return {schemaVersion:1,authority:false,kind:'completed-in-process-native-verification',sourceBinding:{sourceCommit,captureSha256:HASH},ledgerManifestHash:LEDGER,previousLedgerManifestHash:HASH,
    counts,decisions,engineDigest:HASH,verifierFingerprint:HASH,policySha256:HASH,verificationComplete:counts.unavailable===0&&counts.unprocessed===0,privateProofCheckpoint:null};
}
async function fixture(t){
  t.mock.method(globalThis,'fetch',()=>assert.fail('No network in completion tests'));
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'local-native-completion-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'work'),directory=path.join(base,'private');await fs.mkdir(path.join(root,'local-reports/snapshot-staging'),{recursive:true});await fs.mkdir(directory);
  const running=path.join(directory,'running.json');await fs.writeFile(running,JSON.stringify({owner,testedCommit:sourceCommit}));
  const options={root,directory,owner,sourceCommit,maxJobs:10000};
  return {base,root,directory,running,options,callback:()=>createLocalNativeVerificationCompletion(options),read:async name=>JSON.parse(await fs.readFile(path.join(directory,name),'utf8'))};
}
test('completion persists before a later compilation failure, independently of postcompile receipt',async t=>{
  const f=await fixture(t),calls=[],nativeCompleted=f.callback();
  await assert.rejects((async()=>{calls.push('verify');const raw=receipt();await nativeCompleted(structuredClone(raw));calls.push('compile');throw Error('compile failed');})(),/compile failed/);
  assert.deepEqual(calls,['verify','compile']);const bytes=await fs.readFile(path.join(f.directory,RAW)),e=await f.read(ENV);
  assert.equal(e.status,'complete');assert.equal(e.authority,false);assert.equal(e.sha256,sha(bytes));assert.equal(e.owner,owner);assert.equal(e.testedCommit,sourceCommit);
  assert.equal((await f.read(RAW)).kind,'completed-in-process-native-verification');
  await assert.rejects(fs.stat(path.join(f.directory,'native-complete.receipt.json')),{code:'ENOENT'});
});
test('a bounded deferred verification is a durable completed callback, not a complete verification claim',async t=>{
  const f=await fixture(t),r=receipt(['verified','unavailable','unprocessed']);await f.callback()(r);
  assert.equal((await f.read(ENV)).status,'complete');assert.equal((await f.read(RAW)).verificationComplete,false);
});
test('verification failure before callback produces no early completion artifacts',async t=>{
  const f=await fixture(t),cb=f.callback();await assert.rejects((async()=>{throw Error('verification failed');await cb(receipt());})(),/verification failed/);
  assert.deepEqual(await fs.readdir(f.directory),['running.json']);
});
test('raw schema drops unknown fields and never copies credentials or raw replay material',async t=>{
  const f=await fixture(t),r=receipt();r.privateKey='DO_NOT_COPY';r.credentialFile='/secret';r.sourceBinding.token='DO_NOT_COPY';r.decisions[0].privateKey='DO_NOT_COPY';r.decisions[0].binding.replay='DO_NOT_COPY';
  await f.callback()(r);const text=await fs.readFile(path.join(f.directory,RAW),'utf8');assert.ok(!text.includes('DO_NOT_COPY'));assert.ok(!text.includes('credentialFile'));assert.equal(JSON.parse(text).decisions.length,2);
});
for(const [label,change]of [
  ['kind',r=>{r.kind='other';}],['authority',r=>{r.authority=true;}],['source',r=>{r.sourceBinding.sourceCommit='d'.repeat(40);}],
  ['capture hash',r=>{r.sourceBinding.captureSha256='bad';}],['ledger hash',r=>{r.ledgerManifestHash='bad';}],
  ['negative count',r=>{r.counts.known=-1;}],['fractional count',r=>{r.counts.nativeDispatched=1.5;}],
  ['missing count',r=>{delete r.counts.nativeBatches;}],['extra count',r=>{r.counts.secret=1;}],
  ['sum',r=>{r.counts.known++;}],['decision coverage',r=>{r.decisions.pop();}],['duplicate decision',r=>{r.decisions[1]=r.decisions[0];}],
  ['binding key',r=>{r.decisions[0].key='f'.repeat(64);}],['status totals',r=>{r.decisions[1].status='verified';}],
  ['dishonest complete',r=>{r.verificationComplete=false;}],['dispatch bound',r=>{r.counts.nativeDispatched=10001;}],
  ['decision limit',r=>{r.counts.known=100001;r.counts.verified=100000;r.decisions=Array(100001).fill(r.decisions[0]);}]
])test('invalid '+label+' fails closed with sanitized owned failure envelope',async t=>{
  const f=await fixture(t),r=receipt();change(r);await assert.rejects(f.callback()(r));
  const e=await f.read(ENV);assert.equal(e.status,'failed');assert.equal(e.authority,false);assert.equal(e.failure.code,'LOCAL_NATIVE_COMPLETION_INVALID');
  await assert.rejects(fs.stat(path.join(f.directory,RAW)),{code:'ENOENT'});
});
test('six outcome counters cover decisions, including an honestly incomplete receipt',async t=>{
  const f=await fixture(t),r=receipt(['verified','held','excluded','mismatch','unavailable','unprocessed']);await f.callback()(r);assert.equal((await f.read(RAW)).decisions.length,6);
});
for(const patch of [{owner:'22222222-2222-4222-8222-222222222222'},{testedCommit:'d'.repeat(40)}])test('mismatched running guard creates no outputs: '+Object.keys(patch)[0],async t=>{
  const f=await fixture(t);await fs.writeFile(f.running,JSON.stringify({owner,testedCommit:sourceCommit,...patch}));await assert.rejects(f.callback()(receipt()));assert.deepEqual(await fs.readdir(f.directory),['running.json']);
});
test('oversized guard and symlink-like guard are rejected without reading credentials',async t=>{
  const f=await fixture(t);await fs.writeFile(f.running,' '.repeat(65537));await assert.rejects(f.callback()(receipt()));
  await fs.writeFile(f.running,JSON.stringify({owner,testedCommit:sourceCommit}));const lstat=fs.lstat.bind(fs);
  t.mock.method(fs,'lstat',async(file,...args)=>{const stat=await lstat(file,...args);if(file===f.running)stat.isSymbolicLink=()=>true;return stat;});
  await assert.rejects(f.callback()(receipt()));assert.deepEqual(await fs.readdir(f.directory),['running.json']);
});
test('output directory inside staging is rejected',async t=>{
  const f=await fixture(t);assert.throws(()=>createLocalNativeVerificationCompletion({...f.options,maxJobs:10001}));
  await assert.rejects(createLocalNativeVerificationCompletion({...f.options,directory:path.join(f.root,'local-reports/snapshot-staging')})(receipt()));
});
for(const name of [RAW,ENV])test('exclusive admission preserves existing '+name,async t=>{
  const f=await fixture(t),file=path.join(f.directory,name);await fs.writeFile(file,'retain original');await assert.rejects(f.callback()(receipt()));assert.equal(await fs.readFile(file,'utf8'),'retain original');
  if(name===RAW)assert.equal((await f.read(ENV)).status,'failed');else await assert.rejects(fs.stat(path.join(f.directory,RAW)),{code:'ENOENT'});
});
test('a callback is single-use and separate factories cannot overwrite its receipt',async t=>{
  const f=await fixture(t),cb=f.callback();await cb(receipt());const before=await fs.readFile(path.join(f.directory,ENV),'utf8');await assert.rejects(cb(receipt()));await assert.rejects(f.callback()(receipt()));assert.equal(await fs.readFile(path.join(f.directory,ENV),'utf8'),before);
});
test('envelope is pending before raw opens, and raw is flushed before complete envelope',async t=>{
  const f=await fixture(t),open=fs.open.bind(fs),events=[];
  t.mock.method(fs,'open',async(file,...args)=>{const h=await open(file,...args);if(file===path.join(f.directory,RAW)){assert.equal((await f.read(ENV)).status,'pending');events.push('raw-open');t.mock.method(h,'sync',async()=>{events.push('raw-sync');});}if(file===path.join(f.directory,ENV)){const write=h.write.bind(h);t.mock.method(h,'write',async(buffer,...rest)=>{if(buffer.toString().includes('"status":"complete"')){assert.ok(events.includes('raw-sync'));events.push('complete');}return write(buffer,...rest);});}return h;});
  await f.callback()(receipt());assert.deepEqual(events,['raw-open','raw-sync','complete']);
});
test('partial raw write is preserved, envelope fails, and error text cannot leak',async t=>{
  const f=await fixture(t),open=fs.open.bind(fs);let writes=0;
  t.mock.method(fs,'open',async(file,...args)=>{const h=await open(file,...args);if(file===path.join(f.directory,RAW)){const write=h.write.bind(h);t.mock.method(h,'write',async(buffer,offset,length,position)=>{if(writes++===0)return write(buffer,offset,17,position);const e=Error('PRIVATE_KEY_DO_NOT_COPY');e.code='ENOSPC';throw e;});}return h;});
  await assert.rejects(f.callback()(receipt()),e=>e.code==='ENOSPC'&&!e.message.includes('PRIVATE_KEY'));
  assert.equal((await fs.stat(path.join(f.directory,RAW))).size,17);const e=await f.read(ENV);assert.equal(e.status,'failed');assert.equal(e.failure.code,'ENOSPC');assert.ok(!JSON.stringify(e).includes('PRIVATE_KEY'));
});
test('guard change after raw flush preserves raw plus failed envelope',async t=>{
  const f=await fixture(t),open=fs.open.bind(fs);
  t.mock.method(fs,'open',async(file,...args)=>{const h=await open(file,...args);if(file===path.join(f.directory,RAW)){const sync=h.sync.bind(h);t.mock.method(h,'sync',async()=>{await sync();await fs.writeFile(f.running,JSON.stringify({owner:'other',testedCommit:sourceCommit}));});}return h;});
  await assert.rejects(f.callback()(receipt()));assert.equal((await f.read(ENV)).status,'failed');assert.equal((await f.read(RAW)).counts.verified,1);
});
test('failed complete-envelope write retains failure evidence and raw receipt',async t=>{
  const f=await fixture(t),open=fs.open.bind(fs);
  t.mock.method(fs,'open',async(file,...args)=>{const h=await open(file,...args);if(file===path.join(f.directory,ENV)){const write=h.write.bind(h);t.mock.method(h,'write',async(buffer,...rest)=>{if(buffer.toString().includes('"status":"complete"')){const e=Error('secret');e.code='EIO';throw e;}return write(buffer,...rest);});}return h;});
  await assert.rejects(f.callback()(receipt()),{code:'EIO'});assert.equal((await f.read(ENV)).status,'failed');assert.equal((await f.read(RAW)).counts.known,2);
});
test('replacement envelope is never overwritten or unlinked on failure',async t=>{
  const f=await fixture(t),open=fs.open.bind(fs),env=path.join(f.directory,ENV);
  t.mock.method(fs,'open',async(file,...args)=>{const h=await open(file,...args);if(file===path.join(f.directory,RAW)){const sync=h.sync.bind(h);t.mock.method(h,'sync',async()=>{await sync();await fs.rename(env,env+'.preserved');await fs.writeFile(env,'someone else');});}return h;});
  await assert.rejects(f.callback()(receipt()));assert.equal(await fs.readFile(env,'utf8'),'someone else');assert.equal((await f.read(ENV+'.preserved')).status,'pending');
});
test('16 MiB raw byte cap rejects an otherwise valid bounded large receipt',async t=>{
  const f=await fixture(t),r=receipt(Array(45000).fill('verified'));r.counts.nativeDispatched=10000;r.counts.reusedPhysics=35000;
  assert.ok(Buffer.byteLength(JSON.stringify(r))>16*1024*1024);await assert.rejects(f.callback()(r));assert.equal((await f.read(ENV)).status,'failed');await assert.rejects(fs.stat(path.join(f.directory,RAW)),{code:'ENOENT'});
});
for(const name of [RAW,ENV])test('checkpoint preflight rejects reserved '+name,async t=>{
  const f=await fixture(t),keys=generateKeyPairSync('rsa',{modulusLength:2048}),key=path.join(f.directory,'recipient.pem');await fs.writeFile(key,keys.publicKey.export({type:'spki',format:'pem'}));await fs.writeFile(path.join(f.directory,name),'keep');
  await assert.rejects(preflightLocalCaptureCheckpoints({workspace:f.root,directory:f.directory,recoveryPublicKeyFile:key}),{code:'EEXIST'});assert.equal(await fs.readFile(path.join(f.directory,name),'utf8'),'keep');
});
test('worker wires the owned early callback without replacing the postcompile wrapper',async()=>{
  const source=await fs.readFile(new URL('./local-capture-worker.mjs',import.meta.url),'utf8');
  assert.match(source,/nativeCompleted:createLocalNativeVerificationCompletion\(\{root,directory,owner,sourceCommit:receipt\.testedCommit,maxJobs:plan\.maxJobs\}\)/);
  assert.match(source,/nativePhase:createLocalNativePhaseReceipt\(/);
});
