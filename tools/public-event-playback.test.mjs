import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {publicEventPlaybackProjection,publicEventPlaybackForPublication} from './public-event-playback.mjs';
import {confirmPlaybackEngine,revokePlaybackEngine,playbackEngineMetadata} from './playback-engine-session.mjs';
import {PLAYBACK_ENGINE_PIN} from './playback-engine-pin.mjs';
import {runPublicSnapshotBackup} from './public-snapshot-backup.mjs';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
import {encodeSnapshot} from './snapshot-package.mjs';
import {isBootstrapSnapshotPath} from './track-snapshot-paging.mjs';
const hex=n=>n.toString(16).padStart(64,'0'),replay=deflateSync(Buffer.alloc(15)).toString('base64url');
const replayHash=createHash('sha256').update(replay).digest('hex');
const period={id:'w_20261019',kind:'weekly',trackId:hex(99),startsAt:1000,endsAt:100000,graceMs:100,maxRp:500,targetMs:100};
const entry=n=>({accountId:hex(n),runId:hex(n+100),timeMs:100,name:'Racer',carStyle:'AA',submittedAt:1500,
 verificationStatus:'waiting',pending:true,verified:false,eventRpEligible:false,source:'pending-event-playback'});
const payload=e=>({periodId:period.id,trackId:period.trackId,accountId:e.accountId,runId:e.runId,timeMs:e.timeMs,frames:e.timeMs,
 replay,replayHash,carStyle:e.carStyle,submittedAt:e.submittedAt,verificationStatus:'waiting',pending:true,verified:false,eventRpEligible:false,source:'pending-event-recording'});

function eventBytes(lists){
 const bytes=Buffer.alloc(15+lists.reduce((sum,list)=>sum+list.length*3,0));let offset=0;
 for(const list of lists){bytes.writeUIntLE(list.length,offset,3);offset+=3;
  for(let index=0;index<list.length;index++){bytes.writeUIntLE(list[index]-(index?list[index-1]:0),offset,3);offset+=3;}}
 return bytes;
}
function highWork({lists=Array.from({length:5},()=>Array.from({length:1024},(_,i)=>i)),bytes,frames=35000}={}){
 const e={...entry(1),timeMs:frames},encoded=deflateSync(bytes||eventBytes(lists)).toString('base64url');
 const value={...payload(e),frames,replay:encoded,replayHash:createHash('sha256').update(encoded).digest('hex')};
 return {value,binding:{periodId:period.id,trackId:period.trackId,entry:{...e,replayHash:value.replayHash}}};
}
async function engine(){
 class Worker extends EventTarget{
  postMessage(message){queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:{...message,
   lookupVersion:PLAYBACK_ENGINE_PIN.lookupVersion,lookupDigest:PLAYBACK_ENGINE_PIN.lookupDigest}})));}
 }
 const worker=new Worker();
 const token=await confirmPlaybackEngine({worker,workerBytes:new Uint8Array(await fs.readFile(new URL('../simulation_worker.bundle.js',import.meta.url))),
  mainBytes:new Uint8Array(await fs.readFile(new URL('../main.bundle.js',import.meta.url)))});
 return {worker,token};
}

test('high linear-work pending events publish structurally bounded bytes without granting runtime or RP',async()=>{
 const f=highWork();await assert.rejects(publicEventPlaybackProjection(f.value,f.binding),/work limit/);
 const saved=await publicEventPlaybackForPublication({...f.value,ownerUid:'private',proof:'private',verifiedAt:999},f.binding);
 assert.equal(saved.replay,f.value.replay);assert.equal(saved.replayHash,f.value.replayHash);
 assert.equal(saved.verificationStatus,'waiting');assert.equal(saved.pending,true);assert.equal(saved.verified,false);
 assert.equal(saved.eventRpEligible,false);assert.equal(saved.runtimeCapability,false);
 assert.equal(saved.requiredPlaybackEngine.engineDigest,PLAYBACK_ENGINE_PIN.engineDigest);assert.ok(saved.playbackWork<30000000);
 for(const key of ['ownerUid','proof','verifiedAt','playbackEngine'])assert.equal(saved[key],undefined);
 await assert.rejects(publicEventPlaybackProjection(saved,f.binding),/work limit/,'published engine hints cannot authorize an old worker');
 assert.deepEqual(await publicEventPlaybackForPublication(saved,f.binding),saved,'publication is a stable public projection');
});

