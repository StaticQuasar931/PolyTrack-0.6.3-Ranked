import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicMissGuard} from '../src/public-miss-guard.js';
import {handleRequest} from '../src/index.js';
import {eventEncode} from '../src/events-store.js';

test('negative budgets reset, bound key retention and do not charge successful probes',()=>{
 let now=0;const guard=createPublicMissGuard({now:()=>now,maxClients:2});
 for(let i=0;i<100;i++)assert.equal(guard.permits('valid'),true);
 for(let i=0;i<10;i++){assert.equal(guard.permits('a'),true);guard.missing('a');}
 assert.equal(guard.permits('a'),false);assert.equal(guard.permits('b'),true);
 guard.missing('b');assert.equal(guard.size(),2);assert.equal(guard.permits('c'),false);
 now=60000;assert.equal(guard.permits('a'),true);assert.equal(guard.size(),0);
 guard.missing('a');now=0;assert.equal(guard.size(),0,'clock reversal cannot retain an unbounded stale ledger');
});

test('aggregate isolate-local miss limit also bounds rotating caller keys',()=>{
 const guard=createPublicMissGuard({now:()=>0});
 for(let i=0;i<50;i++){assert.equal(guard.permits('client-'+i),true);guard.missing('client-'+i);}
 assert.equal(guard.permits('another'),false);assert.equal(guard.size(),50);
});

test('rotating track and page misses stop before storage while warm custom boards stay readable',async t=>{
 t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));
 const logs=[];t.mock.method(console,'log',(label,body)=>logs.push(JSON.parse(body)));
 const previous=globalThis.caches;delete globalThis.caches;
 t.after(()=>{if(previous===undefined)delete globalThis.caches;else globalThis.caches=previous;});
 const origin='https://miss-guard.invalid';let reads=0;
 const env={ALLOWED_ORIGINS:origin,PUBLIC_READ_RATE_LIMITER:{limit:async()=>({success:true})},
  __TEST_FIRESTORE:async path=>{reads++;return path.endsWith('/future_custom_track')?
   {fields:eventEncode({entries:[],trackId:'future_custom_track'}).mapValue.fields}:null;}};
 const get=path=>handleRequest(new Request(origin+path,{headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'}}),env);
 assert.equal((await get('/v1/snapshot/track?trackId=future_custom_track')).status,200);
 for(let i=0;i<10;i++){
  const path=i%2?'/v1/snapshot/track?trackId=missing_track_'+i:
   '/v1/snapshot/overall/page?generation='+String(i+1).padStart(64,'0')+'&page=0';
  assert.equal((await get(path)).status,404);
 }
 assert.equal(reads,11);
 for(let i=10;i<30;i++)assert.equal((await get('/v1/snapshot/track?trackId=missing_track_'+i)).status,429);
 assert.equal(reads,11,'rejected probes have no additional Firestore operations');
 assert.equal(logs.at(-1).httpRequests,0);assert.equal(logs.at(-1).documentReadEstimate,0);
 assert.equal((await get('/v1/snapshot/track?trackId=future_custom_track')).status,200);
 assert.equal(reads,11,'already-cached legitimate custom board bypasses the miss circuit');
 assert.doesNotMatch(JSON.stringify(logs),/192\.0\.2|missing_track/);
});

test('cold reservations release on success/failure, charge absence once and survive clock rollover',()=>{
 let now=0;const guard=createPublicMissGuard({now:()=>now,perClient:2,total:3,maxClients:2});
 const first=guard.reserve('a'),second=guard.reserve('a'),third=guard.reserve('b');
 assert.equal(guard.reserve('a'),null);assert.equal(guard.reserve('c'),null);
 first();first(true);assert.equal(guard.permits('a'),true,'double completion cannot charge a success');
 second(true);second(true);assert.equal(guard.reserve('a') instanceof Function,true);
 assert.equal(guard.reserve('c'),null,'missed and pending clients share the key bound');
 third();const newcomer=guard.reserve('c');assert.equal(typeof newcomer,'function');newcomer();
 now=60000;const fresh=guard.reserve('a');first(true);fresh();assert.equal(guard.size(),0);
 const late=guard.reserve('b');now=120000;assert.equal(guard.permits('a'),true);late(true);
 assert.equal(guard.size(),0,'expired requests do not spend the new window');
});

for(const missing of [false,true])test('concurrent public loads '+(missing?'reserve miss budgets':'share successes and release reservations'),async t=>{
 t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));t.mock.method(console,'log',()=>{});
 const previous=globalThis.caches;delete globalThis.caches;t.after(()=>{if(previous===undefined)delete globalThis.caches;else globalThis.caches=previous;});
 const origin='https://miss-concurrency.invalid';let reads=0,release;
 const gate=new Promise(r=>release=r),env={ALLOWED_ORIGINS:origin,PUBLIC_READ_RATE_LIMITER:{limit:async()=>({success:true})},
  __TEST_FIRESTORE:async()=>{reads++;await gate;return missing?null:{fields:eventEncode({entries:[]}).mapValue.fields};}};
 const get=id=>handleRequest(new Request(origin+'/v1/snapshot/track?trackId='+id,{headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'}}),env);
 const pending=Array.from({length:60},(_,i)=>get(missing?'missing_'+String(i).padStart(3,'0'):'same_custom_track'));
 await new Promise(r=>setImmediate(r));const started=reads;release();const responses=await Promise.all(pending);
 assert.equal(started,missing?10:1);assert.equal(responses.filter(r=>r.status===429).length,missing?50:0);
 if(!missing){for(let i=0;i<25;i++)assert.equal((await get('another_custom_'+i)).status,200);assert.equal(reads,26);}
});

test('failed cold transport releases its reservation rather than consuming the miss budget',async t=>{
 t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));t.mock.method(console,'log',()=>{});
 const previous=globalThis.caches;delete globalThis.caches;t.after(()=>{if(previous!==undefined)globalThis.caches=previous;});
 const origin='https://miss-failure.invalid';let reads=0;
 const env={ALLOWED_ORIGINS:origin,__TEST_FIRESTORE:async()=>{reads++;throw Error('FIRESTORE_503');}};
 for(let i=0;i<20;i++)await assert.rejects(handleRequest(new Request(origin+'/v1/snapshot/track?trackId=valid_custom_track',{headers:{Origin:origin}}),env),/FIRESTORE_503/);
 assert.equal(reads,20,'transport errors are not confirmed absence; upstream limiter remains responsible');
});