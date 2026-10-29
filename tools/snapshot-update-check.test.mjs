import test from 'node:test';
import assert from 'node:assert/strict';
import {createSnapshotUpdateCheck, SNAPSHOT_UPDATE_ENDPOINTS} from './snapshot-update-check.mjs';
const response = data => new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}});
test('manual static check coalesces requests and never calls the game backend', async () => {
 let at=1000,calls=[];
 const check=createSnapshotUpdateCheck({now:()=>at,fetchImpl:async(url,options)=>{calls.push(url);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');return response({snapshotDirectory:'public-snapshots69',currentdir:'public-snapshots69'});}});
 assert.equal(calls.length,0,'creating a checker must not start a request');
 const results=await Promise.all(Array.from({length:8},()=>check.check(68)));
 assert.equal(calls.length,2);assert.ok(results.every(r=>r.status==='newer'&&r.generation===69));
 assert.equal((await check.check(69)).status,'current');assert.equal(calls.length,2);
 at+=60001;await check.check(68);assert.equal(calls.length,4);assert.deepEqual(new Set(calls),new Set(SNAPSHOT_UPDATE_ENDPOINTS));
});

test('a current CDN pointer cannot hide a newer Pages generation',async()=>{
 const calls=[];
 const check=createSnapshotUpdateCheck({fetchImpl:async url=>{
  calls.push(url);
  return response(url===SNAPSHOT_UPDATE_ENDPOINTS[0]?{snapshotDirectory:'public-snapshots68'}:{currentdir:'public-snapshots69'});
 }});
 assert.deepEqual(await check.check(68),{generation:69,status:'newer'});
 assert.deepEqual(calls,[...SNAPSHOT_UPDATE_ENDPOINTS]);
 assert.deepEqual(await check.check(68),{generation:69,status:'newer'});
 assert.equal(calls.length,2,'repeat clicks reuse the complete fallback result');
});

test('current requires a fallback attempt and reports only successfully read generations',async()=>{
 for(const fallback of [68,67,null]){
  const calls=[];
  const check=createSnapshotUpdateCheck({fetchImpl:async url=>{
   calls.push(url);
   if(url===SNAPSHOT_UPDATE_ENDPOINTS[0])return response({snapshotDirectory:'public-snapshots68'});
   if(fallback===null)throw Error('CORS blocked');
   return response({currentdir:'public-snapshots'+fallback});
  }});
  assert.deepEqual(await check.check(68),fallback===null?{status:'unavailable'}:{generation:68,status:'current'});
  assert.deepEqual(calls,[...SNAPSHOT_UPDATE_ENDPOINTS]);
 }
});
test('static fallback is bounded, and failures also have a cooldown',async()=>{
 let calls=0;const check=createSnapshotUpdateCheck({fetchImpl:async url=>{calls++;if(url===SNAPSHOT_UPDATE_ENDPOINTS[0])throw Error('blocked');return response({currentdir:'public-snapshots68'});}});
 assert.equal((await check.check(69)).status,'unavailable');assert.equal(calls,2);await check.check(69);assert.equal(calls,2);
 const failing=createSnapshotUpdateCheck({fetchImpl:async()=>{calls++;return response({snapshotDirectory:'https://evil.test/'});}});
 assert.equal((await failing.check(68)).status,'unavailable');await failing.check(68);assert.equal(calls,4);
});

test('coalesced callers with different installed generations share a complete host result', async () => {
 let calls=0;
 const check=createSnapshotUpdateCheck({fetchImpl:async url=>{calls++;return response(url===SNAPSHOT_UPDATE_ENDPOINTS[0]?{snapshotDirectory:'public-snapshots69'}:{currentdir:'public-snapshots70'});}});
 assert.deepEqual(await Promise.all([check.check(68),check.check(69),check.check(70)]),[
  {generation:70,status:'newer'},{generation:70,status:'newer'},{generation:70,status:'current'}]);
 assert.equal(calls,2);
});

test('stale is not current and one valid newer release is sufficient despite a host failure', async () => {
 for(const generation of [67,69]){
  const check=createSnapshotUpdateCheck({fetchImpl:async url=>response(url===SNAPSHOT_UPDATE_ENDPOINTS[0]?{snapshotDirectory:`public-snapshots${generation}`}:{currentdir:`public-snapshots${generation}`})});
  assert.deepEqual(await check.check(68),{generation,status:generation===67?'stale':'newer'});
 }
 const check=createSnapshotUpdateCheck({fetchImpl:async url=>{if(url===SNAPSHOT_UPDATE_ENDPOINTS[0])throw Error('offline');return response({currentdir:'public-snapshots69'});}});
 assert.deepEqual(await check.check(68),{generation:69,status:'newer'});
});

test('timeout bounds fetch and body stalls even when abort is ignored, and clears timers', async () => {
 for(const bodyStall of [false,true]){
  const timers=new Map();let id=0,calls=0;
  const check=createSnapshotUpdateCheck({setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id),
   fetchImpl:async()=>{calls++;return bodyStall?{ok:true,headers:new Headers(),body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})})}}:new Promise(()=>{});}});
  const pending=check.check(68);
  for(let endpoint=0;endpoint<2;endpoint++){
   for(let tick=0;tick<20&&!timers.size;tick++)await Promise.resolve();
   assert.equal(timers.size,1);[...timers.values()][0]();
   for(let tick=0;tick<20;tick++)await Promise.resolve();
  }
  assert.deepEqual(await pending,{status:'unavailable'});assert.equal(calls,2);assert.equal(timers.size,0);
  await check.check(68);assert.equal(calls,2,'failures are cooled down');check.dispose();
 }
});

