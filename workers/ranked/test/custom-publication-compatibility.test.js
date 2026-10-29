import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../src/index.js';
import {eventEncode,eventDecode} from '../src/events-store.js';
import {sourceCatalogIsReady} from '../src/overall-source-cache.js';

const origin='https://custom-audit.invalid';
const allow={limit:async()=>({success:true})};
function offline(t) {
  t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));
  t.mock.method(console,'log',()=>{});
  const previous=globalThis.caches;delete globalThis.caches;
  t.after(()=>{if(previous===undefined)delete globalThis.caches;else globalThis.caches=previous;});
}

test('custom PB notification publishes and registers an arbitrary custom track, then serves its public board',async t=>{
  offline(t);
  const trackId='future_custom_track',accountId='custom-racer',resultId=accountId+'_'+trackId;
  const trackPath='0.6.2_s1_leaderboards_track/'+trackId,metaPath='0.6.2_s1_release_meta/current';
  const row={accountId,trackId,ownerUid:'owner',timeMs:1000,raceTimeFrames:1000,replay:'structural-replay',
    replayHash:'a'.repeat(64),uploadId:1,nickname:'Custom Racer'};
  const db=new Map([
    ['0.6.2_race_results/'+resultId,row],
    [trackPath,{entries:[],revision:1,sourceRevision:1,complete:true,totalEntries:0,
      signature:'empty',schemaVersion:6,algorithmVersion:'participation-v8-s1'}],
    [metaPath,{revision:1,sourceCatalog:{version:1,complete:true,scannedAt:Date.now(),count:0,tracks:{}}}]
  ]);
  let reads=0;const writes=[];
  const env={ALLOWED_ORIGINS:origin,__TEST_UID:'owner',WRITE_IP_RATE_LIMITER:allow,
    PB_NOTIFY_RATE_LIMITER:allow,PUBLIC_READ_RATE_LIMITER:allow,__TEST_FIRESTORE:async(path,init={})=>{
      if(path===':commit') {
        const batch=JSON.parse(init.body).writes;
        for(const write of batch) {
          const key=write.update.name.split('/documents/')[1];writes.push(key);
          assert.deepEqual(write.currentDocument,db.has(key)?{updateTime:'2026-10-01T00:00:00Z'}:{exists:false});
          db.set(key,eventDecode({mapValue:{fields:write.update.fields}}));
        }
        return {writeResults:batch.map(()=>({updateTime:'2026-10-01T00:00:00Z'}))};
      }
      assert.notEqual(path,':runQuery','a current custom board must not trigger a historical crawl');
      reads++;const data=db.get(path.slice(1));
      return data?{fields:eventEncode(data).mapValue.fields,updateTime:'2026-10-01T00:00:00Z'}:null;
    }};
  const response=await handleRequest(new Request(origin+'/v1/pb/notify',{method:'POST',
    headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify({resultId})}),env);
  assert.equal(response.status,200);assert.equal((await response.json()).changed,true);
  assert.ok(writes.includes(trackPath));assert.ok(writes.includes(metaPath));
  assert.equal(db.get(trackPath).entries[0].accountId,accountId);
  assert.equal(db.get(trackPath).entries[0].runVerified,false,'notification does not execute or grant native verification');
  assert.equal(sourceCatalogIsReady(db.get(metaPath).sourceCatalog),true);
  assert.ok(Object.hasOwn(db.get(metaPath).sourceCatalog.tracks,trackId),'guarded publication registers custom membership');
  const before=reads;
  for(let i=0;i<2;i++) {
    const board=await handleRequest(new Request(origin+'/v1/snapshot/track?trackId='+trackId,
      {headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'}}),env);
    assert.equal(board.status,200);assert.equal((await board.json()).entries[0].accountId,accountId);
  }
  assert.equal(reads-before,1,'known custom boards remain readable and cacheable');
});

test('document residual: invented generation/page combinations still cost one manifest read each',async t=>{
  offline(t);let reads=0;
  const env={ALLOWED_ORIGINS:origin,PUBLIC_READ_RATE_LIMITER:allow,__TEST_FIRESTORE:async(path,init={})=>{
    assert.equal(init.method,undefined);assert.ok(path.startsWith('/0.6.2_s1_public_manifests/'));reads++;return null;
  }};
  for(const kind of ['track','overall'])for(let i=0;i<3;i++) {
    const url=origin+'/v1/snapshot/'+kind+'/page?generation='+String(i+1).repeat(64)+'&page='+i+'&trackId=future_custom_track';
    const response=await handleRequest(new Request(url,{headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'}}),env);
    assert.equal(response.status,404);
  }
  assert.equal(reads,6,'this patch does not claim to eliminate rotating page cold-read abuse');
});
