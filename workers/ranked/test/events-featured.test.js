import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {eventWorkerHandler,eventWorkerMaintenance} from '../src/events-worker.js';
import {EVENT_COLLECTIONS as C} from '../src/events.js';
import {eventEncode,eventDecode} from '../src/events-store.js';
import {utcEventCandidates} from '../src/events-runtime.js';
import {KODUB_METADATA_URL} from '../src/kodub-event.js';
import {PERMANENT_ROLLING_HILLS as R,derivePermanentRollingHills} from '../src/permanent-rolling-hills.js';
const rolling='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
const official='a'.repeat(64), at=Date.parse('2026-09-14T00:00:00Z');
const capacity={policyVersion:'test',entrants:200,admissionsPerPeriod:2048,replayBytesPerPeriod:16777216,minIntervalMs:5000,verificationsPerDay:1536};
test('public event catalog cache reuses Firestore data after ingress checks',async()=>{
  const prior=globalThis.caches,stored=new Map(),pending=[];
  let catalogReads=0,rateChecks=0;
  globalThis.caches={default:{match:async key=>stored.get(key.url)?.clone()||null,
    put:async(key,response)=>{stored.set(key.url,response.clone());}}};
  try{
    const handler=eventWorkerHandler({EVENTS_ENABLED:'true',FIREBASE_PROJECT_ID:'polytrack-052',
      EVENT_RATE_LIMITER:{limit:async()=>{rateChecks++;return {success:true};}}},{
      request:async(path)=>{if(path===':beginTransaction')return {transaction:'fixture'};
        if(path===':commit')return {};
        if(path.includes('event_catalog'))catalogReads++;
        return null;},authenticate:async()=>({uid:'unused'}),origins:new Set(['https://staticquasar931.github.io']),
      context:{waitUntil:promise=>pending.push(promise)}});
    for(const suffix of ['?ignored=one','?ignored=two']){
      const response=await handler(new Request('https://ranked.example/v1/events/catalog'+suffix,
        {headers:{Origin:'https://staticquasar931.github.io','CF-Connecting-IP':'192.0.2.1'}}));
      assert.equal(response.status,200);
      await Promise.all(pending.splice(0));
    }
    assert.equal(catalogReads,1);
    assert.equal(rateChecks,1,'the second response is served from cache before IP limiting');
  }finally{if(prior===undefined)delete globalThis.caches;else globalThis.caches=prior;}
});

test('cached anonymous reads bypass the shared-IP limiter, and denied cold fills and submissions stay bounded',async()=>{
  const prior=globalThis.caches,stored=new Map();let eventChecks=0,loads=0;
  globalThis.caches={default:{match:async key=>stored.get(key.url)?.clone()||null,
    put:async(key,response)=>{stored.set(key.url,response.clone());}}};
  const handler=eventWorkerHandler({EVENTS_ENABLED:'true',FIREBASE_PROJECT_ID:'polytrack-052',
    EVENT_RATE_LIMITER:{limit:async()=>{eventChecks++;return {success:false};}}},{
    request:async()=>{loads++;return null;},authenticate:async()=>'owner',origins:new Set(['https://game.test']),
    context:{waitUntil:promise=>promise}});
  const headers={Origin:'https://game.test','CF-Connecting-IP':'192.0.2.1'};
  try{
    const cacheKey='https://ranked.example/__event_public_cache/polytrack-052/catalog';
    stored.set(cacheKey,new Response(JSON.stringify({periods:[]})));
    const cached=await handler(new Request('https://ranked.example/v1/events/catalog',{headers}));
    assert.equal(cached.status,200);assert.equal(eventChecks,0);assert.equal(loads,0);
    const miss=await handler(new Request('https://ranked.example/v1/events/totals',{headers}));
    assert.equal(miss.status,429);assert.equal(eventChecks,1);assert.equal(loads,0);
    const submission=await handler(new Request('https://ranked.example/v1/events/d_test/runs',{
      method:'POST',headers:{...headers,Authorization:'Bearer fixture','Content-Type':'application/json'},body:'{}'}));
    assert.equal(submission.status,429);assert.equal(eventChecks,2);
  }finally{if(prior===undefined)delete globalThis.caches;else globalThis.caches=prior;}
});

