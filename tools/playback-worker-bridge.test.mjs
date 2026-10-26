import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {deflateSync,inflateSync} from 'node:zlib';
import {installPlaybackWorkerCapture,createPlaybackWorkerBridge} from './playback-worker-bridge.mjs';
import {PLAYBACK_ENGINE_PIN as pin} from './playback-engine-pin.mjs';
import {playbackEngineMetadata} from './playback-engine-session.mjs';

const workerBytes=fs.readFileSync(new URL('../simulation_worker.bundle.js',import.meta.url));
const mainBytes=fs.readFileSync(new URL('../main.bundle.js',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// The native format stores counts and unsigned deltas as fixed 24-bit integers.
function encode(lists){
  const bytes=Buffer.alloc(15+lists.reduce((n,list)=>n+list.length*3,0));let offset=0;
  for(const list of lists){bytes.writeUIntLE(list.length,offset,3);offset+=3;
    for(let i=0;i<list.length;i++){bytes.writeUIntLE(list[i]-(i?list[i-1]:0),offset,3);offset+=3;}}
  return deflateSync(bytes,{level:9}).toString('base64url');
}
const highRecording=encode(Array.from({length:5},(_,channel)=>Array.from({length:20},(_,i)=>i*1000+channel)));
const highEntry={accountId:'a'.repeat(64),trackId:'b'.repeat(64),uploadId:123,timeMs:2000000,frames:2000000,
  replayHash:hash(highRecording),runVerified:true,verified:true,integrityVerified:true,verifiedState:1};
const high={...highEntry,recording:highRecording};
const lowRecording=encode([[],[],[],[],[]]);
const lowEntry={...highEntry,uploadId:124,timeMs:1000,frames:1000,replayHash:hash(lowRecording)};
const low={...lowEntry,recording:lowRecording};

function fixture({old=false,failed=false,failCount=0,wrongAsset=false,embedded=false,origin='https://fixture.invalid',blobShim=false,mutateInputs=false,now=Date.now,revision='test'}={}){
  const responses={enabled:!old};
  const shimCalls=[];
  class Native extends EventTarget{
    constructor(url,options){super();this.url=url;this.options=options;this.sent=[];this.terminated=false;}
    postMessage(message){this.sent.push(message);
      if(responses.enabled&&message?.messageType==='polytrack-playback-capability-v1')queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{
        data:{...message,lookupVersion:pin.lookupVersion,lookupDigest:pin.lookupDigest}})));}
    terminate(){this.terminated=true;}
  }
  const base=embedded?'https://cdn.jsdelivr.net/gh/StaticQuasar931/PolyTrack-0.6.3-Ranked@'+'c'.repeat(40)+'/':'https://fixture.invalid/';
  class EmbedShim{constructor(url,options){shimCalls.push({url,options});return new Native('blob:'+origin+'/native-shim',options);}}
  const scope={Worker:blobShim?EmbedShim:Native,document:{baseURI:base,scripts:[{src:base+'main.bundle.js?v='+revision}]},location:{origin}};
  const capture=installPlaybackWorkerCapture(scope),requests=[];
  const bridge=createPlaybackWorkerBridge({scope,timeoutMs:35,now,
    serializeNative:recording=>mutateInputs?lowRecording:deflateSync(inflateSync(Buffer.from(recording,'base64url')),{level:0}).toString('base64url'),
    fetchImpl:async(url,options)=>{requests.push({url,options});if(failed||failCount-->0)throw Error('fixture asset unavailable');
      return new Response(wrongAsset?new Uint8Array([1]):url.includes('main.bundle')?mainBytes:workerBytes);}});
  return {scope,capture,bridge,requests,responses,shimCalls};
}

