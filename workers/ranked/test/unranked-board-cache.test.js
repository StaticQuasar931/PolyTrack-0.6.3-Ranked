import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../src/index.js';
import {eventEncode} from '../src/events-store.js';

const origin='https://audit.invalid';
const trackId='586fbb2ef6e638f8d22e050342896497f22da6302ff081e434aa17bf6f75cf87';
const request=(suffix='', from=origin)=>new Request('https://cache-audit.invalid/v1/extra-tracks/unranked?trackId='+trackId+suffix,
  {headers:{Origin:from,'CF-Connecting-IP':'192.0.2.1'}});

function fixture(t, {cache, load}={}) {
  t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));
  t.mock.method(console,'log',()=>{});
  const previous=globalThis.caches;
  if (cache) globalThis.caches={default:cache}; else delete globalThis.caches;
  t.after(()=>{if(previous===undefined)delete globalThis.caches;else globalThis.caches=previous;});
  let reads=0,admissions=0,version=1;
  const env={ALLOWED_ORIGINS:origin+',https://other.invalid',PUBLIC_READ_RATE_LIMIT_REQUIRED:'true',
    PUBLIC_READ_RATE_LIMITER:{limit:async()=>{admissions++;return {success:true};}},
    __TEST_FIRESTORE:async(path,init={})=>{
      assert.equal(path,'/0.6.2_extra_unranked_leaderboards/'+trackId);
      assert.equal(init.method,undefined);
      reads++;
      if(load) await load(reads);
      return {fields:eventEncode({entries:[{accountId:'racer',timeMs:version}],total:1}).mapValue.fields};
    }};
  return {env,get:(suffix='',from=origin)=>handleRequest(request(suffix,from),env),
    reads:()=>reads,admissions:()=>admissions,version:value=>{version=value;}};
}

test('ten identical/noisy GETs cost one read, expire at ten seconds, and retain the response shape',async t=>{
  let now=Date.parse('2026-10-28T00:00:00Z');t.mock.method(Date,'now',()=>now);
  const f=fixture(t);
  for(let i=0;i<10;i++) {
    const response=await f.get('&noise='+i);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{trackId,unranked:true,entries:[{accountId:'racer',timeMs:1}],total:1});
  }
  assert.equal(f.reads(),1,'before: ten reads; after: one');
  assert.equal(f.admissions(),1);
  f.version(2);now+=9999;
  assert.equal((await (await f.get()).json()).entries[0].timeMs,1);
  now++;
  assert.equal((await (await f.get()).json()).entries[0].timeMs,2);
  assert.equal(f.reads(),2,'cache hits never renew the original expiry');
});

test('twelve concurrent misses coalesce while admission still applies to each caller',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,{load:()=>gate});
  const requests=Array.from({length:12},(_,i)=>f.get('&noise='+i));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.reads(),1);
  assert.equal(f.admissions(),12);
  f.env.PUBLIC_READ_RATE_LIMITER={limit:async()=>({success:false})};
  assert.equal((await f.get()).status,429,'joining a pending read cannot bypass admission');
  release();
  for(const response of await Promise.all(requests)) assert.equal(response.status,200);
});

test('edge cache failures are optional and successful responses remain in bounded memory',async t=>{
  const f=fixture(t,{cache:{match:async()=>{throw Error('offline');},put:async()=>{throw Error('offline');}}});
  for(let i=0;i<4;i++)assert.equal((await f.get()).status,200);
  assert.equal(f.reads(),1);
});

test('failed fills are not cached or left in flight',async t=>{
  const f=fixture(t,{load:n=>{if(n===1)throw Error('storage offline');}});
  await assert.rejects(f.get(),/storage offline/);
  assert.equal((await f.get()).status,200);
  assert.equal(f.reads(),2);
  assert.equal((await f.get()).status,200);
  assert.equal(f.reads(),2);
});

test('cache keys isolate origins, projects and environments, and reject invalid tracks before storage',async t=>{
  const f=fixture(t);
  assert.equal((await f.get()).headers.get('Access-Control-Allow-Origin'),origin);
  assert.equal((await f.get('','https://other.invalid')).headers.get('Access-Control-Allow-Origin'),'https://other.invalid');
  assert.equal(f.reads(),2);
  f.env.FIREBASE_PROJECT_ID='another-project';
  assert.equal((await f.get()).status,200);assert.equal(f.reads(),3);
  assert.equal((await handleRequest(request(),{...f.env})).status,200);assert.equal(f.reads(),4);
  const bad=new Request('https://cache-audit.invalid/v1/extra-tracks/unranked?trackId=invented',
    {headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'}});
  assert.equal((await handleRequest(bad,f.env)).status,400);assert.equal(f.reads(),4);
});

test('a warm edge cache bypasses both storage and admission',async t=>{
  const f=fixture(t,{cache:{match:async()=>Response.json({cached:true})}});
  f.env.PUBLIC_READ_RATE_LIMITER=undefined;
  assert.deepEqual(await (await f.get()).json(),{cached:true});
  assert.equal(f.reads(),0);assert.equal(f.admissions(),0);
});

test('successful edge fills protect a fresh environment even when waitUntil throws',async t=>{
  const saved=new Map();
  const f=fixture(t,{cache:{match:async key=>saved.get(key.url)?.clone(),
    put:async(key,response)=>{saved.set(key.url,response.clone());}}});
  assert.equal((await handleRequest(request(),f.env,{waitUntil:()=>{throw Error('closed context');}})).status,200);
  assert.equal(saved.size,1);
  const other={...f.env,PUBLIC_READ_RATE_LIMITER:undefined};
  assert.equal((await handleRequest(request('&noise=1'),other)).status,200);
  assert.equal(f.reads(),1);
});
