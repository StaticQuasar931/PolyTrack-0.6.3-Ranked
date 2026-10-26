import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createLocalOverallController, LOCAL_OVERALL_RECEIPTS_KEY} from './overall-local-controller.mjs';
import {computeOverall, trackWeightParts} from '../workers/ranked/src/index.js';
import {createOverallProjectionBundle} from './overall-projection-bundle.mjs';

const id='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const clock=2000000000000;
const clone=value=>JSON.parse(JSON.stringify(value));
function dataset() {
  const metadata={algorithmVersion:'participation-v8-s1',schemaVersion:6,sourceRevision:10,builtRevision:10,updatedAt:100000};
  const weight=Number(trackWeightParts(id,2,1).finalWeight.toFixed(3));
  const board={...metadata,trackId:id,complete:true,totalEntries:2,entries:[['a',10000],['b',12000]].map(([accountId,timeMs])=>
    ({accountId,userId:accountId,trackId:id,timeMs,pbAt:100,weight,runVerified:true,integrityVerified:true}))};
  const entries=computeOverall([board],[],new Set(),{includePlannerResults:true});
  const overall={...metadata,entries,complete:true,totalEntries:entries.length,trackCatalog:[{trackId:id,updatedAt:board.updatedAt}]};
  const encoded={entries:entries.map(row=>({userId:row.userId,resultSamples:row.resultSamples})),resultTracks:[id]};
  const results={...metadata,resultBundleVersion:1,resultBundleEncoding:'gzip-base64-json-v1',resultBundleComplete:true,
    resultBoardCount:1,resultBoardLimitReached:false,resultBundle:gzipSync(JSON.stringify(encoded)).toString('base64')};
  return {overall,results,boards:new Map([[id,board]])};
}
function memory(initial) {
  const map=new Map(initial ? [[LOCAL_OVERALL_RECEIPTS_KEY,initial]] : []);
  return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),map};
}
function fixture(options={}) {
  const data=dataset(), states=[], calls=[];
  let account='b',visible=true,time=clock,info={generation:43,epoch:0,baseUrl:'http://local/public-snapshots43/'};
  const storage=options.storage||memory();
  const read=async(kind,trackId)=>{
    calls.push([kind,trackId]);
    if(options.read)return options.read(kind,trackId,data);
    return clone(kind==='overall'?data.overall:kind==='overall-results'?data.results:data.boards.get(trackId));
  };
  const controller=createLocalOverallController({storage,read,packageInfo:()=>info,getAccount:()=>account,isVisible:()=>visible,
    getLocalPbs:options.getLocalPbs||(()=>[]),readProjectionSource:options.readProjectionSource?()=>options.readProjectionSource(data):null,onState:state=>states.push(state),now:()=>time});
  return {controller,data,states,calls,storage,setAccount:v=>{account=v;},setVisible:v=>{visible=v;},setInfo:v=>{info=v;},advance:ms=>{time+=ms;},
    ack:(rest={})=>controller.acknowledge({accountId:'b',trackId:id,timeMs:9000,acceptedAt:time,...rest})};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('bound projection source avoids one request per track and rejects a corrupt source without fallback',async()=>{
 const f=fixture({readProjectionSource:data=>createOverallProjectionBundle({overall:data.overall,results:data.results,tracks:[...data.boards.values()]})});
 f.ack();const state=await f.controller.update();assert.equal(state.status,'projected');assert.equal(f.calls.filter(([kind])=>kind==='track').length,0);
 const g=fixture({readProjectionSource:()=>({version:1,boards:[]})});g.ack();const invalid=await g.controller.update();
 assert.equal(invalid.status,'unavailable');assert.equal(g.calls.filter(([kind])=>kind==='track').length,0);
});

test('device-local PBs recalculate without fabricating cloud acknowledgements and update when local time improves',async()=>{
 let timeMs=9000;
 const f=fixture({getLocalPbs:()=>[{accountId:'b',trackId:id,timeMs,observedAt:clock}]});
 const first=await f.controller.update();assert.equal(first.status,'projected');assert.equal(first.result.localPbsApplied,true);
 assert.match(first.result.assumption,/provisional/);assert.equal(f.storage.getItem(LOCAL_OVERALL_RECEIPTS_KEY),null);
 timeMs=8000;const next=await f.controller.update();assert.equal(next.status,'projected');assert.notEqual(next.result,first.result);
 f.setAccount('a');const other=await f.controller.update();assert.equal(other.status,'idle');
});

test('no static preload without receipts; hidden acknowledgements stay local until Overall is visible',async()=>{
  const f=fixture();await f.controller.update();assert.equal(f.calls.length,0);
  f.setVisible(false);assert.equal(f.ack(),true);await f.controller.update();assert.equal(f.calls.length,0);
  f.setVisible(true);const result=await f.controller.update();assert.equal(result.status,'projected');assert.equal(f.calls.length,3);
  assert.equal(result.accountId,'b');assert.equal(result.generation,43);assert.equal(result.result.localPending,true);
});
test('concurrent updates coalesce; completed baseline and unchanged projection reuse memory',async()=>{
  const f=fixture();f.ack();const first=f.controller.update(),second=f.controller.update();assert.equal(first,second);
  await first;const count=f.calls.length;for(let i=0;i<10;i++)await f.controller.update();assert.equal(f.calls.length,count);
  f.ack({timeMs:8000});const next=await f.controller.update();assert.equal(next.status,'projected');assert.equal(f.calls.length,count);
  assert.equal(next.result.projection.trackResults[0].timeMs,8000);
});
test('storage persists compact coalesced receipts, with no extra data and a global 128-item limit',async()=>{
  const f=fixture();f.setVisible(false);
  f.ack();f.ack({timeMs:11000});f.ack({timeMs:8000});
  let saved=JSON.parse(f.storage.getItem(LOCAL_OVERALL_RECEIPTS_KEY));assert.deepEqual(saved.rows,[['b',id,8000,clock,43]]);
  for(let i=0;i<160;i++){f.advance(1);f.ack({trackId:'track'+i});}
  await f.controller.update();saved=JSON.parse(f.storage.getItem(LOCAL_OVERALL_RECEIPTS_KEY));assert.equal(saved.rows.length,128);
  assert.ok(saved.rows.every(row=>row.length===5));assert.equal(f.calls.length,0);
});
test('receipts survive reload; account selection only uses its own receipts and shares one package baseline',async()=>{
  const f=fixture();f.setVisible(false);f.ack();await f.controller.update();
  const reload=fixture({storage:f.storage});assert.equal((await reload.controller.update()).status,'projected');
  const count=reload.calls.length;reload.setAccount('a');assert.equal((await reload.controller.update()).status,'idle');assert.equal(reload.calls.length,count);
  reload.ack({accountId:'a',timeMs:9500});assert.equal((await reload.controller.update()).accountId,'a');assert.equal(reload.calls.length,count);
});
test('a newer generation ignores old receipts and clears the previous projection without reads',async()=>{
  const f=fixture();f.ack();await f.controller.update();const count=f.calls.length;
  f.setInfo({generation:44,epoch:1,baseUrl:'http://local/public-snapshots44/'});
  const next=await f.controller.update();assert.equal(next.status,'idle');assert.equal(next.generation,44);assert.equal(next.result,undefined);assert.equal(f.calls.length,count);
});
test('a same-generation epoch change invalidates baseline and reloads before publishing',async()=>{
  const f=fixture();f.ack();await f.controller.update();const count=f.calls.length;
  f.setInfo({generation:43,epoch:1,baseUrl:'http://local/public-snapshots43/'});
  assert.equal((await f.controller.update()).status,'projected');assert.equal(f.calls.length,count+3);
});
test('package change during reads cannot stamp or publish rows from a retired package',async()=>{
  const gate=deferred();let started;
  const startedGate=deferred();
  const f=fixture({read:async(kind,trackId,data)=>{if(kind==='track'){startedGate.resolve();await gate.promise;}return clone(kind==='overall'?data.overall:kind==='overall-results'?data.results:data.boards.get(trackId));}});
  f.ack();const work=f.controller.update();await startedGate.promise;started=f.states.length;
  f.setInfo({generation:44,epoch:1,baseUrl:'http://local/public-snapshots44/'});const next=f.controller.update();gate.resolve();await Promise.all([work,next]);
  assert.ok(f.states.slice(started).every(row=>row.generation===44));assert.equal(f.states.at(-1).status,'idle');
});
test('account switch during reads cannot publish another account projection',async()=>{
  const gate=deferred(),started=deferred();
  const f=fixture({read:async(kind,trackId,data)=>{if(kind==='track'){started.resolve();await gate.promise;}return clone(kind==='overall'?data.overall:kind==='overall-results'?data.results:data.boards.get(trackId));}});
  f.ack();const work=f.controller.update();await started.promise;const marker=f.states.length;
  f.setAccount('a');const next=f.controller.update();gate.resolve();await Promise.all([work,next]);
  assert.ok(f.states.slice(marker).every(row=>row.accountId==='a'));assert.equal(f.states.at(-1).result,undefined);
});
test('hiding Overall during reads suppresses late projection',async()=>{
  const gate=deferred(),started=deferred();
  const f=fixture({read:async(kind,trackId,data)=>{if(kind==='track'){started.resolve();await gate.promise;}return clone(kind==='overall'?data.overall:kind==='overall-results'?data.results:data.boards.get(trackId));}});
  f.ack();const work=f.controller.update();await started.promise;f.setVisible(false);const next=f.controller.update();gate.resolve();await Promise.all([work,next]);
  assert.equal(f.states.at(-1).status,'idle');assert.ok(f.states.every(row=>row.status!=='projected'));
});
test('failures retry no more than once per minute, even after invalidate or repeated renders',async()=>{
  let broken=true;
  const f=fixture({read:async(kind,trackId,data)=>{if(broken)throw Error('temporary_failure');return clone(kind==='overall'?data.overall:kind==='overall-results'?data.results:data.boards.get(trackId));}});
  f.ack();assert.equal((await f.controller.update()).status,'unavailable');const count=f.calls.length;
  for(let i=0;i<10;i++)await f.controller.update();await f.controller.invalidate();assert.equal(f.calls.length,count);
  broken=false;f.advance(59999);await f.controller.update();assert.equal(f.calls.length,count);
  f.advance(1);assert.equal((await f.controller.update()).status,'projected');assert.equal(f.calls.length,count+3);
});
test('missing/partial inputs return unavailable without an exact projection',async()=>{
  const f=fixture();f.data.boards.get(id).complete=false;f.ack();const state=await f.controller.update();
  assert.equal(state.status,'unavailable');assert.equal(state.result.calculationExact,false);assert.equal(state.result.projection,null);
});
test('oversized catalogs stop before any track read',async()=>{
  const f=fixture();f.data.overall.trackCatalog=Array.from({length:513},(_,i)=>({trackId:'t'+i,updatedAt:100}));f.data.results.resultBoardCount=513;
  f.ack();const state=await f.controller.update();assert.equal(state.status,'unavailable');assert.equal(f.calls.length,2);
});
test('track reads use at most four workers, stop on failure, and drain before retry',async()=>{
  let inflight=0,peak=0,trackCalls=0;
  const f=fixture({read:async(kind,trackId,data)=>{
    if(kind!=='track')return clone(kind==='overall'?data.overall:data.results);
    inflight++;peak=Math.max(peak,inflight);trackCalls++;
    try {await new Promise(resolve=>setTimeout(resolve,5));if(trackId==='t1')throw Error('temporary_track');return {...data.boards.get(id),trackId};}finally{inflight--;}
  }});
  f.data.overall.trackCatalog=Array.from({length:12},(_,i)=>({trackId:'t'+i,updatedAt:100}));f.data.results.resultBoardCount=12;
  f.ack();assert.equal((await f.controller.update()).status,'unavailable');assert.ok(peak<=4);assert.equal(inflight,0);assert.ok(trackCalls<12);
});
test('expired, malformed and future receipts do not trigger downloads',async()=>{
  const f=fixture({storage:memory('{invalid')});
  assert.equal(f.ack({acceptedAt:clock-29*86400000}),false);assert.equal(f.ack({acceptedAt:clock+300001}),false);
  assert.equal(f.ack({timeMs:0}),false);await f.controller.update();assert.equal(f.calls.length,0);
  f.ack();await f.controller.update();f.advance(29*86400000);assert.equal((await f.controller.update()).status,'idle');
  assert.deepEqual(JSON.parse(f.storage.getItem(LOCAL_OVERALL_RECEIPTS_KEY)).rows,[]);
});
test('storage failure preserves in-memory operation',async()=>{
  const f=fixture({storage:{getItem(){throw Error('blocked');},setItem(){throw Error('quota');}}});
  f.ack();assert.equal((await f.controller.update()).status,'projected');
});
test('decoded payload cannot override trusted metadata bindings',async()=>{
  const f=fixture();const payload=JSON.parse((await import('node:zlib')).gunzipSync(Buffer.from(f.data.results.resultBundle,'base64')));
  payload.sourceRevision=999;f.data.results.resultBundle=gzipSync(JSON.stringify(payload)).toString('base64');
  f.ack();assert.equal((await f.controller.update()).status,'projected');
});
test('oversized inflated planner data is refused before track downloads',async()=>{
  const f=fixture();f.data.results.resultBundle=gzipSync(' '.repeat(6*1024*1024+1)).toString('base64');
  f.ack();const state=await f.controller.update();assert.equal(state.status,'unavailable');assert.equal(state.reason,'result_bundle_too_large');assert.equal(f.calls.length,2);
});
test('current saved generation projects only with complete matching source boards, without external requests',async()=>{
  const {startResponsiveServer}=await import('./responsive-server.mjs');
  const {createPublicSnapshotReader}=await import('./public-snapshot-client.mjs');
  const server=await startResponsiveServer();let trackReads=0,inflight=0,peak=0;const sourceBoards=[];
  try {
    const pointer=await (await fetch(server.url+'/snapshot-current.json')).json();
    const generation=Number(pointer.currentdir.replace('public-snapshots',''));
    const baseUrl=server.url+'/'+pointer.currentdir+'/';
    const read=createPublicSnapshotReader({baseUrl,packed:true,bootstrap:true,optimizedIndex:true,
      fetchImpl:async(url,options)=>{assert.equal(new URL(url).origin,server.url);return fetch(url,options);}});
    const overall=await read('overall'),accountId=overall.entries[0].userId;
    const first=await read('track',id),old=first.entries.find(row=>(row.accountId||row.userId)===accountId);assert.ok(old);
    const wrapped=async(kind,...args)=>{if(kind==='track'){trackReads++;inflight++;peak=Math.max(peak,inflight);}try{const value=await read(kind,...args);if(kind==='track')sourceBoards.push({trackId:args[0],value});return value;}finally{if(kind==='track')inflight--;}};
    const controller=createLocalOverallController({storage:memory(),read:wrapped,
      packageInfo:()=>({generation,epoch:0,baseUrl}),getAccount:()=>accountId,
      isVisible:()=>true,now:()=>overall.updatedAt+1000});
    controller.acknowledge({accountId,trackId:id,timeMs:old.timeMs-1,acceptedAt:overall.updatedAt+1000});
    const state=await controller.update();
    const missing=sourceBoards.some(row=>!row.value);
    const mismatched=sourceBoards.some(row=>row.value&&(row.value.updatedAt??row.value.builtAt??0)!==overall.trackCatalog.find(track=>track.trackId===row.trackId)?.updatedAt);
    if(missing){assert.equal(state.status,'unavailable');assert.equal(state.reason,'missing_track');}
    else if(mismatched){assert.equal(state.status,'unavailable');assert.equal(state.reason,'track_binding_mismatch');}
    else{assert.equal(state.status,'projected',state.reason);assert.equal(state.result.racers.length,overall.entries.length);assert.equal(state.result.publicRank,null);assert.equal(state.result.localPending,true);}
    assert.ok(peak<=4);assert.ok(trackReads<=overall.trackCatalog.length);
    const count=trackReads;await controller.update();assert.equal(trackReads,count);
  }finally{await server.close();}
});

test('other profiles cannot exhaust the active profile local-PB bound',async()=>{
 const rows=Array.from({length:600},()=>({accountId:'a',trackId:id,timeMs:8000,observedAt:clock}));
 rows.push({accountId:'b',trackId:id,timeMs:9000,observedAt:clock});
 const f=fixture({getLocalPbs:()=>rows});const state=await f.controller.update();
 assert.equal(state.status,'projected');assert.equal(state.accountId,'b');assert.equal(state.result.localPending,true);
});

test('immutable source mismatch waits for a new snapshot instead of reloading every minute',async()=>{
 const f=fixture();f.data.boards.get(id).updatedAt++;f.ack();
 const first=await f.controller.update();assert.equal(first.status,'unavailable');assert.equal(first.reason,'track_binding_mismatch');
 const reads=f.calls.length;f.advance(3600000);await f.controller.update();await f.controller.invalidate();assert.equal(f.calls.length,reads);
 f.data.boards.get(id).updatedAt--;f.setInfo({generation:44,epoch:1,baseUrl:'http://local/public-snapshots44/'});f.ack();
 assert.equal((await f.controller.update()).status,'projected');assert.ok(f.calls.length>reads);
});