test('capture/startup has no fetch, handshake, simulation queue or termination',()=>{
  const f=fixture(),worker=new f.scope.Worker('simulation_worker.bundle.js');
  for(const message of [{messageType:0},{messageType:3,carRecording:'ordinary-local'},{messageType:5},{messageType:6}])worker.postMessage(message);
  assert.deepEqual(worker.sent.map(row=>row.messageType),[0,3,5,6]);
  assert.equal(f.requests.length,0);assert.equal(worker.terminated,false);worker.terminate();
});
test('failed asset attestation leaves live controls and legacy-bounded public playback untouched',async()=>{
  const f=fixture({failed:true}),worker=new f.scope.Worker('simulation_worker.bundle.js');
  await assert.rejects(f.bridge.prepareRecording(high,highEntry),/asset unavailable/);
  for(const message of [{messageType:3,carRecording:null},{messageType:5},{messageType:6}])worker.postMessage(message);
  assert.deepEqual(worker.sent.map(row=>row.messageType),[3,5,6]);assert.equal(worker.terminated,false);
  const prepared=await f.bridge.prepareRecording(low,lowEntry);assert.equal(prepared.recording,lowRecording);
  worker.postMessage({messageType:3,carRecording:'unrelated-local'});assert.equal(worker.sent.at(-1).carRecording,'unrelated-local');worker.terminate();
});
test('old worker timeout does not delay StartCar/live controls or kill Physics',async()=>{
  const f=fixture({old:true}),worker=new f.scope.Worker('simulation_worker.bundle.js');
  const request=f.bridge.prepareRecording(high,highEntry);worker.postMessage({messageType:5});worker.postMessage({messageType:6});
  assert.deepEqual(worker.sent.map(row=>row.messageType),[5,6]);await assert.rejects(request,/handshake/);
  assert.equal(worker.terminated,false);worker.terminate();
});
test('prepared high-work original and native aliases require the exact worker; bytes/hash stay original',async()=>{
  const f=fixture(),worker=new f.scope.Worker('simulation_worker.bundle.js');
  const before=JSON.stringify({high,highEntry}),prepared=await f.bridge.prepareRecording(high,highEntry);
  assert.equal(prepared.recording,highRecording);assert.equal(prepared.replayHash,highEntry.replayHash);
  assert.equal(prepared.eventRpEligible,false);assert.equal(JSON.stringify({high,highEntry}),before);
  const alias=deflateSync(inflateSync(Buffer.from(highRecording,'base64url')),{level:0}).toString('base64url');
  assert.notEqual(alias,highRecording);worker.postMessage({messageType:3,carRecording:alias});assert.equal(worker.sent.at(-1).carRecording,alias);
  const other=new f.scope.Worker('simulation_worker.bundle.js'),sent=other.sent.length;
  assert.throws(()=>other.postMessage({messageType:3,carRecording:highRecording}),/not prepared/);assert.equal(other.sent.length,sent);
  other.postMessage({messageType:3,carRecording:'ordinary-local'});assert.equal(other.sent.at(-1).carRecording,'ordinary-local');
  await f.bridge.refreshPreparedRecording(highRecording,high.frames);other.postMessage({messageType:3,carRecording:highRecording});
  assert.equal(f.requests.length,2);assert(f.requests.every(row=>row.options.credentials==='omit'));
  f.bridge.dispose();assert.equal(worker.terminated,false);assert.equal(other.terminated,false);
  assert.throws(()=>worker.postMessage({messageType:3,carRecording:alias}),/not active/);worker.terminate();other.terminate();
});
for(const origin of ['https://script.google.com','null'])test('immutable CDN assets work from embedded page origin '+origin,async()=>{
  const f=fixture({embedded:true,origin,blobShim:true}),worker=new f.scope.Worker('simulation_worker.bundle.js');
  assert(worker.url.startsWith('blob:'));assert.equal(f.capture.records.size,1);
  await f.bridge.prepareRecording(high,highEntry);worker.postMessage({messageType:3,carRecording:highRecording});
  assert.equal(worker.sent.at(-1).carRecording,highRecording);assert(f.requests.every(row=>row.url.startsWith('https://cdn.jsdelivr.net/gh/')));worker.terminate();
});
test('unrelated opaque blob and other-origin workers remain unmodified',()=>{
  const f=fixture({embedded:true,origin:'null'});
  const workers=[new f.scope.Worker('blob:null/draco'),new f.scope.Worker('https://other.invalid/simulation_worker.bundle.js')];
  assert.equal(f.capture.records.size,0);
  for(const worker of workers){worker.postMessage({messageType:3,carRecording:highRecording});assert.equal(worker.sent.length,1);worker.terminate();}
  assert.equal(f.requests.length,0);
});
test('asset mismatch disables indexed playback without terminating the worker',async()=>{
  const f=fixture({wrongAsset:true}),worker=new f.scope.Worker('simulation_worker.bundle.js');
  await assert.rejects(f.bridge.prepareRecording(high,highEntry),/asset mismatch/);
  worker.postMessage({messageType:6});assert.equal(worker.sent.at(-1).messageType,6);assert.equal(worker.terminated,false);worker.terminate();
});
test('changed native serialization inputs and bad public bindings fail before any asset read',async()=>{
  const f=fixture({mutateInputs:true}),worker=new f.scope.Worker('simulation_worker.bundle.js');
  await assert.rejects(f.bridge.prepareRecording(high,highEntry),/changed recording inputs/);
  await assert.rejects(f.bridge.prepareRecording({...high,accountId:'d'.repeat(64)},highEntry),/binding mismatch/);
  assert.equal(f.requests.length,0);assert.equal(worker.terminated,false);worker.terminate();
});
test('pending high-work viewing is opt-in and remains pending, never an RP or physics proof',async()=>{
  const f=fixture(),worker=new f.scope.Worker('simulation_worker.bundle.js');
  const entry={...highEntry,runVerified:false,verified:false,verifiedState:0},row={...high,runVerified:false,verified:false,verifiedState:0};
  await assert.rejects(f.bridge.prepareRecording(row,entry),/not eligible/);assert.equal(f.requests.length,0);
  const prepared=await f.bridge.prepareRecording(row,entry,{allowPending:true});
  assert.equal(prepared.verifiedState,0);assert.equal(prepared.playbackPending,true);assert.equal(prepared.eventRpEligible,false);
  assert.equal(prepared.proof,undefined);assert.equal(row.verified,false);assert.equal(playbackEngineMetadata({...f.bridge.currentToken()}),null);worker.terminate();
});

