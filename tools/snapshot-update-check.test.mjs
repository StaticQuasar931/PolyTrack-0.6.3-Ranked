import test from 'node:test';
import assert from 'node:assert/strict';
import {createSnapshotUpdateCheck, SNAPSHOT_UPDATE_ENDPOINTS} from './snapshot-update-check.mjs';
const response = data => new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}});
test('manual static check coalesces requests and never calls the game backend', async () => {
 let at=1000,calls=[];
 const check=createSnapshotUpdateCheck({now:()=>at,fetchImpl:async(url,options)=>{calls.push(url);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');return response({snapshotDirectory:'public-snapshots69'});}});
 assert.equal(calls.length,0,'creating a checker must not start a request');
 const results=await Promise.all(Array.from({length:8},()=>check.check(68)));
 assert.equal(calls.length,1);assert.ok(results.every(r=>r.status==='newer'&&r.generation===69));
 assert.equal((await check.check(69)).status,'current');assert.equal(calls.length,1);
 at+=60001;await check.check(68);assert.equal(calls.length,2);assert.deepEqual(new Set(calls),new Set([SNAPSHOT_UPDATE_ENDPOINTS[0]]));
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
  assert.deepEqual(await check.check(68),{generation:68,status:'current'});
  assert.deepEqual(calls,[...SNAPSHOT_UPDATE_ENDPOINTS]);
 }
});
test('static fallback is bounded, and failures also have a cooldown',async()=>{
 let calls=0;const check=createSnapshotUpdateCheck({fetchImpl:async url=>{calls++;if(url===SNAPSHOT_UPDATE_ENDPOINTS[0])throw Error('blocked');return response({currentdir:'public-snapshots68'});}});
 assert.equal((await check.check(69)).status,'stale');assert.equal(calls,2);await check.check(69);assert.equal(calls,2);
 const failing=createSnapshotUpdateCheck({fetchImpl:async()=>{calls++;return response({snapshotDirectory:'https://evil.test/'});}});
 assert.equal((await failing.check(68)).status,'unavailable');await failing.check(68);assert.equal(calls,4);
});
test('invalid, redirected, and oversized responses cannot offer a reload',async()=>{
 for(const value of [{snapshotDirectory:'public-snapshots0'}, {snapshotDirectory:'public-snapshots68/../69'}, {snapshotDirectory:'public-snapshots9999999999'}, {snapshotDirectory:'public-snapshots69',padding:'x'.repeat(17000)}]){
  const check=createSnapshotUpdateCheck({fetchImpl:async()=>response(value)});assert.equal((await check.check(68)).status,'unavailable');
 }
 let calls=0;const check=createSnapshotUpdateCheck({fetchImpl:async()=>{calls++;throw Error('unexpected');}});assert.equal((await check.check(null)).status,'unavailable');assert.equal(calls,0);
});
