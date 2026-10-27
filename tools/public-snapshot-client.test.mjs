import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
import {encodeSnapshot} from './snapshot-package.mjs';
import {createHash} from 'node:crypto';
test('packed public racer directory is cached and rejects private fields',async()=>{
  const id='a'.repeat(64);
  const fixture=await packedFixture({updatedAt:10,entries:{[id]:{updatedAt:10,name:'Racer',carColors:'fff'}}},'racer-directory.json');
  assert.equal((await fixture.read('racer-directory')).entries[id].name,'Racer');
  assert.equal((await fixture.read('racer-directory'))._dataSource,'cached');
  assert.equal(fixture.calls(),2);
  const invalid=await packedFixture({updatedAt:10,entries:{[id]:{updatedAt:10,ownerUid:'private'}}},'racer-directory.json');
  assert.equal(await invalid.read('racer-directory'),null);
});

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


function deferred(){
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}

async function generationFixture(oldFiles,currentFiles,{intercept,onGenerationChange}={}){
  const packages=new Map();
  for(const [generation,files] of [[7,oldFiles],[8,currentFiles]]){
    const entries=new Map();
    for(const [logical,value] of Object.entries(files))entries.set(logical,await packedEntry(value));
    packages.set(generation,entries);
  }
  const requests=[];
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/app/public-snapshots7/',now:()=>0,onGenerationChange,fetchImpl:async url=>{
    const path=new URL(url).pathname;requests.push(path);
    if(path==='/app/snapshot-current.json')return Response.json({currentdir:'public-snapshots8'});
    for(const [generation,entries] of packages){
      const base=`/app/public-snapshots${generation}/`;
      if(path===base+'index.json')return Response.json({schemaVersion:1,encoding:'gzip-xor-a7-v1',files:Object.fromEntries([...entries].map(([logical,entry])=>[logical,entry.record]))});
      for(const [logical,entry] of entries){
        if(path!==base+entry.record.path)continue;
        const response=await intercept?.({generation,logical,entry});
        return response??new Response(entry.bytes);
      }
    }
    throw Error('Unexpected fixture asset '+path);
  }});
  return {read,requests,count:(generation,logical)=>requests.filter(path=>path===`/app/public-snapshots${generation}/`+packages.get(generation).get(logical).record.path).length};
}

test('generation recovery invalidates warm boards, profiles, capture metadata and manifest together',async()=>{
  const id='a'.repeat(64),track=`tracks/${id}.json`,profile=`profiles/${id}.json`;
  const files=generation=>({
    'overall.json':{updatedAt:generation,entries:[]},
    [profile]:{updatedAt:generation,accountId:id,name:`Racer ${generation}`},
    'public-export-summary.json':{capturedAt:`2026-10-0${generation}T00:00:00.000Z`},
    'manifest.json':{schemaVersion:1,tracks:{[id]:{path:track,updatedAt:generation,checkedAt:generation*1000}}},
    [track]:{updatedAt:generation,trackId:id,entries:[]}
  });
  const changes=[];let warmedMetadata;
  const fixture=await generationFixture(files(7),files(8),{
    intercept:({generation,logical})=>generation===7&&logical===track?new Response('',{status:410}):undefined,
    onGenerationChange:change=>{changes.push(change);warmedMetadata=fixture.read('snapshot-meta');return warmedMetadata;}
  });
  const {read}=fixture;
  assert.equal((await read('overall')).updatedAt,7);
  assert.equal((await read('profile',id)).name,'Racer 7');
  assert.equal((await read('snapshot-meta')).capturedAt,files(7)['public-export-summary.json'].capturedAt);
  assert.equal((await read('manifest')).tracks[id].checkedAt,7000);
  const board=await read('track',id);
  assert.equal(board.updatedAt,8);assert.equal(board._snapshotCapturedAt,8000);
  assert.equal((await read('overall')).updatedAt,8);
  assert.equal((await read('profile',id)).name,'Racer 8');
  assert.equal((await read('manifest')).tracks[id].checkedAt,8000);
  assert.equal((await warmedMetadata).capturedAt,files(8)['public-export-summary.json'].capturedAt);
  assert.equal((await read('snapshot-meta')).capturedAt,files(8)['public-export-summary.json'].capturedAt);
  assert.equal(fixture.count(8,'public-export-summary.json'),1,'callback reads join the new generation cache');
  assert.deepEqual(changes,[{previousBaseUrl:'https://example.test/app/public-snapshots7/',baseUrl:'https://example.test/app/public-snapshots8/',generation:1}]);
  assert.equal(fixture.requests.filter(path=>path.endsWith('/snapshot-current.json')).length,1);
});

