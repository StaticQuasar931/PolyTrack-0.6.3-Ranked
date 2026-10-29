import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {eventWorkerHandler} from '../src/events-worker.js';
import {eventEncode} from '../src/events-store.js';
import {preparePublicationPages,PUBLIC_MANIFEST_COLLECTION,publicationManifestId} from '../src/paged-publication.js';
import {publicEventTotal,publicEventPage} from '../src/event-public-projection.js';

beforeEach(t=>{t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));});

test('public totals/pages use allowlists rather than copying private source fields',()=>{
 const row={accountId:'public-racer',name:'Racer',rp:123,events:2,rank:1,carStyle:'native',ownerUid:'PRIVATE_CANARY',proof:{key:'PRIVATE_CANARY'},replay:'PRIVATE_CANARY',privateNotes:'PRIVATE_CANARY'};
 assert.equal(JSON.stringify(publicEventTotal(row)).includes('PRIVATE_CANARY'),false);
 const page=publicEventPage({generation:'a'.repeat(64),page:0,pageSize:100,pageCount:1,totalEntries:1,complete:true,sourceRevision:7,
   entries:[row],ownerUid:'PRIVATE_CANARY',dynamicComponents:{permanentRollingHills:{status:'complete',sourceRevision:7,proof:'PRIVATE_CANARY'}}},'event_totals');
 assert.equal(JSON.stringify(page).includes('PRIVATE_CANARY'),false);assert.equal(page.sourceRevision,7);
});

test('event pages share cold fills, ignore irrelevant query parameters, and warm hits bypass database and limiter',async()=>{
 const prior=globalThis.caches,stored=new Map();let reads=0,transactions=0,rateChecks=0,admit=true;
 globalThis.caches={default:{match:async key=>stored.get(key.url)?.clone()||null,put:async(key,response)=>{stored.set(key.url,response.clone());}}};
 const rows=Array.from({length:101},(_,i)=>({accountId:'racer-'+i,name:'Racer '+i,rp:101-i,events:1,rank:i+1,ownerUid:'PRIVATE_CANARY'}));
 const paged=await preparePublicationPages('event_totals','main',rows,{sourceRevision:19});
 const data=new Map(paged.documents.map(d=>[d.collection+'/'+d.id,d.data]));
 data.set(PUBLIC_MANIFEST_COLLECTION+'/'+publicationManifestId('event_totals','main',paged.pagination.generation),paged.pagination);
 const handler=eventWorkerHandler({EVENTS_ENABLED:'true',EVENT_RATE_LIMITER:{limit:async()=>{rateChecks++;return {success:admit};}}},{
   request:async route=>{if(route===':beginTransaction'){transactions++;return {transaction:'fixture'};}if(route===':commit'||route===':rollback')return {};
     reads++;const key=new URL('https://fixture.test'+route).pathname.slice(1),value=data.get(key);return value?{fields:eventEncode(value).mapValue.fields,updateTime:'v1'}:null;},
   authenticate:async()=>'unused',origins:new Set(['https://game.test'])});
 const url=`https://ranked.example/v1/events/totals/page?generation=${paged.pagination.generation}&page=0`;
 const headers={Origin:'https://game.test','CF-Connecting-IP':'192.0.2.1'};
 try{
   const results=await Promise.all(Array.from({length:8},(_,i)=>handler(new Request(url+'&ignored='+i,{headers}))));
   for(const response of results){assert.equal(response.status,200);const body=await response.json();assert.equal(body.sourceRevision,19);assert.equal(body.entries.length,100);assert.equal(JSON.stringify(body).includes('PRIVATE_CANARY'),false);}
   assert.equal(transactions,1);assert.equal(reads,2);assert.equal(rateChecks,1);
   admit=false;const warm=await handler(new Request(url+'&another=1',{headers}));assert.equal(warm.status,200);assert.equal(transactions,1);assert.equal(reads,2);assert.equal(rateChecks,1);
   const denied=await handler(new Request(url.replace('page=0','page=1'),{headers}));assert.equal(denied.status,429);assert.equal(reads,2);
   admit=true;const second=await handler(new Request(url.replace('page=0','page=1'),{headers}));assert.equal(second.status,200);assert.equal((await second.json()).entries[0].accountId,'racer-100');assert.equal(reads,4);
 }finally{if(prior===undefined)delete globalThis.caches;else globalThis.caches=prior;}
});