test('temporary asset failure retries only on explicit preparation at the 15-second boundary',async()=>{
  let clock=100000;
  const f=fixture({failCount:1,now:()=>clock}),worker=new f.scope.Worker('simulation_worker.bundle.js');
  await assert.rejects(f.bridge.prepareRecording(high,highEntry),/asset unavailable/);
  assert.equal(f.requests.length,2);assert.equal([...f.capture.records][0].ready,null);
  worker.postMessage({messageType:5});worker.postMessage({messageType:6});
  assert.deepEqual(worker.sent.map(row=>row.messageType),[5,6]);assert.equal(worker.terminated,false);
  clock+=14999;
  await assert.rejects(f.bridge.prepareRecording(high,highEntry),/asset unavailable/);
  assert.equal(f.requests.length,2);
  clock++;await Promise.resolve();assert.equal(f.requests.length,2,'Clock advance alone never starts a retry');
  const prepared=await f.bridge.prepareRecording(high,highEntry);
  assert.equal(prepared.recording,highRecording);assert.equal(f.requests.length,3,'Only the failed asset is refetched');
  assert.equal(f.requests.filter(row=>row.url.includes('main.bundle')).length,1);
  await f.bridge.prepareRecording(high,highEntry);assert.equal(f.requests.length,3,'Successful assets/session remain cached');
  worker.postMessage({messageType:3,carRecording:highRecording});assert.equal(worker.sent.at(-1).carRecording,highRecording);worker.terminate();
});

test('failed handshake can retry after cooldown using cached successful assets, without delaying live controls',async()=>{
  let clock=200000;
  const f=fixture({old:true,now:()=>clock}),worker=new f.scope.Worker('simulation_worker.bundle.js');
  await assert.rejects(f.bridge.prepareRecording(high,highEntry),/handshake/);
  assert.equal(f.requests.length,2);assert.equal([...f.capture.records][0].ready,null);
  const handshakeCount=()=>worker.sent.filter(row=>row.messageType==='polytrack-playback-capability-v1').length;
  assert.equal(handshakeCount(),1);f.responses.enabled=true;clock+=14999;
  await assert.rejects(f.bridge.prepareRecording(high,highEntry),/handshake/);
  assert.equal(handshakeCount(),1);assert.equal(f.requests.length,2);
  worker.postMessage({messageType:3,carRecording:null});worker.postMessage({messageType:5});worker.postMessage({messageType:6});
  assert.deepEqual(worker.sent.slice(-3).map(row=>row.messageType),[3,5,6]);assert.equal(worker.terminated,false);
  clock++;await f.bridge.prepareRecording(high,highEntry);
  assert.equal(handshakeCount(),2);assert.equal(f.requests.length,2);
  await f.bridge.prepareRecording(high,highEntry);assert.equal(handshakeCount(),2);worker.terminate();
});

