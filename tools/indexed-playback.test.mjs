import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {PLAYBACK_ENGINE_PIN as pin} from './playback-engine-pin.mjs';
import {indexedForwardWork,playbackEngineMetadata,confirmPlaybackEngine} from './playback-engine-session.mjs';
import {validatePublicReplayForPublication,validatePublicReplayStructure} from './public-replay-playback.mjs';

const workerBytes=fs.readFileSync(new URL('../simulation_worker.bundle.js',import.meta.url));
const mainBytes=fs.readFileSync(new URL('../main.bundle.js',import.meta.url));
const worker=workerBytes.toString('utf8');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const lookupStart=worker.indexOf('ka=(()=>{const cache=new WeakMap;');
const lookupEnd=worker.indexOf(',_a=function(',lookupStart);
assert(lookupStart>=0&&lookupEnd>lookupStart,'Review indexed worker lookup extraction after a bundle change');
const lookupExpression=worker.slice(lookupStart+3,lookupEnd);
const freshLookup=()=>vm.runInNewContext(lookupExpression);
function oracle(list,tick){
  if(Number.isNaN(tick))return list.length-1;
  const first=list.findIndex(value=>value>=tick);
  return first<0?list.length-1:list[first]===tick?first:first-1;
}
function encode(lists){
  const bytes=Buffer.alloc(15+lists.reduce((n,list)=>n+3*list.length,0));let offset=0;
  for(const list of lists){bytes.writeUIntLE(list.length,offset,3);offset+=3;
    for(let i=0;i<list.length;i++){bytes.writeUIntLE(list[i]-(i?list[i-1]:0),offset,3);offset+=3;}}
  return deflateSync(bytes,{level:9}).toString('base64url');
}
function lifecycle(){
  // Extract the REAL persistent listener, bootstrap queue assignment and later
  // native handoff. Never evaluate the worker, WASM or physics initialization.
  const start=worker.indexOf('self.addEventListener("message",');
  const end=worker.indexOf(',PolyTrackPhysics().then',start);
  assert(start>=0&&end>start,'Persistent capability listener must precede native boot');
  const handoff=/\$o\.length=0,onmessage=([A-Za-z_$][\w$]*);/.exec(worker);
  assert(handoff,'Actual native onmessage handoff must be audited');
  const target=new EventTarget(),responses=[],queue=[],native=[];
  let callback=null,installed=false;
  const context={self:target,$o:queue,postMessage:value=>responses.push(value)};
  context[handoff[1]]=event=>native.push(event.data);
  Object.defineProperty(context,'onmessage',{get:()=>callback,set:value=>{
    callback=value;if(!installed){installed=true;target.addEventListener('message',event=>callback(event));}
  }});
  vm.createContext(context);vm.runInContext(worker.slice(start,end),context);
  return {responses,queue,native,send:data=>target.dispatchEvent(new MessageEvent('message',{data})),
    initialize:()=>vm.runInContext(handoff[0],context)};
}

test('actual worker/main byte hashes and actual lookup expression match the public capability pin',()=>{
  const canonical=bytes=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes).replace(/\r\n?/g,'\n');
  assert.equal(hash(canonical(workerBytes)),pin.workerSha256);assert.equal(hash(canonical(mainBytes)),pin.mainSha256);
  assert.equal(hash(lookupExpression),pin.lookupDigest);
});

test('Windows JS line endings preserve the reviewed asset identity but changed code does not',async()=>{
 class Worker extends EventTarget{postMessage(message){queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:{...message,lookupVersion:pin.lookupVersion,lookupDigest:pin.lookupDigest}})));}}
 const crlf=bytes=>new TextEncoder().encode(new TextDecoder().decode(bytes).replace(/\r?\n/g,'\r\n'));
 const token=await confirmPlaybackEngine({worker:new Worker(),workerBytes:crlf(workerBytes),mainBytes:crlf(mainBytes)});
 assert.equal(playbackEngineMetadata(token).engineDigest,pin.engineDigest);
 await assert.rejects(confirmPlaybackEngine({worker:new Worker(),workerBytes:new TextEncoder().encode(new TextDecoder().decode(workerBytes)+' '),mainBytes}),/asset mismatch/);
});
test('REAL worker capability listener survives the REAL post-WASM onmessage replacement',()=>{
  const f=lifecycle(),request={messageType:'polytrack-playback-capability-v1',nonce:'a'.repeat(32)};
  f.send(request);assert.equal(f.responses.length,1);assert.equal(f.queue.length,0);
  assert.equal(f.responses[0].lookupDigest,pin.lookupDigest);assert.equal(f.responses[0].lookupVersion,pin.lookupVersion);
  f.send({messageType:0});assert.equal(f.queue.length,1);
  f.initialize();assert.equal(f.queue.length,0);f.send(request);
  assert.equal(f.responses.length,2);assert.equal(f.responses[1].nonce,request.nonce);assert.equal(f.native.length,0);
  for(const type of [0,3,5,6,7,1])f.send({messageType:type});
  assert.deepEqual(f.native.map(value=>value.messageType),[0,3,5,6,7,1]);
});
test('malformed capability nonce is consumed without native protocol dispatch or acknowledgement',()=>{
  const f=lifecycle();f.initialize();f.send({messageType:'polytrack-playback-capability-v1',nonce:'bad'});
  assert.equal(f.responses.length,0);assert.equal(f.native.length,0);
});

