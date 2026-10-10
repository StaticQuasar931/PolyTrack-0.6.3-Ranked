import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
import {encodeSnapshot} from './snapshot-package.mjs';
import {createHash} from 'node:crypto';

async function packedFixture(value,logical='overall.json',change=()=>{}){
  const bytes=await encodeSnapshot(value),hash=createHash('sha256').update(bytes).digest('hex');
  const record={path:hash+'.bin',sha256:hash,decodedBytes:Buffer.byteLength(JSON.stringify(value))};
  change(record);let calls=0;const urls=[];
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/public-snapshots1/',fetchImpl:async url=>{
    calls++;urls.push(String(url));return String(url).endsWith('index.json')?Response.json({schemaVersion:1,encoding:'gzip-xor-a7-v1',files:{[logical]:record}}):new Response(bytes);
  }});
  return {read,calls:()=>calls,urls};
}

async function packedEntry(value){
  const bytes=await encodeSnapshot(value),hash=createHash('sha256').update(bytes).digest('hex');
  return {bytes,record:{path:hash+'.bin',sha256:hash,decodedBytes:Buffer.byteLength(JSON.stringify(value))}};
}
const packedIndex=record=>Response.json({schemaVersion:1,encoding:'gzip-xor-a7-v1',files:{'overall.json':record}});

test('packed snapshots verify checksums, decompress and reuse immutable data',async()=>{
  const fixture=await packedFixture({updatedAt:1,entries:[]});
  assert.equal((await fixture.read('overall'))._dataSource,'snapshot');
  assert.equal((await fixture.read('overall'))._dataSource,'cached');
  assert.equal(fixture.calls(),2);
  assert.equal(fixture.urls.some(url=>url.endsWith('/snapshot-current.json')),false);
  assert.equal(await fixture.read('profile','a'.repeat(64)),null);
  assert.equal(fixture.calls(),2);
});

test('packed index 404 recovers once through the same-origin current pointer',async()=>{
  const value={updatedAt:8,entries:[]},entry=await packedEntry(value),requests=[];
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/app/public-snapshots7/',fetchImpl:async(url,options)=>{
    const target=new URL(url);requests.push({url:target.href,options});
    if(target.pathname.endsWith('/public-snapshots7/index.json'))return new Response('',{status:404});
    if(target.pathname==='/app/snapshot-current.json')return Response.json({currentdir:'public-snapshots8'});
    if(target.pathname==='/app/public-snapshots8/index.json')return packedIndex(entry.record);
    if(target.pathname==='/app/public-snapshots8/'+entry.record.path)return new Response(entry.bytes);
    return new Response('',{status:404});
  }});
  assert.equal((await read('overall')).updatedAt,8);
  assert.deepEqual(requests.map(row=>new URL(row.url).pathname),[
    '/app/public-snapshots7/index.json','/app/snapshot-current.json',
    '/app/public-snapshots8/index.json','/app/public-snapshots8/'+entry.record.path]);
  assert.equal(requests[1].options.cache,'no-store');
  assert.equal(requests[1].options.credentials,'omit');
});

test('packed payload 404 recovers and retries the logical file through the new index',async()=>{
  const oldEntry=await packedEntry({updatedAt:7,entries:[]}),newEntry=await packedEntry({updatedAt:8,entries:[]}),requests=[];
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/app/public-snapshots7/',fetchImpl:async url=>{
    const target=new URL(url);requests.push(target.href);
    if(target.pathname==='/app/public-snapshots7/index.json')return packedIndex(oldEntry.record);
    if(target.pathname==='/app/public-snapshots7/'+oldEntry.record.path)return new Response('',{status:410});
    if(target.pathname==='/app/snapshot-current.json')return Response.json({currentdir:'public-snapshots8'});
    if(target.pathname==='/app/public-snapshots8/index.json')return packedIndex(newEntry.record);
    if(target.pathname==='/app/public-snapshots8/'+newEntry.record.path)return new Response(newEntry.bytes);
    return new Response('',{status:404});
  }});
  assert.equal((await read('overall')).updatedAt,8);
  assert.ok(requests.includes('https://example.test/app/public-snapshots8/'+newEntry.record.path));
  assert.equal(requests.filter(url=>url.endsWith('/snapshot-current.json')).length,1);
});

