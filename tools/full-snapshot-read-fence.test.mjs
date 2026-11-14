import test from 'node:test';import assert from 'node:assert/strict';import {createFullSnapshotReadFence} from './full-snapshot-read-fence.mjs';
const base='https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents';
test('the fence reserves before transport and forbids all database writes',async()=>{let calls=0;const fence=createFullSnapshotReadFence({fetchImpl:async()=>{calls++;return new Response('[]');}});await fence.fetch(base+':runQuery',{method:'POST',body:JSON.stringify({structuredQuery:{limit:100}})});assert.equal(fence.report().directDocumentReadReservations,100);await assert.rejects(fence.fetch(base+':commit',{method:'POST',body:'{}'}),/forbids/);assert.equal(calls,1);await assert.rejects(fence.fetch(base+':runQuery',{method:'POST',body:'{}'}),/stopped/);});
test('direct bound is fixed and cap exhaustion sends no extra request',async()=>{let calls=0;const fence=createFullSnapshotReadFence({fetchImpl:async()=>{calls++;return new Response('[]');}});for(let i=0;i<400;i++)await fence.fetch(base+':runQuery',{method:'POST',body:'{"structuredQuery":{"limit":100}}'});await assert.rejects(fence.fetch(base+':runQuery',{method:'POST',body:'{"structuredQuery":{"limit":1}}'}),/budget/);assert.equal(calls,400);assert.throws(()=>createFullSnapshotReadFence({maxDirectReservations:50000}));});
test('quota and auth errors latch the whole source transport without retry',async()=>{for(const status of [401,403,429]){let calls=0;const fence=createFullSnapshotReadFence({fetchImpl:async()=>{calls++;return new Response('',{status});}});await fence.fetch('https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/catalog');await assert.rejects(fence.fetch(base+':runQuery',{method:'POST',body:'{"structuredQuery":{"limit":1}}'}),/stopped/);assert.equal(calls,1);}});
test('Worker attempts remain a separate capped component, never billed-read assertions',async()=>{const fence=createFullSnapshotReadFence({fetchImpl:async()=>new Response('ok')});for(let i=0;i<1024;i++)await fence.fetch('https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/catalog');await assert.rejects(fence.fetch('https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/catalog'),/Worker budget/);assert.equal(fence.report().workerRequests,1024);assert.equal(fence.report().directDocumentReadReservations,0);assert.equal(fence.report().documentWrites,0);});

import {boundedFirestoreResponse} from './full-snapshot-read-fence.mjs';
test('Firestore transport is bounded before JSON decoding, even without Content-Length',async()=>{let cancelled=false;const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(3));c.enqueue(new Uint8Array(3));},cancel(){cancelled=true;}});await assert.rejects(boundedFirestoreResponse(new Response(body),{maxBytes:4}),/exceeds/);assert.equal(cancelled,true);const value=await boundedFirestoreResponse(Response.json([{readTime:'synthetic'}]),{maxBytes:128});assert.deepEqual(await value.json(),[{readTime:'synthetic'}]);});
test('declared oversized responses stop before consumption and cannot raise transport cap',async()=>{let cancelled=false;const body=new ReadableStream({cancel(){cancelled=true;}});await assert.rejects(boundedFirestoreResponse(new Response(body,{headers:{'content-length':'500'}}),{maxBytes:4}),/exceeds/);assert.equal(cancelled,true);await assert.rejects(boundedFirestoreResponse(new Response(''),{maxBytes:32*1024*1024}),/limit/);});

test('continuation carries earlier reservations and Worker attempts without renewing budgets',async()=>{
 let calls=0;const f=createFullSnapshotReadFence({fetchImpl:async()=>{calls++;return Response.json([]);},initialDirectReservations:39999,initialWorkerRequests:1024});
 await f.fetch(base+':runQuery',{method:'POST',body:'{"structuredQuery":{"limit":1}}'});assert.equal(f.report().directDocumentReadReservations,40000);assert.equal(f.report().priorDirectReservations,39999);
 await assert.rejects(f.fetch('https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/catalog'),/Worker budget/);assert.equal(calls,1);
});


test('tonight approved ceiling preserves the existing 24536 reservations and every other fence bound',async()=>{
 let calls=0;const f=createFullSnapshotReadFence({initialDirectReservations:24536,fetchImpl:async()=>{calls++;return Response.json([]);}});
 assert.equal(f.report().maxDirectReservations,40000);assert.equal(f.report().directDocumentReadReservations,24536);assert.equal(f.report().maxWorkerRequests,1024);assert.equal(f.report().documentWrites,0);
 await f.fetch(base+':batchGet',{method:'POST',body:JSON.stringify({documents:['synthetic']})});
 assert.equal(f.report().directDocumentReadReservations,24537);assert.equal(f.report().priorDirectReservations,24536);assert.equal(calls,1);
 for(const maxDirectReservations of [25000,35000,39999,40001,50000])assert.throws(()=>createFullSnapshotReadFence({maxDirectReservations}),/Fixed/);
 for(const initialDirectReservations of [-1,40001,NaN])assert.throws(()=>createFullSnapshotReadFence({initialDirectReservations}),/prior capture/);
 await assert.rejects(f.fetch(base+':commit',{method:'POST',body:'{}'}),/forbids/);assert.equal(calls,1);assert.equal(f.report().documentWrites,0);
});