test('late old payload bodies cannot return or overwrite cached current data',{timeout:5000},async()=>{
  const oldStarted=deferred(),releaseOld=deferred();
  const files=generation=>({'overall.json':{updatedAt:generation,entries:[]},'event-totals.json':{updatedAt:generation+10,entries:[]}});
  const fixture=await generationFixture(files(7),files(8),{intercept:({generation,logical,entry})=>{
    if(generation!==7)return;
    if(logical==='event-totals.json')return new Response('',{status:410});
    return {ok:true,arrayBuffer:async()=>{oldStarted.resolve();await releaseOld.promise;return Uint8Array.from(entry.bytes).buffer;}};
  }});
  const oldRead=fixture.read('overall');await oldStarted.promise;
  assert.equal((await fixture.read('event-totals')).updatedAt,18);
  assert.equal((await fixture.read('overall')).updatedAt,8);
  releaseOld.resolve();
  assert.equal((await oldRead).updatedAt,8,'the waiting caller must not receive its retired reply');
  assert.equal((await fixture.read('overall')).updatedAt,8,'the retired reply must not repopulate saved data');
  assert.equal(fixture.count(8,'overall.json'),1);
});

test('late old failure rejoins new pending reads without deleting them or poisoning their cooldown',{timeout:5000},async()=>{
  const oldStarted=deferred(),releaseOld=deferred(),newStarted=deferred(),releaseNew=deferred();
  const files=generation=>({'overall.json':{updatedAt:generation,entries:[]},'event-totals.json':{updatedAt:generation+10,entries:[]}});
  const fixture=await generationFixture(files(7),files(8),{intercept:async({generation,logical})=>{
    if(generation===7&&logical==='event-totals.json')return new Response('',{status:410});
    if(logical==='overall.json'){
      if(generation===7){oldStarted.resolve();await releaseOld.promise;throw new TypeError('Retired network failure');}
      newStarted.resolve();await releaseNew.promise;
    }
  }});
  const oldRead=fixture.read('overall');await oldStarted.promise;
  await fixture.read('event-totals');
  const currentRead=fixture.read('overall');await newStarted.promise;
  releaseOld.resolve();await new Promise(resolve=>setImmediate(resolve));
  const anotherRead=fixture.read('overall');
  releaseNew.resolve();
  for(const value of await Promise.all([oldRead,currentRead,anotherRead]))assert.equal(value.updatedAt,8);
  assert.equal(fixture.count(8,'overall.json'),1,'retired cleanup cannot delete the new pending request');
  assert.equal((await fixture.read('overall')).updatedAt,8);
});

test('recovery resets both missing-logical and failed-payload negative caches immediately',async()=>{
  const id='b'.repeat(64),profile=`profiles/${id}.json`;
  const oldFiles={'overall.json':{updatedAt:7,entries:[]},'event-totals.json':{updatedAt:17,entries:[]}};
  const currentFiles={'overall.json':{updatedAt:8,entries:[]},'event-totals.json':{updatedAt:18,entries:[]},[profile]:{updatedAt:8,accountId:id,name:'New racer'}};
  const fixture=await generationFixture(oldFiles,currentFiles,{intercept:({generation,logical})=>{
    if(generation===7)return new Response('',{status:logical==='overall.json'?503:410});
  }});
  assert.equal(await fixture.read('profile',id),null);
  assert.equal(await fixture.read('overall'),null);
  assert.equal(await fixture.read('overall'),null);assert.equal(fixture.count(7,'overall.json'),1);
  assert.equal((await fixture.read('event-totals')).updatedAt,18);
  assert.equal((await fixture.read('profile',id)).name,'New racer');
  assert.equal((await fixture.read('overall')).updatedAt,8,'no clock advance is needed after a generation switch');
});