test('indexed pending runtime needs a live authenticated capability and rejects forged, revoked or failed sessions',async()=>{
 const f=highWork(),session=await engine();
 try{
  const saved=await publicEventPlaybackProjection(f.value,f.binding,{playbackEngine:session.token});
  assert.equal(saved.pending,true);assert.equal(saved.verified,false);assert.equal(saved.eventRpEligible,false);
  assert.ok(saved.playbackWork<30000000);assert.equal(saved.runtimeCapability,false,'the serialized row is not a worker capability');
  for(const token of [{...session.token},Object.freeze({...PLAYBACK_ENGINE_PIN}),null])
   await assert.rejects(publicEventPlaybackProjection(f.value,f.binding,{playbackEngine:token}),/work limit/);
  await assert.rejects(publicEventPlaybackProjection({...f.value,playbackEngine:session.token,publicationOnly:true},f.binding,
   {publicationOnly:true}),/work limit/,'row flags and runtime options cannot select publication-only validation');
  session.worker.dispatchEvent(new Event('error'));assert.equal(playbackEngineMetadata(session.token),null);
  await assert.rejects(publicEventPlaybackProjection(f.value,f.binding,{playbackEngine:session.token}),/work limit/);
 }finally{revokePlaybackEngine(session.token);}
 const second=await engine();revokePlaybackEngine(second.token);
 await assert.rejects(publicEventPlaybackProjection(f.value,f.binding,{playbackEngine:second.token}),/work limit/);
});

test('publication and authenticated indexed runtime preserve every event structural limit',async()=>{
 const session=await engine();
 try{
  const invalid=[Buffer.alloc(14),Buffer.alloc(16),Buffer.alloc(30016),
   eventBytes([[0,0],[],[],[],[]]),eventBytes([[35001],[],[],[],[]]),
   eventBytes([Array.from({length:4097},(_,i)=>i),[],[],[],[]]),
   eventBytes([Array.from({length:4000},(_,i)=>i),Array.from({length:4000},(_,i)=>i),Array.from({length:2001},(_,i)=>i),[],[]])];
  for(const bytes of invalid){const f=highWork({bytes});
   await assert.rejects(publicEventPlaybackForPublication(f.value,f.binding));
   await assert.rejects(publicEventPlaybackProjection(f.value,f.binding,{playbackEngine:session.token}));
  }
  const maximum=highWork({lists:Array.from({length:5},()=>Array.from({length:2000},(_,i)=>i))});
  assert.equal((await publicEventPlaybackForPublication(maximum.value,maximum.binding)).pending,true);
  const tooLong=highWork({frames:300001});
  await assert.rejects(publicEventPlaybackForPublication(tooLong.value,tooLong.binding),/binding/);
  await assert.rejects(publicEventPlaybackProjection(tooLong.value,tooLong.binding,{playbackEngine:session.token}),/binding/);
 }finally{revokePlaybackEngine(session.token);}
});