test('warm totals and Rolling Hills caches stay distinct when the IP limiter denies misses',async()=>{
  const prior=globalThis.caches,stored=new Map();let limiterChecks=0,firestoreReads=0;
  globalThis.caches={default:{match:async key=>stored.get(key.url)?.clone()||null,
    put:async(key,response)=>{stored.set(key.url,response.clone());}}};
  const finite={entries:[],updatedAt:300,complete:true,totalEntries:0};
  const source={trackId:R.trackId,algorithmVersion:R.algorithmVersion,schemaVersion:R.minimumSchemaVersion,
    revision:7,sourceRevision:7,signature:'valid_snapshot_signature',builtAt:100,updatedAt:200,
    complete:true,totalEntries:1,entries:[{accountId:'racer',trackId:R.trackId,timeMs:10000,frames:10000,
      raceTimeFrames:10000,runVerified:true,integrityVerified:true,replayHash:'a'.repeat(64),pbAt:100,
      name:'racer',carStyle:'style'}]};
  const rolling=derivePermanentRollingHills(source);
  const prefix='https://ranked.example/__event_public_cache/polytrack-052/';
  stored.set(prefix+'totals',Response.json(finite));
  stored.set(prefix+'permanent-rolling-hills',Response.json(rolling));
  try{
    const handler=eventWorkerHandler({EVENTS_ENABLED:'true',FIREBASE_PROJECT_ID:'polytrack-052',
      EVENT_RATE_LIMITER:{limit:async()=>{limiterChecks++;return {success:false};}}},{
      request:async()=>{firestoreReads++;throw Error('warm cache must avoid Firestore');},
      authenticate:async()=>'unused',origins:new Set(['https://game.test'])});
    const response=await handler(new Request('https://ranked.example/v1/events/totals',{
      headers:{Origin:'https://game.test','CF-Connecting-IP':'192.0.2.1'}}));
    const result=await response.json();
    assert.equal(response.status,200);assert.equal(limiterChecks,0);assert.equal(firestoreReads,0);
    assert.equal(result.entries[0].accountId,'racer');
    assert.equal(result.entries[0].permanentRollingHillsRp,rolling.entries[0].rp);
    assert.equal(result.dynamicComponents.permanentRollingHills.status,'complete');
  }finally{if(prior===undefined)delete globalThis.caches;else globalThis.caches=prior;}
});

test('warm totals with a denied Rolling Hills miss return incomplete data without a database read',async()=>{
  const prior=globalThis.caches,stored=new Map();let limiterChecks=0,firestoreReads=0;
  globalThis.caches={default:{match:async key=>stored.get(key.url)?.clone()||null,
    put:async(key,response)=>{stored.set(key.url,response.clone());}}};
  const finite={entries:[],updatedAt:300,complete:true,totalEntries:0};
  stored.set('https://ranked.example/__event_public_cache/polytrack-052/totals',Response.json(finite));
  try{
    const handler=eventWorkerHandler({EVENTS_ENABLED:'true',FIREBASE_PROJECT_ID:'polytrack-052',
      EVENT_RATE_LIMITER:{limit:async()=>{limiterChecks++;return {success:false};}}},{
      request:async()=>{firestoreReads++;throw Error('denied secondary miss must not read Firestore');},
      authenticate:async()=>'unused',origins:new Set(['https://game.test'])});
    const response=await handler(new Request('https://ranked.example/v1/events/totals',{
      headers:{Origin:'https://game.test','CF-Connecting-IP':'192.0.2.1'}}));
    const result=await response.json();
    assert.equal(response.status,200);assert.equal(limiterChecks,1);assert.equal(firestoreReads,0);
    assert.equal(result.eventRpComplete,false);
    assert.equal(result.dynamicComponents.permanentRollingHills.status,'unavailable');
    assert.deepEqual(result.entries,[]);
  }finally{if(prior===undefined)delete globalThis.caches;else globalThis.caches=prior;}
});

test('denied cold Rolling Hills snapshot fill returns retryable 429 without a database read',async()=>{
  const prior=globalThis.caches;let limiterChecks=0,firestoreReads=0;
  globalThis.caches={default:{match:async()=>null,put:async()=>{}}};
  try{
    const handler=eventWorkerHandler({EVENTS_ENABLED:'true',FIREBASE_PROJECT_ID:'polytrack-052',
      EVENT_RATE_LIMITER:{limit:async()=>{limiterChecks++;return {success:false};}}},{
      request:async()=>{firestoreReads++;throw Error('denied cold fill must not read Firestore');},
      authenticate:async()=>'unused',origins:new Set(['https://game.test'])});
    const response=await handler(new Request('https://ranked.example/v1/events/permanent-rolling-hills/snapshot',{
      headers:{Origin:'https://game.test','CF-Connecting-IP':'192.0.2.1'}}));
    assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'60');
    assert.deepEqual(await response.json(),{error:'event_ingress_limit'});
    assert.equal(limiterChecks,1);assert.equal(firestoreReads,0);
  }finally{if(prior===undefined)delete globalThis.caches;else globalThis.caches=prior;}
});