test('manifest-triggered recovery keeps board and capture metadata in the same generation',{timeout:5000},async()=>{
  const id='c'.repeat(64),track=`tracks/${id}.json`,manifestStarted=deferred(),releaseManifest=deferred();
  const files=generation=>({'manifest.json':{schemaVersion:1,tracks:{[id]:{path:track,updatedAt:generation,checkedAt:generation*1000}}},[track]:{updatedAt:generation,trackId:id,entries:[]}});
  const fixture=await generationFixture(files(7),files(8),{intercept:async({generation,logical})=>{
    if(generation===7&&logical==='manifest.json'){manifestStarted.resolve();await releaseManifest.promise;return new Response('',{status:410});}
  }});
  const boardRead=fixture.read('track',id);await manifestStarted.promise;
  releaseManifest.resolve();
  const board=await boardRead;
  assert.equal(board.updatedAt,8);assert.equal(board._snapshotCapturedAt,8000);
  assert.equal((await fixture.read('track',id)).updatedAt,8);
  assert.equal(fixture.count(8,track),1);assert.equal(fixture.count(8,'manifest.json'),1);
});

test('a late retired manifest cannot overwrite current capture metadata',{timeout:5000},async()=>{
  const id='d'.repeat(64),track=`tracks/${id}.json`,oldStarted=deferred(),releaseOld=deferred();
  const files=generation=>({
    'manifest.json':{schemaVersion:1,tracks:{[id]:{path:track,updatedAt:generation,checkedAt:generation*1000}}},
    [track]:{updatedAt:generation,trackId:id,entries:[]},
    'event-totals.json':{updatedAt:generation,entries:[]}
  });
  const fixture=await generationFixture(files(7),files(8),{intercept:async({generation,logical})=>{
    if(generation===7&&logical==='manifest.json'){oldStarted.resolve();await releaseOld.promise;}
    if(generation===7&&logical==='event-totals.json')return new Response('',{status:410});
  }});
  const oldManifest=fixture.read('manifest');await oldStarted.promise;
  await fixture.read('event-totals');
  const currentBoard=await fixture.read('track',id);
  assert.equal(currentBoard.updatedAt,8);assert.equal(currentBoard._snapshotCapturedAt,8000);
  releaseOld.resolve();
  assert.equal((await oldManifest).tracks[id].checkedAt,8000);
  assert.equal((await fixture.read('manifest')).tracks[id].checkedAt,8000);
  assert.equal(fixture.count(8,'manifest.json'),1);
});

test('a retired successful reply is not a fallback when the new generation is unavailable',{timeout:5000},async()=>{
  const oldStarted=deferred(),releaseOld=deferred();
  const files=generation=>({'overall.json':{updatedAt:generation,entries:[]},'event-totals.json':{updatedAt:generation+10,entries:[]}});
  const fixture=await generationFixture(files(7),files(8),{intercept:async({generation,logical})=>{
    if(generation===7&&logical==='event-totals.json')return new Response('',{status:410});
    if(logical==='overall.json'){
      if(generation===7){oldStarted.resolve();await releaseOld.promise;}
      else return new Response('',{status:503});
    }
  }});
  const oldRead=fixture.read('overall');await oldStarted.promise;
  await fixture.read('event-totals');
  assert.equal(await fixture.read('overall'),null);
  releaseOld.resolve();
  assert.equal(await oldRead,null);assert.equal(await fixture.read('overall'),null);
  assert.equal(fixture.count(8,'overall.json'),1,'late old success must respect the current cooldown');
});

test('generation notification errors cannot break recovery',async()=>{
  for(const onGenerationChange of [()=>{throw Error('Synchronous observer failure');},()=>Promise.reject(Error('Asynchronous observer failure'))]){
    const fixture=await generationFixture({'overall.json':{updatedAt:7,entries:[]}},{'overall.json':{updatedAt:8,entries:[]}},{
      onGenerationChange,intercept:({generation})=>generation===7?new Response('',{status:410}):undefined
    });
    assert.equal((await fixture.read('overall')).updatedAt,8);
  }
});

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
    if(new URL(url).pathname.endsWith('/manifest.json')){calls++;return Response.json({schemaVersion:1,tracks:{}});}
    calls++;return Response.json({updatedAt:1,trackId:String(url).split('/').pop().replace('.json',''),entries:[]});
  }});
  for(let i=1;i<=128;i++)await read('track',id(i));
  await read('track',id(1));await read('track',id(129));
  assert.equal(calls,130);await read('track',id(1));assert.equal(calls,130);
  await read('track',id(2));assert.equal(calls,131);
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