test('a settled recovery is not reused to duplicate later missing payload requests',async()=>{
  const overall=await packedEntry({updatedAt:8,entries:[]}),totals=await packedEntry({updatedAt:9,entries:[]}),requests=[];
  const index=Response.json({schemaVersion:1,encoding:'gzip-xor-a7-v1',files:{
    'overall.json':overall.record,'event-totals.json':totals.record}});
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/app/public-snapshots7/',fetchImpl:async url=>{
    const target=new URL(url);requests.push(target.href);
    if(target.pathname==='/app/public-snapshots7/index.json')return new Response('',{status:404});
    if(target.pathname==='/app/snapshot-current.json')return Response.json({currentdir:'public-snapshots8'});
    if(target.pathname==='/app/public-snapshots8/index.json')return index.clone();
    if(target.pathname==='/app/public-snapshots8/'+overall.record.path||target.pathname==='/app/public-snapshots8/'+totals.record.path)
      return new Response('',{status:404});
    return new Response('',{status:404});
  }});
  assert.equal(await read('overall'),null);
  assert.equal(await read('event-totals'),null);
  assert.equal(requests.filter(url=>url.endsWith('/snapshot-current.json')).length,1);
  assert.equal(requests.filter(url=>url==='https://example.test/app/public-snapshots8/index.json').length,1);
  assert.equal(requests.filter(url=>url.endsWith('/'+overall.record.path)).length,1);
  assert.equal(requests.filter(url=>url.endsWith('/'+totals.record.path)).length,1);
});

test('concurrent logical reads recover together and return data from the current generation',async()=>{
  const oldOverall=await packedEntry({updatedAt:7,entries:[]}),oldTotals=await packedEntry({updatedAt:7,entries:[]});
  const currentOverall=await packedEntry({updatedAt:8,entries:[]}),currentTotals=await packedEntry({updatedAt:9,entries:[]});
  const oldIndex=Response.json({schemaVersion:1,encoding:'gzip-xor-a7-v1',files:{
    'overall.json':oldOverall.record,'event-totals.json':oldTotals.record}});
  const currentIndex=Response.json({schemaVersion:1,encoding:'gzip-xor-a7-v1',files:{
    'overall.json':currentOverall.record,'event-totals.json':currentTotals.record}});
  let oldPayloadCount=0,resolveBothOldPayloads,resolvePointerRequested;
  const bothOldPayloads=new Promise(resolve=>{resolveBothOldPayloads=resolve;});
  const pointerRequested=new Promise(resolve=>{resolvePointerRequested=resolve;});
  const requests=[];
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/app/public-snapshots7/',fetchImpl:async url=>{
    const target=new URL(url);requests.push(target.href);
    if(target.pathname==='/app/public-snapshots7/index.json')return oldIndex.clone();
    if(target.pathname==='/app/public-snapshots7/'+oldOverall.record.path||target.pathname==='/app/public-snapshots7/'+oldTotals.record.path){
      oldPayloadCount++;if(oldPayloadCount===2)resolveBothOldPayloads();
      if(target.pathname.endsWith('/'+oldOverall.record.path))await bothOldPayloads;
      else await pointerRequested;
      return new Response('',{status:404});
    }
    if(target.pathname==='/app/snapshot-current.json'){
      const response=Response.json({currentdir:'public-snapshots8'});resolvePointerRequested();return response;
    }
    if(target.pathname==='/app/public-snapshots8/index.json')return currentIndex.clone();
    if(target.pathname==='/app/public-snapshots8/'+currentOverall.record.path)return new Response(currentOverall.bytes);
    if(target.pathname==='/app/public-snapshots8/'+currentTotals.record.path)return new Response(currentTotals.bytes);
    return new Response('',{status:404});
  }});
  const [overall,totals]=await Promise.all([read('overall'),read('event-totals')]);
  assert.equal(overall.updatedAt,8);assert.equal(totals.updatedAt,9);
  assert.equal(requests.filter(url=>url==='https://example.test/app/public-snapshots7/index.json').length,1);
  assert.equal(requests.filter(url=>url.endsWith('/snapshot-current.json')).length,1);
  assert.equal(requests.filter(url=>url==='https://example.test/app/public-snapshots8/index.json').length,1);
});