async function pageMissFixture(t,kind='event_totals') {
  const original=Object.getOwnPropertyDescriptor(globalThis,'caches');
  Object.defineProperty(globalThis,'caches',{configurable:true,value:undefined});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'caches',original);else delete globalThis.caches;});
  const origin='https://game.test',period='d_20261028',id=kind==='event' ? period : 'main';
  const paged=await preparePublicationPages(kind,id,[{accountId:'racer',name:'Racer',timeMs:1000,rp:1,events:1,rank:1}],{sourceRevision:1});
  const manifest=PUBLIC_MANIFEST_COLLECTION+'/'+publicationManifestId(kind,id,paged.pagination.generation);
  const route=kind==='event' ? period+'/snapshot/page' : 'totals/page';
  const url='https://page-miss.test/v1/events/'+route+'?generation='+paged.pagination.generation+'&page=0';
  const data=new Map(),counts={reads:0,transactions:0,rateChecks:0,authChecks:0};
  let at=Date.UTC(2026,9,28),admit=true,authenticated=true,failure=null;
  const env={EVENTS_ENABLED:'true',EVENT_RATE_LIMITER:{limit:async()=>{counts.rateChecks++;return {success:admit};}}};
  const options={origins:new Set([origin]),now:()=>at,authenticate:async()=>{
    counts.authChecks++;if(!authenticated)throw Error('no auth');return 'owner';
  },request:async(path,init)=>{
    if(path===':beginTransaction'){counts.transactions++;return {transaction:'test'};}
    if(path===':rollback')return {};
    if(path===':commit'){assert.deepEqual(JSON.parse(init.body).writes,[]);return {};}
    counts.reads++;if(failure)throw failure;
    const value=data.get(new URL('https://fixture.test'+path).pathname.slice(1));
    return value ? {fields:eventEncode(value).mapValue.fields,updateTime:'v1'} : null;
  }};
  return {url,data,counts,manifest,paged,env,advance:ms=>{at+=ms;},fail:value=>{failure=value;},
    admit:value=>{admit=value;},authenticate:value=>{authenticated=value;},
    publish:()=>{data.set(manifest,paged.pagination);for(const row of paged.documents)data.set(row.collection+'/'+row.id,row.data);},
    // Production constructs a handler per request but shares its root environment.
    get:(target=url,headers={})=>eventWorkerHandler({...env,__FIRESTORE_ROOT_ENV:env},options)(new Request(target,
      {headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1',...headers}}))};
}

for(const kind of ['event','event_totals'])test(kind+' page misses share one read and expire at the original ten-second deadline',async t=>{
  const f=await pageMissFixture(t,kind);
  const cold=await Promise.all(Array.from({length:8},()=>f.get()));
  for(const response of cold){assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'snapshot_not_ready'});}
  for(let i=0;i<10;i++)assert.equal((await f.get(f.url+'&ignored='+i)).status,404);
  assert.deepEqual(f.counts,{reads:1,transactions:1,rateChecks:1,authChecks:0});
  f.advance(9999);assert.equal((await f.get()).status,404);assert.equal(f.counts.reads,1);
  f.publish();f.advance(1);assert.equal((await f.get()).status,200);
  assert.equal(f.counts.reads,3);assert.equal(f.counts.transactions,2);
});

test('a confirmed missing page is briefly cached even when its manifest exists',async t=>{
  const f=await pageMissFixture(t);f.data.set(f.manifest,f.paged.pagination);
  for(let i=0;i<3;i++)assert.equal((await f.get()).status,404);
  assert.equal(f.counts.reads,2);assert.equal(f.counts.transactions,1);
  f.publish();f.advance(10000);assert.equal((await f.get()).status,200);assert.equal(f.counts.reads,4);
});

test('page miss memory is bounded to 64 keys and isolated between root environments',async t=>{
  const f=await pageMissFixture(t),urls=[];
  for(let i=0;i<65;i++){
    const url=new URL(f.url);url.searchParams.set('generation',i.toString(16).padStart(64,'0'));urls.push(url.href);
    assert.equal((await f.get(url.href)).status,404);
  }
  assert.equal(f.counts.reads,65);
  assert.equal((await f.get(urls[64])).status,404);assert.equal(f.counts.reads,65);
  assert.equal((await f.get(urls[0])).status,404);assert.equal(f.counts.reads,66);
  assert.equal((await f.get()).status,404);
  const other=await pageMissFixture(t);other.publish();
  assert.equal((await other.get()).status,200);assert.equal(other.counts.reads,2);
});

test('transient page failures are not cached and recovery needs no expiry wait',async t=>{
  const f=await pageMissFixture(t);f.fail(Error('FIRESTORE_503'));
  for(let i=0;i<2;i++)assert.equal((await f.get()).status,503);
  assert.equal(f.counts.reads,2);assert.equal(f.counts.transactions,2);
  f.fail(null);f.publish();assert.equal((await f.get()).status,200);assert.equal(f.counts.reads,4);
});

test('malformed existing pages are not cached as missing pages',async t=>{
  const f=await pageMissFixture(t,'event');f.publish();
  const row=f.paged.documents[0].data.entries[0];delete row.timeMs;
  assert.equal((await f.get()).status,503);assert.equal(f.counts.reads,2);
  row.timeMs=1000;assert.equal((await f.get()).status,200);assert.equal(f.counts.reads,4);
});

test('page ingress denials are not cached and cached misses do not bypass origin or feature gates',async t=>{
  const f=await pageMissFixture(t);f.admit(false);
  assert.equal((await f.get()).status,429);assert.equal(f.counts.reads,0);
  f.admit(true);assert.equal((await f.get()).status,404);assert.equal(f.counts.reads,1);
  assert.equal((await f.get(f.url,{Origin:'https://not-allowed.test'})).status,403);
  f.env.EVENTS_ENABLED='false';assert.equal((await f.get()).status,503);
  f.env.EVENTS_ENABLED='true';assert.equal((await f.get()).status,404);assert.equal(f.counts.reads,1);
});

test('receipt authentication failures and non-page replay 404s never enter the page miss cache',async t=>{
  const f=await pageMissFixture(t),base='https://page-miss.test/v1/events/d_20261028/';
  const receipt=base+'receipt?accountId='+'b'.repeat(64);
  f.authenticate(false);assert.equal((await f.get(receipt)).status,401);assert.equal(f.counts.reads,0);
  f.authenticate(true);
  for(let i=0;i<2;i++)assert.equal((await f.get(receipt)).status,403);
  assert.equal(f.counts.authChecks,3);assert.equal(f.counts.reads,2);
  for(let i=0;i<2;i++){
    const response=await f.get(base+'replays/'+'b'.repeat(64));
    assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'event_replay_not_found'});
  }
  assert.equal(f.counts.reads,4);
});