test('track statistics load through the compact static route and reject malformed totals',async()=>{
  const id='a'.repeat(64),stats={schemaVersion:1,complete:false,tracksKnown:1,tracksPresent:1,capturedAt:null,revision:9,updatedAt:10,
    tracks:{[id]:{count:2,players:null,totalEntries:4,complete:false,weight:0,revision:3,updatedAt:8,capturedAt:null}}};
  const fixture=await packedFixture(stats,'track-statistics.json');
  const loaded=await fixture.read('track-statistics');
  assert.equal(loaded.tracks[id].count,2);
  assert.equal(loaded.tracks[id].players,null);
  assert.equal(loaded.tracks[id].weight,0);
  assert.equal(fixture.calls(),2);
  const invalid=await packedFixture({...stats,tracks:{[id]:{...stats.tracks[id],players:-1}}},'track-statistics.json');
  assert.equal(await invalid.read('track-statistics'),null);
});

test('packed cosmetic directory loads public designs and rejects invalid identities',async()=>{
  const id='a'.repeat(64),fixture=await packedFixture({updatedAt:1,entries:{[id]:{at:1,value:{theme:'crimson',emblem2:'flag'}}}},'cosmetic-directory.json');
  assert.equal((await fixture.read('cosmetic-directory')).entries[id].value.emblem2,'flag');
  const bad=await packedFixture({updatedAt:1,entries:{private:{value:{theme:'classic'}}}},'cosmetic-directory.json');
  assert.equal(await bad.read('cosmetic-directory'),null);
});

test('packed cosmetic directory accepts more than 2000 identities within the file byte limit',async()=>{
  const entries=Object.fromEntries(Array.from({length:2001},(_,index)=>[(index+1).toString(16).padStart(64,'0'),{at:1,value:{theme:'crimson'}}]));
  const fixture=await packedFixture({updatedAt:1,entries},'cosmetic-directory.json');
  assert.equal(Object.keys((await fixture.read('cosmetic-directory')).entries).length,2001);
});

test('track reads expose manifest check times and cache the static manifest once',async()=>{
  const ids=['a','b'].map(char=>char.repeat(64));let manifestReads=0,trackReads=0;
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots/',fetchImpl:async url=>{
    const target=new URL(url);
    if(target.pathname.endsWith('/manifest.json')){manifestReads++;return Response.json({schemaVersion:1,tracks:{[ids[0]]:{path:`tracks/${ids[0]}.json`,updatedAt:50,checkedAt:123},[ids[1]]:{path:`tracks/${ids[1]}.json`,updatedAt:50,checkedAt:456}}});}
    trackReads++;const id=target.pathname.split('/').at(-1).replace('.json','');
    return Response.json({trackId:id,updatedAt:50,entries:[]});
  }});
  assert.equal((await read('track',ids[0]))._snapshotCapturedAt,123);
  assert.equal((await read('track',ids[1]))._snapshotCapturedAt,456);
  assert.equal(manifestReads,1);assert.equal(trackReads,2);
});

test('packed snapshots reject bad checksums, traversal and dishonest decompressed length',async()=>{
  for(const change of [r=>r.sha256='0'.repeat(64),r=>r.path='../private.bin',r=>r.decodedBytes=1]){
    const fixture=await packedFixture({updatedAt:1,entries:[]},'overall.json',change);
    assert.equal(await fixture.read('overall'),null);
  }
});

function ordinalTrackPage(ranks,{offset=0,sourceComplete=true,totalEntries=offset+ranks.length,publishedEntries=totalEntries}={}){
  const trackId='a'.repeat(64),pageNumber=offset/100+1;
  return {kind:'track-page',trackId,pagingVersion:1,schemaVersion:6,updatedAt:4,pageSize:100,
    sourceComplete,totalEntries,totalEntriesExact:true,publishedEntries,ranksExact:true,capturedAt:null,
    complete:sourceComplete&&ranks.length===totalEntries,pageCount:Math.ceil(publishedEntries/100),pageNumber,offset,count:ranks.length,
    bounds:{pageNumber,offset,count:ranks.length,startPosition:offset+1,endPosition:offset+ranks.length,
      minTimeMs:1000,maxTimeMs:1000,firstRank:ranks[0],lastRank:ranks.at(-1)},
    entries:ranks.map(rank=>({accountId:rank.toString(16).padStart(64,'0'),timeMs:1000,rank,globalRank:rank,position:rank}))};
}