test('concurrent explicit retries share one asset request and one per-worker handshake',async()=>{
  let clock=300000;
  const f=fixture({failCount:1,now:()=>clock}),worker=new f.scope.Worker('simulation_worker.bundle.js');
  await assert.rejects(f.bridge.prepareRecording(high,highEntry),/asset unavailable/);clock+=15000;
  const values=await Promise.all([f.bridge.prepareRecording(high,highEntry),f.bridge.prepareRecording(high,highEntry)]);
  assert(values.every(value=>value.recording===highRecording));assert.equal(f.requests.length,3);
  assert.equal(worker.sent.filter(row=>row.messageType==='polytrack-playback-capability-v1').length,1);worker.terminate();
});

test('same-origin main revision versions the exact native worker before construction and attests that URL',async()=>{
  const f=fixture({revision:'184'}),options={name:'native-smoke'},worker=new f.scope.Worker('simulation_worker.bundle.js',options);
  assert.equal(worker.url,'https://fixture.invalid/simulation_worker.bundle.js?v=184');assert.equal(worker.options,options);
  assert.equal([...f.capture.records][0].url,worker.url);assert.equal(f.requests.length,0);
  await f.bridge.prepareRecording(high,highEntry);
  assert(f.requests.some(row=>row.url===worker.url));
  assert.equal(f.requests.filter(row=>row.url.includes('simulation_worker.bundle')).length,1);worker.terminate();
});
test('different same-origin main revisions produce distinct native worker asset URLs',()=>{
  const a=fixture({revision:'184'}),b=fixture({revision:'185'});
  const first=new a.scope.Worker('simulation_worker.bundle.js'),next=new b.scope.Worker('simulation_worker.bundle.js');
  assert.equal(new URL(first.url).searchParams.get('v'),'184');assert.equal(new URL(next.url).searchParams.get('v'),'185');
  assert.notEqual(first.url,next.url);first.terminate();next.terminate();
});
test('only the exact native path is versioned; unrelated original URL objects/options pass through',()=>{
  const f=fixture({revision:'184'}),url=new URL('https://other.invalid/simulation_worker.bundle.js'),options={name:'unrelated'};
  const other=new f.scope.Worker(url,options),draco=new f.scope.Worker('blob:null/draco'),lookalike=new f.scope.Worker('different/simulation_worker.bundle.js');
  assert.equal(other.url,url);assert.equal(other.options,options);assert.equal(draco.url,'blob:null/draco');
  assert.equal(lookalike.url,'different/simulation_worker.bundle.js');assert.equal(f.capture.records.size,0);
  for(const worker of [other,draco,lookalike])worker.terminate();assert.equal(f.requests.length,0);
});
for(const origin of ['https://script.google.com','null'])test('embedded main v184 preserves original constructor argument for '+origin,async()=>{
  const f=fixture({embedded:true,origin,blobShim:true,revision:'184'}),options={name:'embed'},original='simulation_worker.bundle.js';
  const worker=new f.scope.Worker(original,options);
  assert.equal(f.shimCalls[0].url,original);assert.equal(f.shimCalls[0].options,options);
  const record=[...f.capture.records][0];assert.equal(new URL(record.url).search,'');
  await f.bridge.prepareRecording(high,highEntry);
  assert(f.requests.some(row=>row.url===record.url));assert(f.requests.filter(row=>row.url.includes('simulation_worker.bundle')).every(row=>new URL(row.url).search===''));
  worker.terminate();
});
test('only one through eight digits are propagated; other main revision values preserve native arguments',()=>{
  for(const revision of ['', 'test', '-1', '1.2', '123456789']){
    const f=fixture({revision}),original='simulation_worker.bundle.js?existing=1',worker=new f.scope.Worker(original);
    assert.equal(worker.url,original);worker.terminate();
  }
  for(const revision of ['1','12345678']){
    const f=fixture({revision}),worker=new f.scope.Worker('simulation_worker.bundle.js');
    assert.equal(new URL(worker.url).searchParams.get('v'),revision);worker.terminate();
  }
});
