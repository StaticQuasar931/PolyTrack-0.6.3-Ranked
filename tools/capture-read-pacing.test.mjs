import test from 'node:test';
import assert from 'node:assert/strict';
import {CAPTURE_READ_PACER,createCaptureReadPacer} from './capture-read-pacing.mjs';
import {fetchPublicBackupJson} from './public-backup-fetch.mjs';
import {createPublicMissGuard} from '../workers/ranked/src/public-miss-guard.js';
const origin='https://polytrack-ranked-worker.staticquasar931.workers.dev';
test('real missing-board guard rejects an unpaced eleven-miss full inventory',()=>{
 const guard=createPublicMissGuard({now:()=>0});for(let i=0;i<10;i++)guard.reserve('capture')(true);assert.equal(guard.reserve('capture'),null);
});
test('111 absent boards and populated boards pass unchanged Worker safeguards without retry or extra requests',async()=>{
 let at=0,calls=0,quotaCalls=0;const guard=createPublicMissGuard({now:()=>at});
 const fetchImpl=async url=>{calls++;const done=guard.reserve('capture');if(!done){quotaCalls++;return new Response('{"error":"rate_limited"}',{status:429});}const missing=new URL(url).searchParams.get('missing')==='1';done(missing);return new Response(missing?'{}':'{"complete":true}',{status:missing?404:200});};
 Object.defineProperty(fetchImpl,CAPTURE_READ_PACER,{value:createCaptureReadPacer({now:()=>at,sleep:async ms=>{at+=ms;}})});
 for(let i=0;i<111;i++)assert.equal(await fetchPublicBackupJson(fetchImpl,origin+'/v1/snapshot/track?missing=1&id='+i,{optional:true}),null);
 for(let i=0;i<150;i++)assert.equal((await fetchPublicBackupJson(fetchImpl,origin+'/v1/snapshot/track?id='+i)).complete,true);
 assert.equal(calls,261);assert.equal(quotaCalls,0);assert.ok(at<16*60000,'bounded pacing fits the existing fifty-minute child');
});
test('capture event requests stay below sixty per minute and HTTP timeout is created after pacing',async()=>{
 let at=0;const starts=[];const fetchImpl=async(url,options)=>{assert.equal(options.signal.aborted,false);starts.push(at);return new Response('{}');};
 Object.defineProperty(fetchImpl,CAPTURE_READ_PACER,{value:createCaptureReadPacer({now:()=>at,sleep:async ms=>{at+=ms;}})});
 for(let i=0;i<100;i++)await fetchPublicBackupJson(fetchImpl,origin+'/v1/events/week/snapshot');
 for(const start of starts)assert.ok(starts.filter(t=>t>=start&&t<start+60000).length<=40);
});
test('429 reports only bounded recognized error codes and does not retry',async()=>{
 let calls=0;await assert.rejects(fetchPublicBackupJson(async()=>{calls++;return new Response('{"error":"rate_limited","secret":"do not log"}',{status:429});},origin+'/v1/status'),e=>e.status===429&&e.message==='Public backup service temporarily unavailable (rate_limited)');assert.equal(calls,1);
 await assert.rejects(fetchPublicBackupJson(async()=>new Response('{"error":"private-user-text"}',{status:429}),origin+'/v1/status'),e=>!e.message.includes('private-user-text'));
});

test('four concurrent inventory workers respect pending reservations as well as completed misses',async()=>{
 let at=0,calls=0,denied=0;const guard=createPublicMissGuard({now:()=>at});
 const fetchImpl=async()=>{calls++;const release=guard.reserve('capture');if(!release){denied++;return new Response('{"error":"rate_limited"}',{status:429});}await Promise.resolve();release(true);return new Response('{}',{status:404});};
 Object.defineProperty(fetchImpl,CAPTURE_READ_PACER,{value:createCaptureReadPacer({now:()=>at,sleep:async ms=>{at+=ms;}})});
 let next=0;await Promise.all(Array.from({length:4},async()=>{for(;;){const id=next++;if(id>=111)return;await fetchPublicBackupJson(fetchImpl,origin+'/v1/snapshot/track?id='+id,{optional:true});}}));
 assert.equal(calls,111);assert.equal(denied,0);assert.ok(at<20*60000);
});