test('normal-track reader accepts equal-time ordinal ranks without resetting a later page',async()=>{
  for(const value of [ordinalTrackPage([1,2,3]),ordinalTrackPage([101,102,103],{offset:100})]){
    const read=createPublicSnapshotReader({baseUrl:'https://example.test/',fetchImpl:async()=>Response.json(value)});
    const result=await read('track-page',value.trackId,value.pageNumber);
    assert.ok(result);
    assert.deepEqual(result.entries.map(row=>row.rank),value.entries.map(row=>row.rank));
    assert.deepEqual(result.entries.map(row=>row.globalRank),value.entries.map(row=>row.rank));
  }
  for(const ranks of [[101,101,103],[100,101,102]]){
    const value=ordinalTrackPage(ranks,{offset:100});
    const read=createPublicSnapshotReader({baseUrl:'https://example.test/',fetchImpl:async()=>Response.json(value)});
    assert.equal(await read('track-page',value.trackId,2),null,'complete pages must use full-field ordinal ranks');
  }
});

test('partial exact track ranks need monotonic ordinals, not equal-time competition ties',async()=>{
  for(const ranks of [[77,78,79],[77,80,90],[77,77,79],[77,79,78]]){
    const value=ordinalTrackPage(ranks,{sourceComplete:false,totalEntries:200,publishedEntries:3});
    const read=createPublicSnapshotReader({baseUrl:'https://example.test/',fetchImpl:async()=>Response.json(value)});
    const result=await read('track-page',value.trackId,1);
    if(ranks[0]<ranks[1]&&ranks[1]<ranks[2]){
      assert.ok(result);assert.equal(result.sourceComplete,false);
      assert.deepEqual(result.entries.map(row=>row.rank),ranks);
    }else assert.equal(result,null);
  }
});

test('Event reader retains source competition ties independently of normal-track ordinal policy',async()=>{
  const value={id:'d_test',updatedAt:4,entries:[1,1,3].map((rank,index)=>({accountId:String(index+1),timeMs:index<2?1000:2000,rank}))};
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/',fetchImpl:async()=>Response.json(value)});
  assert.deepEqual((await read('event','d_test')).entries.map(row=>row.rank),[1,1,3]);
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
  let calls=0,manifestReads=0;const id='a'.repeat(64);
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots/',fetchImpl:async url=>{
    calls++;if(new URL(url).pathname.endsWith('/manifest.json')){manifestReads++;return new Response(JSON.stringify({schemaVersion:1,tracks:{[id]:{path:`tracks/${id}.json`,updatedAt:1,checkedAt:123}}}),{headers:{'content-type':'application/json'}});}
    return new Response(JSON.stringify({trackId:id,updatedAt:1,entries:[]}),{headers:{'content-type':'application/json'}});
  }});
  const [a,b]=await Promise.all([read('track',id),read('track',id)]);
  assert.equal(calls,2);assert.equal(manifestReads,1);assert.equal(a,b);assert.equal(a._publicBackup,true);assert.equal(a._snapshotCapturedAt,123);await read('track',id);assert.equal(calls,2);
});
test('missing backup has negative cooldown and invalid identifiers never fetch',async()=>{
  let calls=0;const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots/',fetchImpl:async()=>{calls++;return new Response('',{status:404});}});
  assert.equal(await read('track','../private'),null);assert.equal(calls,0);
  await read('overall');await read('overall');assert.equal(calls,2); // Board and shared confirmation metadata, once each.
});
test('transient network failures use a short explicit-read cooldown without amplifying concurrent reads',async()=>{
  let now=0,calls=0,release;
  const blocked=new Promise(resolve=>{release=resolve;});
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots/',now:()=>now,fetchImpl:async url=>{
    if(new URL(url).pathname.endsWith('/manifest.json'))return Response.json({schemaVersion:1,tracks:{}});
    calls++;if(calls===1){await blocked;throw new TypeError('network unavailable');}
    return Response.json({updatedAt:2,entries:[]});
  }});
  const first=read('overall'),duplicates=Array.from({length:20},()=>read('overall'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);release();
  const results=await Promise.all([first,...duplicates]);assert.ok(results.every(value=>value===null));
  now=29_999;await read('overall');assert.equal(calls,1);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  now=30_000;
  const recovered=await Promise.all(Array.from({length:20},()=>read('overall')));
  assert.ok(recovered.every(value=>value.updatedAt===2));assert.equal(calls,2);
});

test('timeout failures use the short cooldown and recover on an explicit read',async()=>{
  let now=0,calls=0;
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/',now:()=>now,fetchImpl:async url=>{
    if(new URL(url).pathname.endsWith('/manifest.json'))return Response.json({schemaVersion:1,tracks:{}});
    calls++;if(calls===1)throw Object.assign(new Error('request timed out'),{name:'TimeoutError'});
    return Response.json({updatedAt:5,entries:[]});
  }});
  assert.equal(await read('overall'),null);assert.equal(calls,1);
  now=29_999;assert.equal(await read('overall'),null);assert.equal(calls,1);
  now=30_000;assert.equal((await read('overall')).updatedAt,5);assert.equal(calls,2);
});

