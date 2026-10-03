import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
test('public backup shares requests and does not refetch on menu refresh',async()=>{
  let calls=0;const id='a'.repeat(64);
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots/',fetchImpl:async()=>{calls++;return new Response(JSON.stringify({trackId:id,updatedAt:1,entries:[]}),{headers:{'content-type':'application/json'}});}});
  const [a,b]=await Promise.all([read('track',id),read('track',id)]);
  assert.equal(calls,1);assert.equal(a,b);assert.equal(a._publicBackup,true);await read('track',id);assert.equal(calls,1);
});
test('missing backup has negative cooldown and invalid identifiers never fetch',async()=>{
  let calls=0;const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots/',fetchImpl:async()=>{calls++;return new Response('',{status:404});}});
  assert.equal(await read('track','../private'),null);assert.equal(calls,0);
  await read('overall');await read('overall');assert.equal(calls,1);
});
test('mismatched track backup is rejected',async()=>{
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots/',fetchImpl:async()=>new Response(JSON.stringify({trackId:'b'.repeat(64),updatedAt:1}),{headers:{'content-type':'application/json'}})});
  assert.equal(await read('track','a'.repeat(64)),null);
});
test('event replay backup must match period and racer and shares repeat loads',async()=>{
  let calls=0;const accountId='a'.repeat(64);
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots/',fetchImpl:async()=>{
    calls++;return new Response(JSON.stringify({periodId:'w_test',accountId,replay:'encoded'}),{headers:{'content-type':'application/json'}});
  }});
  assert.equal(await read('event-replay','../private',accountId),null);
  assert.equal(calls,0);
  assert.equal((await read('event-replay','w_test',accountId)).replay,'encoded');
  await read('event-replay','w_test',accountId);assert.equal(calls,1);
  assert.equal(await read('event-replay','w_other',accountId),null);
  assert.equal(await read('event-replay','w_test','b'.repeat(64)),null);
});