test('concurrent cold catalog requests coalesce origin reads and consume one fill permit',async()=>{
  const prior=globalThis.caches,stored=new Map();let limiterChecks=0,catalogReads=0;
  globalThis.caches={default:{match:async key=>stored.get(key.url)?.clone()||null,
    put:async(key,response)=>{stored.set(key.url,response.clone());}}};
  try{
    const makeHandler=()=>eventWorkerHandler({EVENTS_ENABLED:'true',FIREBASE_PROJECT_ID:'polytrack-052',
      EVENT_RATE_LIMITER:{limit:async()=>{limiterChecks++;await new Promise(resolve=>setTimeout(resolve,5));return {success:true};}}},{
      request:async path=>{if(path===':beginTransaction')return {transaction:'fixture'};
        if(path===':commit')return {};
        if(path.includes('event_catalog')){catalogReads++;await new Promise(resolve=>setTimeout(resolve,5));}
        return null;},authenticate:async()=>'unused',origins:new Set(['https://game.test'])});
    const makeRequest=()=>new Request('https://ranked.example/v1/events/catalog',{
      headers:{Origin:'https://game.test','CF-Connecting-IP':'192.0.2.1'}});
    const responses=await Promise.all(Array.from({length:4},()=>makeHandler()(makeRequest())));
    assert.ok(responses.every(response=>response.status===200));
    assert.equal(limiterChecks,1);assert.equal(catalogReads,1);
  }finally{if(prior===undefined)delete globalThis.caches;else globalThis.caches=prior;}
});

test('coalesced catalog fill releases after rejection and recovers',async()=>{
  const prior=globalThis.caches,stored=new Map();let catalogReads=0;
  globalThis.caches={default:{match:async key=>stored.get(key.url)?.clone()||null,
    put:async(key,response)=>{stored.set(key.url,response.clone());}}};
  try{
    const handler=eventWorkerHandler({EVENTS_ENABLED:'true',FIREBASE_PROJECT_ID:'polytrack-052',
      EVENT_RATE_LIMITER:{limit:async()=>({success:true})}},{
      request:async path=>{if(path===':beginTransaction')return {transaction:'fixture'};
        if(path===':commit')return {};
        if(path.includes('event_catalog')){catalogReads++;if(catalogReads===1)throw Error('temporary origin failure');}
        return null;},authenticate:async()=>'unused',origins:new Set(['https://game.test'])});
    const makeRequest=()=>new Request('https://ranked.example/v1/events/catalog',{
      headers:{Origin:'https://game.test','CF-Connecting-IP':'192.0.2.1'}});
    assert.equal((await handler(makeRequest())).status,503);
    assert.equal((await handler(makeRequest())).status,200);
    assert.equal(catalogReads,2);
  }finally{if(prior===undefined)delete globalThis.caches;else globalThis.caches=prior;}
});

test('event cache and coalescing keys remain isolated by Firebase project',async()=>{
  const prior=globalThis.caches,stored=new Map();let limiterChecks=0,catalogReads=0;
  globalThis.caches={default:{match:async key=>stored.get(key.url)?.clone()||null,
    put:async(key,response)=>{stored.set(key.url,response.clone());}}};
  try{
    const makeHandler=project=>eventWorkerHandler({EVENTS_ENABLED:'true',FIREBASE_PROJECT_ID:project,
      EVENT_RATE_LIMITER:{limit:async()=>{limiterChecks++;return {success:true};}}},{
      request:async path=>{if(path===':beginTransaction')return {transaction:'fixture'};
        if(path===':commit')return {};
        if(path.includes('event_catalog')){catalogReads++;await new Promise(resolve=>setTimeout(resolve,5));}
        return null;},authenticate:async()=>'unused',origins:new Set(['https://game.test'])});
    const makeRequest=()=>new Request('https://ranked.example/v1/events/catalog',{
      headers:{Origin:'https://game.test','CF-Connecting-IP':'192.0.2.1'}});
    const responses=await Promise.all([makeHandler('project-a')(makeRequest()),makeHandler('project-b')(makeRequest())]);
    assert.ok(responses.every(response=>response.status===200));
    assert.equal(limiterChecks,2);assert.equal(catalogReads,2);
    assert.ok(stored.has('https://ranked.example/__event_public_cache/project-a/catalog'));
    assert.ok(stored.has('https://ranked.example/__event_public_cache/project-b/catalog'));
  }finally{if(prior===undefined)delete globalThis.caches;else globalThis.caches=prior;}
});