test('HTTP 429 and 5xx failures retry only after the short cooldown',async()=>{
  for(const status of [429,503]){
    let now=0,calls=0;
    const read=createPublicSnapshotReader({baseUrl:'https://example.test/',now:()=>now,fetchImpl:async url=>{
      if(new URL(url).pathname.endsWith('/manifest.json'))return Response.json({schemaVersion:1,tracks:{}});
      calls++;return calls===1?new Response('',{status}):Response.json({updatedAt:3,entries:[]});
    }});
    assert.equal(await read('overall'),null);assert.equal(calls,1);
    now=30_000;assert.equal((await read('overall')).updatedAt,3);assert.equal(calls,2);
  }
});

test('packed checksum failure retries once with reload and shares successful recovery',async()=>{
  const entry=await packedEntry({updatedAt:4,entries:[]}),poison=Uint8Array.from(entry.bytes);
  poison[0]^=1;
  const requests=[];let payloadReads=0;
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/public-snapshots1/',fetchImpl:async(url,options)=>{
    const asset=new URL(url).pathname.split('/').at(-1);requests.push({asset,cache:options.cache,credentials:options.credentials});
    if(asset==='index.json')return packedIndex(entry.record);
    assert.equal(asset,entry.record.path);
    return new Response(++payloadReads===1?poison:entry.bytes);
  }});
  const values=await Promise.all(Array.from({length:20},()=>read('overall')));
  assert.ok(values.every(value=>value?.updatedAt===4));
  assert.ok(values.every(value=>value===values[0]),'concurrent callers share the verified result');
  assert.deepEqual(requests,[
    {asset:'index.json',cache:'default',credentials:'omit'},
    {asset:entry.record.path,cache:'force-cache',credentials:'omit'},
    {asset:entry.record.path,cache:'reload',credentials:'omit'}
  ]);
  assert.equal((await read('overall'))._dataSource,'cached');assert.equal(requests.length,3);
});

test('repeated packed checksum poison has bounded reload attempts and a shared short cooldown',async()=>{
  const entry=await packedEntry({updatedAt:4,entries:[]}),poison=Uint8Array.from(entry.bytes);
  poison[0]^=1;
  let now=0,poisoned=true;const requests=[];
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/public-snapshots1/',now:()=>now,fetchImpl:async(url,options)=>{
    const asset=new URL(url).pathname.split('/').at(-1);requests.push({asset,cache:options.cache});
    if(asset==='index.json')return packedIndex(entry.record);
    assert.equal(asset,entry.record.path);
    return new Response(poisoned?poison:entry.bytes);
  }});
  const batch=()=>Promise.all(Array.from({length:20},()=>read('overall')));
  assert.ok((await batch()).every(value=>value===null));
  assert.deepEqual(requests.map(request=>request.cache),['default','force-cache','reload']);
  assert.ok((await batch()).every(value=>value===null));assert.equal(requests.length,3);
  now=29_999;assert.equal(await read('overall'),null);assert.equal(requests.length,3);
  now=30_000;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,3,'no background polling');
  assert.ok((await batch()).every(value=>value===null));
  assert.equal(requests.length,4,'a known poisoned URL receives one explicit retry, not another immediate pair');
  assert.equal(requests.at(-1).cache,'reload');
  now=59_999;assert.equal(await read('overall'),null);assert.equal(requests.length,4);
  poisoned=false;now=60_000;
  assert.ok((await batch()).every(value=>value?.updatedAt===4));
  assert.equal(requests.length,5);assert.equal(requests.at(-1).cache,'reload');
  assert.equal(requests.filter(request=>request.asset==='index.json').length,1);
  assert.equal((await read('overall'))._dataSource,'cached');assert.equal(requests.length,5);
});