test('invalid or cross-origin current pointers fail safely without polling',async()=>{
  for(const pointerBody of ['{invalid json','{"currentdir":"https://evil.test/public-snapshots9"}',
    '{"currentdir":"../public-snapshots9"}']){
    const requests=[];
    const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/app/public-snapshots7/',fetchImpl:async url=>{
      const target=new URL(url);requests.push(target.href);
      if(target.pathname==='/app/public-snapshots7/index.json')return new Response('',{status:404});
      if(target.pathname==='/app/snapshot-current.json')return new Response(pointerBody,{headers:{'content-type':'application/json'}});
      return new Response('',{status:404});
    }});
    assert.equal(await read('overall'),null);
    assert.equal(await read('overall'),null);
    assert.equal(requests.filter(url=>url.endsWith('/snapshot-current.json')).length,1);
    assert.equal(requests.some(url=>url.startsWith('https://evil.test/')),false);
  }
});

test('recent boards stay cached while old boards are evicted at the entry limit',async()=>{
  let calls=0;
  const id=n=>n.toString(16).padStart(64,'0');
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/',fetchImpl:async url=>{
    calls++;return Response.json({updatedAt:1,trackId:String(url).split('/').pop().replace('.json',''),entries:[]});
  }});
  for(let i=1;i<=128;i++)await read('track',id(i));
  await read('track',id(1));await read('track',id(129));
  assert.equal(calls,129);await read('track',id(1));assert.equal(calls,129);
  await read('track',id(2));assert.equal(calls,130);
});

test('large replay cache releases old decoded payloads at its memory budget',async()=>{
  let calls=0;
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/',fetchImpl:async()=>{
    calls++;return Response.json({updatedAt:1,frames:10,recording:'x'.repeat(810000)});
  }});
  for(let i=1;i<=6;i++)await read('recording',String(i));
  assert.equal(calls,6);await read('recording','1');assert.equal(calls,7);
});
test('snapshot capture metadata is bundled, shared, and never fetched from Firebase',async()=>{
  const fixture=await packedFixture({capturedAt:'2026-10-07T00:17:20.349Z'},'public-export-summary.json');
  assert.equal((await fixture.read('snapshot-meta')).capturedAt,'2026-10-07T00:17:20.349Z');
  await fixture.read('snapshot-meta');assert.equal(fixture.calls(),2);
});

test('packed cosmetic directory loads public designs and rejects invalid identities',async()=>{
  const id='a'.repeat(64),fixture=await packedFixture({updatedAt:1,entries:{[id]:{at:1,value:{theme:'crimson',emblem2:'flag'}}}},'cosmetic-directory.json');
  assert.equal((await fixture.read('cosmetic-directory')).entries[id].value.emblem2,'flag');
  const bad=await packedFixture({updatedAt:1,entries:{private:{value:{theme:'classic'}}}},'cosmetic-directory.json');
  assert.equal(await bad.read('cosmetic-directory'),null);
});

test('packed snapshots reject bad checksums, traversal and dishonest decompressed length',async()=>{
  for(const change of [r=>r.sha256='0'.repeat(64),r=>r.path='../private.bin',r=>r.decodedBytes=1]){
    const fixture=await packedFixture({updatedAt:1,entries:[]},'overall.json',change);
    assert.equal(await fixture.read('overall'),null);
  }
});

test('packed public profiles and recordings enforce identity and payload shape',async()=>{
  const id='a'.repeat(64),profile=await packedFixture({updatedAt:1,accountId:id,name:'Racer'},`profiles/${id}.json`);
  assert.equal((await profile.read('profile',id)).name,'Racer');
  const replay=await packedFixture({updatedAt:1,recording:'encoded',frames:123},'recordings/123.json');
  assert.equal((await replay.read('recording','123')).recording,'encoded');
  assert.equal(await replay.read('recording','-1'),null);
});

test('archive months are identity checked and use shared same-origin cache',async()=>{
  let calls=0;
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots/',fetchImpl:async()=>{
    calls++;return Response.json({updatedAt:1,periods:[{id:'d_test',startsAt:Date.UTC(2026,9,1)}]});
  }});
  assert.equal(await read('archive-month','../private'),null);
  assert.equal((await read('archive-month','2026-10')).periods.length,1);
  await read('archive-month','2026-10');assert.equal(calls,1);
  assert.equal(await read('archive-month','2026-09'),null);
});

test('event backups cannot substitute a different event identity',async()=>{
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/',fetchImpl:async()=>Response.json({updatedAt:1,id:'wrong'})});
  assert.equal(await read('event','d_test'),null);
});
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