test('caller cancellation does not abort another subscriber, and full cancellation is retryable', async () => {
 let resolve,calls=0,signal;
 const check=createSnapshotUpdateCheck({fetchImpl:(url,options)=>{calls++;signal=options.signal;
  return url===SNAPSHOT_UPDATE_ENDPOINTS[0]?new Promise(done=>{resolve=done;}):Promise.resolve(response({currentdir:'public-snapshots69'}));}});
 const controller=new AbortController();
 const first=check.check(68,{signal:controller.signal}),second=check.check(69);
 controller.abort();assert.deepEqual(await first,{status:'cancelled'});assert.equal(signal.aborted,false);
 resolve(response({snapshotDirectory:'public-snapshots69'}));assert.deepEqual(await second,{generation:69,status:'current'});
 assert.equal(calls,2);check.dispose();assert.deepEqual(await check.check(68),{status:'cancelled'});
 let abortedSignal;
 const retry=createSnapshotUpdateCheck({fetchImpl:async(url,options)=>{abortedSignal=options.signal;return new Promise(()=>{});}});
 const abort=new AbortController(),pending=retry.check(68,{signal:abort.signal});abort.abort();
 assert.deepEqual(await pending,{status:'cancelled'});assert.equal(abortedSignal.aborted,true);
 const next=retry.check(68);assert.equal(abortedSignal.aborted,false);retry.cancel();assert.deepEqual(await next,{status:'cancelled'});
 retry.dispose();
});

test('disposing an in-flight check ignores late success and prevents fallback or cached UI', async () => {
 let resolve,calls=0;
 const check=createSnapshotUpdateCheck({fetchImpl:()=>{calls++;return new Promise(done=>{resolve=done;});}});
 const pending=check.check(68);check.dispose();resolve(response({snapshotDirectory:'public-snapshots69'}));
 assert.deepEqual(await pending,{status:'cancelled'});assert.equal(calls,1);
 assert.deepEqual(await check.check(68),{status:'cancelled'});
});
test('invalid, redirected, and oversized responses cannot offer a reload',async()=>{
 for(const value of [{snapshotDirectory:'public-snapshots0'}, {snapshotDirectory:'public-snapshots68/../69'}, {snapshotDirectory:'public-snapshots9999999999'}, {snapshotDirectory:'public-snapshots69',padding:'x'.repeat(17000)}]){
  const check=createSnapshotUpdateCheck({fetchImpl:async()=>response(value)});assert.equal((await check.check(68)).status,'unavailable');
 }
 let calls=0;const check=createSnapshotUpdateCheck({fetchImpl:async()=>{calls++;throw Error('unexpected');}});assert.equal((await check.check(null)).status,'unavailable');assert.equal(calls,0);
});