test('checksummed structural invalidity is not retried or treated as cache poison',async()=>{
  const id='a'.repeat(64),other='b'.repeat(64);
  const fixtures=[
    {kind:'overall',logical:'overall.json',value:{updatedAt:'invalid',entries:[]}},
    {kind:'profile',id,logical:`profiles/${id}.json`,value:{updatedAt:4,accountId:other}},
    {kind:'racer-directory',logical:'racer-directory.json',value:{updatedAt:4,entries:{[id]:{updatedAt:4,name:'Racer',ownerUid:'private'}}}}
  ];
  for(const fixture of fixtures){
    const entry=await packedEntry(fixture.value);let now=0;const requests=[];
    const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/public-snapshots1/',now:()=>now,fetchImpl:async(url,options)=>{
      const asset=new URL(url).pathname.split('/').at(-1);requests.push({asset,cache:options.cache});
      if(asset==='index.json')return Response.json({schemaVersion:1,encoding:'gzip-xor-a7-v1',files:{[fixture.logical]:entry.record}});
      assert.equal(asset,entry.record.path);return new Response(entry.bytes);
    }});
    const batch=()=>Promise.all(Array.from({length:20},()=>read(fixture.kind,fixture.id)));
    assert.ok((await batch()).every(value=>value===null));
    assert.deepEqual(requests.map(request=>request.cache),['default','force-cache']);
    assert.ok((await batch()).every(value=>value===null));assert.equal(requests.length,2);
    for(const time of [30_000,15*60_000-1]){
      now=time;assert.equal(await read(fixture.kind,fixture.id),null);assert.equal(requests.length,2);
    }
    now=15*60_000;assert.ok((await batch()).every(value=>value===null));
    assert.equal(requests.length,3,'only a later explicit read retries structurally invalid data');
    assert.equal(requests.at(-1).cache,'force-cache','structural rejection must not trigger integrity reloads');
  }
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

test('transient current-pointer failure can recover later without concurrent pointer spam',async()=>{
  const entry=await packedEntry({updatedAt:8,entries:[]});let now=0,pointers=0;
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/public-snapshots7/',now:()=>now,fetchImpl:async url=>{
    const p=new URL(url).pathname;
    if(p==='/public-snapshots7/index.json')return new Response('',{status:404});
    if(p==='/snapshot-current.json'){pointers++;return pointers===1?new Response('',{status:503}):Response.json({currentdir:'public-snapshots8'});}
    if(p==='/public-snapshots8/index.json')return packedIndex(entry.record);
    if(p==='/public-snapshots8/'+entry.record.path)return new Response(entry.bytes);
    throw Error('Unexpected asset '+p);
  }});
  assert.equal(await read('overall'),null);assert.equal(pointers,1);
  for(const kind of ['manifest','event-totals','overall-results'])assert.equal(await read(kind),null);
  assert.equal(pointers,1,'different missing assets share the pointer failure cooldown');
  now=29_999;assert.equal(await read('overall'),null);assert.equal(pointers,1);
  now=30_000;const results=await Promise.all(Array.from({length:20},()=>read('overall')));
  assert.ok(results.every(r=>r.updatedAt===8));assert.equal(pointers,2);
});

test('long-lived readers recover a second retired generation without pointer polling',async()=>{
  const entries=new Map();
  for(const generation of [8,9])entries.set(generation,await packedEntry({updatedAt:generation,entries:[]}));
  let now=0,current=8,pointers=0;const changes=[];
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/app/public-snapshots7/',now:()=>now,
    onGenerationChange:change=>changes.push(change),fetchImpl:async url=>{
      const pathname=new URL(url).pathname;
      if(pathname==='/app/snapshot-current.json'){pointers++;return Response.json({currentdir:`public-snapshots${current}`});}
      const entry=entries.get(current),base=`/app/public-snapshots${current}/`;
      if(pathname===base+'index.json')return Response.json({schemaVersion:1,encoding:'gzip-xor-a7-v1',
        files:{'overall.json':entry.record,'event-totals.json':entry.record}});
      return pathname===base+entry.record.path?new Response(entry.bytes):new Response('',{status:404});
    }});
  assert.equal((await read('overall')).updatedAt,8);
  current=9;
  assert.equal(await read('event-totals'),null);
  assert.equal(pointers,1,'an immediate failure in the replacement does not loop through the pointer');
  now=15*60_000-1;
  assert.equal(await read('event-totals'),null);
  assert.equal(pointers,1);
  now=15*60_000;
  const recovered=await Promise.all(Array.from({length:20},()=>read('event-totals')));
  assert.ok(recovered.every(value=>value?.updatedAt===9));
  assert.equal((await read('overall')).updatedAt,9,'second recovery invalidates the warm earlier generation');
  assert.equal(pointers,2,'concurrent reads share each bounded recovery');
  assert.deepEqual(changes.map(change=>change.generation),[1,2]);
});