test('event cache fill capacity fails closed without an unbounded origin load',async()=>{
  const prior=globalThis.caches,stored=new Map();let catalogReads=0,signalFull;
  const full=new Promise(resolve=>{signalFull=resolve;});
  let releaseFill;
  const held=new Promise(resolve=>{releaseFill=resolve;});
  globalThis.caches={default:{match:async key=>stored.get(key.url)?.clone()||null,
    put:async(key,response)=>{stored.set(key.url,response.clone());}}};
  try{
    const makeHandler=project=>eventWorkerHandler({EVENTS_ENABLED:'true',FIREBASE_PROJECT_ID:project,
      EVENT_RATE_LIMITER:{limit:async()=>({success:true})}},{
      request:async path=>{if(path===':beginTransaction')return {transaction:'fixture'};
        if(path===':commit')return {};
        if(path.includes('event_catalog')){catalogReads++;if(catalogReads===64)signalFull();await held;}
        return null;},authenticate:async()=>'unused',origins:new Set(['https://game.test'])});
    const makeRequest=()=>new Request('https://ranked.example/v1/events/catalog',{
      headers:{Origin:'https://game.test','CF-Connecting-IP':'192.0.2.1'}});
    const active=Array.from({length:64},(_,index)=>makeHandler('capacity-'+index)(makeRequest()));
    await full;
    const overCapacity=await makeHandler('capacity-overflow')(makeRequest());
    assert.equal(overCapacity.status,503);assert.equal(catalogReads,64);
    releaseFill();
    const completed=await Promise.all(active);
    assert.ok(completed.every(response=>response.status===200));
  }finally{releaseFill();if(prior===undefined)delete globalThis.caches;else globalThis.caches=prior;}
});

test('public event catalog remains available from stale edge cache during a Firestore outage',async()=>{
  const prior=globalThis.caches,stored=new Map(),pending=[];
  let unavailable=false;
  globalThis.caches={default:{match:async key=>stored.get(key.url)?.clone()||null,
    put:async(key,response)=>{stored.set(key.url,response.clone());}}};
  try{
    const handler=eventWorkerHandler({EVENTS_ENABLED:'true',FIREBASE_PROJECT_ID:'polytrack-052',
      EVENT_RATE_LIMITER:{limit:async()=>({success:true})}},{
      request:async path=>{
        if(unavailable)throw Error('Firestore unavailable');
        if(path===':beginTransaction')return {transaction:'fixture'};
        if(path===':commit')return {};
        return null;
      },authenticate:async()=>({uid:'unused'}),origins:new Set(['https://staticquasar931.github.io']),
      context:{waitUntil:promise=>pending.push(promise)}});
    const request=()=>new Request('https://ranked.example/v1/events/catalog',
      {headers:{Origin:'https://staticquasar931.github.io','CF-Connecting-IP':'192.0.2.1'}});
    assert.equal((await handler(request())).status,200);
    await Promise.all(pending.splice(0));
    for(const key of stored.keys())if(!key.includes('?stale=1'))stored.delete(key);
    unavailable=true;
    const fallback=await handler(request());
    assert.equal(fallback.status,200);
    assert.deepEqual((await fallback.json()).periods,[]);
  }finally{if(prior===undefined)delete globalThis.caches;else globalThis.caches=prior;}
});

test('event cleanup checks the catalog once per five-minute window while the other phase intakes inbox',async()=>{
  const at=Date.UTC(2026,8,14,0,3),calls=[];
  const result=await eventWorkerMaintenance({EVENTS_ENABLED:'true'}, {
    request:async(path)=>{calls.push(path);if(path===':runQuery')return [];return null;},
    at,now:()=>at,officialIds:[official],allIds:[official],
    targetForTrack:()=>assert.fail('this phase does not provision events')
  });
  assert.deepEqual(result,{consumed:0});
  assert.equal(calls.includes('/'+C.catalog+'/main'),false);
  assert.equal(calls.filter(path=>path===':runQuery').length,2,'inbox and retry due queries still run');
});