const cases=[['empty',[]],['initial',[0]],['late',[98,99,100]],['dense',Array.from({length:101},(_,i)=>i)],
  ['held',[0,90]],['duplicates',[0,0,1,1,1,9]],['terminal',[100]],['sparse',[1,7,40,88,100]]];
for(const [name,list] of cases)test('actual cursor matches independent oracle: '+name,()=>{
  const lookup=freshLookup();
  const ticks=[...Array.from({length:102},(_,i)=>i),100,99,40,40,0,1,0.5,100,-1,Infinity,-Infinity,NaN];
  for(const tick of ticks)assert.equal(lookup(tick,list),oracle(list,tick),'tick '+tick);
});
test('actual cursor handles append/truncate length changes and independent recordings',()=>{
  const lookup=freshLookup(),a=[0,5],b=[1,6];
  for(const edit of [()=>{},()=>a.push(9),()=>a.splice(1),()=>a.push(3,4,20)]){
    edit();for(const tick of [0,5,10,0,2,3,20,21])for(const list of [a,b])assert.equal(lookup(tick,list),oracle(list,tick));
  }
});
test('seeded cursor property cases preserve first-equal semantics across repeated, skipped and rewound ticks',()=>{
  let seed=91273;const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  const lookup=freshLookup();
  for(let round=0;round<200;round++){
    let value=0;const list=Array.from({length:random()%100},()=>value+=random()%5);
    for(let q=0;q<200;q++){const tick=q<100?q:random()%(value+20);assert.equal(lookup(tick,list),oracle(list,tick));}
  }
});
test('indexed work model equals actual helper element probes, including duplicates and last-tick boundaries',()=>{
  for(const frames of [1,2,10,100]){
    const lists=[[],[0],[0,0,1,frames],[Math.max(0,frames-1)],Array.from({length:frames},(_,i)=>i)];
    let probes=0;const observed=lists.map(list=>new Proxy(list,{get(target,key){if(/^\d+$/.test(String(key)))probes++;return Reflect.get(target,key);}}));
    const lookup=freshLookup();for(let tick=0;tick<frames;tick++)for(const list of observed)lookup(tick,list);
    assert.equal(indexedForwardWork(lists,frames),probes+frames*5,'frames '+frames);
  }
});
test('synthetic two-million-tick replay is retained offline without forging live engine permission',async()=>{
  const lists=Array.from({length:5},(_,channel)=>Array.from({length:20},(_,i)=>i*1000+channel));
  const recording=encode(lists),frames=2000000;
  const stats=await validatePublicReplayForPublication(recording,frames);
  assert.equal(stats.structureValid,true);assert.equal(stats.transitions,100);assert.equal(stats.runtimeCapability,false);
  assert(stats.legacyWork>30000000);assert(stats.playbackWork<30000000);assert.equal(stats.indexedPlaybackWithinBudget,true);
  assert.equal(stats.inputSha256.length,64);assert.equal(playbackEngineMetadata(stats),null);
  await assert.rejects(validatePublicReplayStructure(recording,frames,{playbackEngine:stats}),/work limit/);
});
test('publication may retain valid data beyond runtime budget, but never grants live playback capability',async()=>{
  const recording=encode(Array.from({length:5},()=>[0,3999999]));
  const stats=await validatePublicReplayForPublication(recording,4000000);
  assert.equal(stats.structureValid,true);assert.equal(stats.indexedPlaybackWithinBudget,false);assert.equal(stats.runtimeCapability,false);
  await assert.rejects(validatePublicReplayStructure(recording,4000000),/work limit/);
});
test('frame, ordering, transition and trailing-byte structure bounds remain enforced',async()=>{
  await assert.rejects(validatePublicReplayForPublication(encode([[],[],[],[],[]]),4000001));
  await assert.rejects(validatePublicReplayForPublication(encode([[0,0],[],[],[],[]]),100),/Unordered/);
  await assert.rejects(validatePublicReplayForPublication(encode([[101],[],[],[],[]]),100));
  await assert.rejects(validatePublicReplayForPublication(encode([Array.from({length:20001},(_,i)=>i),[],[],[],[]]),100000),/transition limit/);
  await assert.rejects(validatePublicReplayForPublication(deflateSync(Buffer.alloc(16)).toString('base64url'),100),/Trailing/);
});