test('an unchanged pointer can be checked again after the deployment cooldown',async()=>{
  const entry=await packedEntry({updatedAt:8,entries:[]});let now=0,current=7,pointers=0;
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/public-snapshots7/',now:()=>now,fetchImpl:async url=>{
    const pathname=new URL(url).pathname;
    if(pathname==='/snapshot-current.json'){pointers++;return Response.json({currentdir:`public-snapshots${current}`});}
    if(current===8&&pathname==='/public-snapshots8/index.json')return packedIndex(entry.record);
    if(current===8&&pathname==='/public-snapshots8/'+entry.record.path)return new Response(entry.bytes);
    return new Response('',{status:404});
  }});
  assert.equal(await read('overall'),null);assert.equal(pointers,1);
  current=8;now=30_000;
  assert.equal(await read('overall'),null);assert.equal(pointers,1);
  now=15*60_000;
  assert.equal((await read('overall'))?.updatedAt,8);assert.equal(pointers,2);
});


test('explicit snapshot refresh adopts a newer static generation and coalesces pointer checks',async()=>{
  const f=await generationFixture({'overall.json':{updatedAt:7,entries:[]}}, {'overall.json':{updatedAt:8,entries:[]}});
  assert.equal((await f.read('overall')).updatedAt,7);
  const changed=await Promise.all([f.read.refresh(),f.read.refresh(),f.read.refresh()]);
  assert.ok(changed.every(Boolean));
  assert.equal((await f.read('overall')).updatedAt,8);
  assert.equal(f.requests.filter(path=>path.endsWith('/snapshot-current.json')).length,1);
  assert.equal(await f.read.refresh(),false);
  assert.equal(f.requests.filter(path=>path.endsWith('/snapshot-current.json')).length,1);
});

test('failed explicit pointer refresh retains the usable static generation',async()=>{
  const packed=await packedEntry({updatedAt:7,entries:[]});let calls=0;
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/public-snapshots7/',fetchImpl:async url=>{
    if(String(url).endsWith('snapshot-current.json')){calls++;return new Response('',{status:503});}
    return String(url).endsWith('index.json')?packedIndex(packed.record):new Response(packed.bytes);
  }});
  assert.equal((await read('overall')).updatedAt,7);
  await assert.rejects(read.refresh(),/pointer unavailable/);
  assert.equal((await read('overall')).updatedAt,7);assert.equal(calls,1);
});


test('manual pointer checks use the UI two-minute budget independently of automatic recovery',async()=>{
  let now=0,calls=0;
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/public-snapshots7/',now:()=>now,
    fetchImpl:async url=>{assert.ok(String(url).endsWith('snapshot-current.json'));calls++;return Response.json({currentdir:'public-snapshots7'});}});
  assert.equal(await read.refresh(),false);assert.equal(calls,1);
  now=119999;await read.refresh();assert.equal(calls,1);
  now=120000;await Promise.all([read.refresh(),read.refresh()]);assert.equal(calls,2);
});

for(const failure of ['missing','malformed','redirected'])test('manual '+failure+' pointer is not reported as a successful check',async()=>{
  const packed=await packedEntry({updatedAt:7,entries:[]});let calls=0;
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/public-snapshots7/',fetchImpl:async url=>{
    if(String(url).endsWith('snapshot-current.json')){
      calls++;
      if(failure==='missing')return new Response('',{status:404});
      if(failure==='malformed')return Response.json({currentdir:'../private'});
      const response=Response.json({currentdir:'public-snapshots8'});
      Object.defineProperty(response,'url',{value:'https://other.test/snapshot-current.json'});return response;
    }
    return String(url).endsWith('index.json')?packedIndex(packed.record):new Response(packed.bytes);
  }});
  assert.equal((await read('overall')).updatedAt,7);
  await assert.rejects(read.refresh(),/snapshot pointer/i);
  assert.equal((await read('overall')).updatedAt,7);assert.equal(calls,1);
});

test('manual refresh joining automatic recovery retains the shared failure outcome',async()=>{
  let release,started,pointers=0;const entered=new Promise(resolve=>{started=resolve;});
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/public-snapshots7/',fetchImpl:async url=>{
    if(String(url).endsWith('snapshot-current.json')){pointers++;started();return new Promise(resolve=>{release=resolve;});}
    return new Response('',{status:404});
  }});
  const automatic=read('overall');await entered;
  const manual=read.refresh();const rejected=assert.rejects(manual,/pointer unavailable/);
  release(new Response('',{status:404}));
  assert.equal(await automatic,null);await rejected;assert.equal(pointers,1);
});