test('publication and indexed runtime cannot bypass terminal status or exact pending event binding',async()=>{
 const f=highWork(),session=await engine();
 try{
  for(const change of [{verified:true},{eventRpEligible:true},{pending:false},{verificationStatus:'verified'},
   {status:'rejected'},{validationState:'unknown'},{trackId:hex(1000)},{accountId:hex(1000)},
   {runId:hex(1000)},{timeMs:35001},{frames:35001},{submittedAt:1501},{replayHash:hex(1000)}]){
   await assert.rejects(publicEventPlaybackForPublication({...f.value,...change},f.binding));
   await assert.rejects(publicEventPlaybackProjection({...f.value,...change},f.binding,{playbackEngine:session.token}));
  }
 }finally{revokePlaybackEngine(session.token);}
});
test('public waiting projection binds the exact public run, strips private proof and never earns RP',async()=>{
 const e=entry(1),input={...payload(e),ownerUid:'private',proof:'private',verifiedAt:999};
 const projected=await publicEventPlaybackProjection(input,{periodId:period.id,trackId:period.trackId,entry:e});
 assert.equal(projected.verificationStatus,'waiting');assert.equal(projected.verified,false);assert.equal(projected.eventRpEligible,false);
 assert.equal(projected.runId,e.runId);assert.equal(projected.replayHash,replayHash);assert.equal(projected.ownerUid,undefined);assert.equal(projected.proof,undefined);assert.equal(projected.verifiedAt,undefined);
});
test('wrong identity, hash, run, terminal status, timestamp or structure cannot become pending playback',async()=>{
 const e=entry(1),binding={periodId:period.id,trackId:period.trackId,entry:e};
 for(const patch of [{periodId:'d_20261024'},{trackId:hex(1000)},{accountId:hex(1000)},{runId:hex(1000)},
  {timeMs:101},{frames:101},{replayHash:hex(1000)},{replay:'tampered'},{submittedAt:1501},{verificationStatus:'rejected'},
  {status:'mismatch'},{verified:true},{eventRpEligible:true},{pending:false},{source:'private-queue'},
  {replay:deflateSync(Buffer.alloc(14)).toString('base64url'),replayHash:createHash('sha256').update(deflateSync(Buffer.alloc(14)).toString('base64url')).digest('hex')}])
  await assert.rejects(publicEventPlaybackProjection({...payload(e),...patch},binding));
 await assert.rejects(publicEventPlaybackProjection(payload(e),{...binding,entry:{...e,replayHash:hex(1000)}}));
 await assert.rejects(publicEventPlaybackProjection(payload(e),{...binding,entry:{...e,verificationStatus:'rejected'}}));
});
async function fixture(t,{pending=1,verified=0}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'public-event-playbacks-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const state={archived:false,pending:Array.from({length:pending},(_,i)=>entry(i+1)),requests:[],quota:false,mutate:x=>x};
 const verifiedRows=Array.from({length:verified},(_,i)=>({accountId:hex(i+1000),timeMs:100,name:'Verified racer',carStyle:'AA',rp:1,rank:i+1}));
 const fetchImpl=async input=>{
  const url=new URL(input);assert.equal(url.hostname,'polytrack-ranked-worker.staticquasar931.workers.dev');state.requests.push(url.pathname);
  if(url.pathname.endsWith('/overall'))return Response.json({updatedAt:2000,entries:[],trackSummaries:[],complete:true});
  if(url.pathname.endsWith('/catalog'))return Response.json({periods:[period],archives:[]});
  if(url.pathname.includes('/permanent-rolling-hills/'))return new Response('',{status:404});
  if(url.pathname==='/v1/snapshot/track')return new Response('',{status:404});
  if(url.pathname.includes('/playbacks/')){
   if(state.quota)return new Response('',{status:429});
   const e=state.pending.find(e=>e.runId===url.pathname.split('/').at(-1));return e?Response.json(state.mutate(payload(e))):new Response('',{status:404});
  }
  if(url.pathname.includes('/replays/')){
   const row=verifiedRows.find(e=>e.accountId===url.pathname.split('/').at(-1));
   return Response.json({...payload({...entry(1),...row,runId:hex(5000+verifiedRows.indexOf(row))}),verificationStatus:'verified',verified:true,pending:false,eventRpEligible:true,verifiedAt:1900});
  }
  return Response.json({id:period.id,period,updatedAt:2000,entries:verifiedRows,pendingPlaybacks:state.pending,archived:state.archived});
 };
 const run=()=>runPublicSnapshotBackup({directory,fetchImpl,trackIds:[],now:2000,log:()=>{}});
 return {directory,state,run,relative:e=>`event-playbacks/${period.id}/${e.runId}.json`};
}
test('capture writes public pending bytes and exact hash; unchanged public bindings reuse without fetching',async t=>{
 const f=await fixture(t),e=f.state.pending[0];await f.run();
 const saved=JSON.parse(await fs.readFile(path.join(f.directory,f.relative(e))));
 assert.equal(saved.verified,false);assert.equal(saved.eventRpEligible,false);assert.equal(saved.verificationStatus,'waiting');
 const board=JSON.parse(await fs.readFile(path.join(f.directory,`events/${period.id}.json`)));
 assert.equal(board.pendingPlaybacks[0].replayHash,replayHash);assert.equal(board.entries.length,0);
 await f.run();assert.equal(f.state.requests.filter(p=>p.includes('/playbacks/')).length,1);
});
test('verified and pending public playback share the existing 30-fetch ceiling',async t=>{
 const f=await fixture(t,{pending:20,verified:20});const result=await f.run();
 const requests=f.state.requests.filter(p=>/\/(replays|playbacks)\//.test(p));assert.equal(requests.length,30);
 assert.equal(requests.filter(p=>p.includes('/playbacks/')).length,15);assert.equal(requests.filter(p=>p.includes('/replays/')).length,15);
 assert.equal(Object.keys(result.eventPlaybacks).length,15);assert.equal(Object.keys(result.eventReplays).length,15);
});
test('archival drops cached pending assets and never requests archived pending playback',async t=>{
 const f=await fixture(t),e=f.state.pending[0];await f.run();f.state.archived=true;await f.run();
 assert.equal(f.state.requests.filter(p=>p.includes('/playbacks/')).length,1);
 await assert.rejects(fs.stat(path.join(f.directory,f.relative(e))),{code:'ENOENT'});
 const board=JSON.parse(await fs.readFile(path.join(f.directory,`events/${period.id}.json`)));assert.equal(board.pendingPlaybacks,undefined);
});
test('removed or terminal public pending bindings purge their cached inputs',async t=>{
 const f=await fixture(t),e=f.state.pending[0];await f.run();f.state.pending=[];await f.run();
 await assert.rejects(fs.stat(path.join(f.directory,f.relative(e))),{code:'ENOENT'});
});
test('429 defers capture without committing a new manifest or issuing a retry',async t=>{
 const f=await fixture(t);f.state.quota=true;const result=await f.run();assert.equal(result.deferred,true);assert.equal(result.status,429);
 assert.equal(f.state.requests.filter(p=>p.includes('/playbacks/')).length,1);await assert.rejects(fs.stat(path.join(f.directory,'manifest.json')),{code:'ENOENT'});
});
async function readerFixture({archived=false,listed=true,tamper={},cold=false}={}){
 const e={...entry(1),replayHash},board={id:period.id,period,updatedAt:2000,entries:[],archived,pendingPlaybacks:listed?[e]:[]};
 const values={[`events/${period.id}.json`]:board,[`event-playbacks/${period.id}/${e.runId}.json`]:{...payload(e),...tamper}},files={},bytesByHash=new Map();
 for(const [logical,value] of Object.entries(values)){const bytes=await encodeSnapshot(value),hash=createHash('sha256').update(bytes).digest('hex');files[logical]={path:hash+'.bin',sha256:hash,decodedBytes:Buffer.byteLength(JSON.stringify(value))};bytesByHash.set(hash+'.bin',bytes);}
 let requests=0;
 const read=createPublicSnapshotReader({packed:true,bootstrap:cold,baseUrl:'https://offline.invalid/public-snapshots57/',fetchImpl:async(url,options)=>{
  requests++;assert.equal(options.credentials,'omit');const file=new URL(url).pathname.split('/').at(-1);
  if(file==='bootstrap-index.json')return Response.json({schemaVersion:1,generation:57,encoding:'gzip-xor-a7-v1',lookupShardsVersion:1,partial:true,fallbackIndex:'index.json',files:{[`events/${period.id}.json`]:files[`events/${period.id}.json`]}});
  if(String(url).includes('/lookup-shards/'))return Response.json({schemaVersion:1,generation:57,encoding:'gzip-xor-a7-v1',lookupShardsVersion:1,bucket:file.slice(0,-5),files:{[`event-playbacks/${period.id}/${e.runId}.json`]:files[`event-playbacks/${period.id}/${e.runId}.json`]}});
  return file==='index.json'?Response.json({schemaVersion:1,generation:57,encoding:'gzip-xor-a7-v1',files}):new Response(bytesByHash.get(file));
 }});
 return {read,e,requests:()=>requests};
}
test('event-playback reader checks current public board binding and shares cached reads',async()=>{
 const f=await readerFixture(),saved=await f.read('event-playback',period.id,f.e.runId);assert.equal(saved.verified,false);assert.equal(saved.eventRpEligible,false);
 await f.read('event-playback',period.id,f.e.runId);assert.equal(f.requests(),3);
 for(const options of [{archived:true},{listed:false},{tamper:{verificationStatus:'rejected'}},{tamper:{replayHash:hex(6000)}},{tamper:{accountId:hex(6000)}}]){
  const bad=await readerFixture(options);assert.equal(await bad.read('event-playback',period.id,bad.e.runId),null);
 }
 assert.equal(await f.read('event-playback','../private',f.e.runId),null);
});
test('pending playback payloads stay outside bootstrap and use existing cold lookup packaging',()=>{
 assert.equal(isBootstrapSnapshotPath(`event-playbacks/${period.id}/${entry(1).runId}.json`),false);
 assert.equal(isBootstrapSnapshotPath(`events/${period.id}.json`),true);
});
test('cold event-playback reads use the lookup shard and bootstrap board without the full index',async()=>{
 const f=await readerFixture({cold:true}),saved=await f.read('event-playback',period.id,f.e.runId);
 assert.equal(saved.runId,f.e.runId);assert.equal(saved.verified,false);assert.equal(f.requests(),4);
});