function fixture(target,existing=false) {
  const candidates=utcEventCandidates(at,[official],[rolling]);
  const daily=candidates.find(p=>p.kind==='daily'),weekly=candidates.find(p=>p.kind==='weekly');
  const data=new Map([[C.periods+'/'+daily.id,{id:daily.id,trackId:official}],
    [C.archives+'/w_20260907',{entries:[{rp:123}],archived:true}]]);
  if(existing)data.set(C.periods+'/'+weekly.id,{id:weekly.id,trackId:official,targetMs:12345});
  const calls=[],lookups=[],writes=[],fetches=[];
  const request=async(path,init)=>{
    calls.push(path);
    if(path===':beginTransaction')return {transaction:'fixture'};
    if(path===':rollback')return {};
    if(path===':commit') {
      const body=JSON.parse(init.body);assert.equal(body.transaction,'fixture');
      for(const write of body.writes) {
        const key=write.update.name.split('/documents/')[1];writes.push(key);
        data.set(key,eventDecode({mapValue:{fields:write.update.fields}}));
      }
      return {};
    }
    const key=path.slice(1).split('?')[0];
    return data.has(key)?{name:'projects/polytrack-052/databases/(default)/documents/'+key,
      updateTime:'2026-09-14T00:00:00Z',fields:eventEncode(data.get(key)).mapValue.fields}:null;
  };
  const fetch=async(url,init)=>{fetches.push({url,init});return new Response('unavailable',{status:503});};
  return {data,calls,lookups,writes,fetches,weekly,daily,run:()=>eventWorkerMaintenance({EVENTS_ENABLED:'true',
    EVENT_WEEKLY_TRACK_ID:rolling,EVENT_CAPACITY_JSON:JSON.stringify(capacity)},
    {request,officialIds:[official],allIds:[rolling,official],fetch,at,now:()=>at,
      targetForTrack:async id=>{lookups.push(id);return target;}})};
}
test('daily and weekly stay in disjoint registries across dates',()=>{
 for(let day=1;day<=30;day++) {
  const candidates=utcEventCandidates(Date.UTC(2026,8,day),[official],[rolling,official]);
  assert.equal(candidates.find(p=>p.kind==='daily').trackId,rolling);
  assert.equal(candidates.find(p=>p.kind==='weekly').trackId,official);
 }
 const config=JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 assert.equal(config.vars.EVENT_WEEKLY_TRACK_ID,undefined);
});

test('official weekly waits for legitimate target and never falls back to another track',async()=>{
  for(const target of [null,0,NaN,300001]) {
    const f=fixture(target),result=await f.run();
    assert.equal(result.created,null);assert.equal(result.reason,'no_verified_target_in_bounded_scan');
    assert.deepEqual(f.lookups,[official]);assert.equal(f.data.has(C.periods+'/'+f.weekly.id),false);
    assert.ok(f.writes.every(p=>p.startsWith(C.cursors+'/')));assert.ok(f.calls.length<=8);
    assert.deepEqual(f.fetches.map(call=>call.url),[KODUB_METADATA_URL]);
  }
});
test('official weekly uses trusted lookup target and preserves archive and normal score collections',async()=>{
  const f=fixture(21000),archive=structuredClone(f.data.get(C.archives+'/w_20260907'));
  const result=await f.run();assert.equal(result.created,f.weekly.id);
  const period=f.data.get(C.periods+'/'+f.weekly.id);
  assert.equal(period.trackId,official);assert.equal(period.targetMs,21000);assert.equal(period.maxRp,500);
  assert.equal(period.kind,'weekly');assert.equal(period.eligibility,'best-submitted-during-period');
  assert.deepEqual(f.fetches.map(call=>call.url),[KODUB_METADATA_URL]);
  assert.deepEqual(f.data.get(C.archives+'/w_20260907'),archive);
  assert.ok(!f.writes.some(p=>p.startsWith(C.archives+'/')||p.startsWith(C.canonical+'/')||p.startsWith(C.totals+'/')));
  f.lookups.length=0;f.writes.length=0;await f.run();assert.deepEqual(f.lookups,[]);assert.deepEqual(f.writes,[]);
  assert.deepEqual(f.fetches.map(call=>call.url),[KODUB_METADATA_URL,KODUB_METADATA_URL]);
});
test('new featured configuration never changes an existing weekly period',async()=>{
  const f=fixture(19997,true),before=structuredClone([...f.data]);await f.run();
  assert.deepEqual([...f.data],before);assert.deepEqual(f.lookups,[]);assert.deepEqual(f.writes,[]);
  assert.deepEqual(f.fetches.map(call=>call.url),[KODUB_METADATA_URL]);
});
