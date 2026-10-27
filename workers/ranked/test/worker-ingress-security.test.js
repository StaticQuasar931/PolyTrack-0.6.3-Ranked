import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../src/index.js';
import {kodubWeekly} from '../src/kodub-weekly.js';

const origin = 'https://staticquasar931.github.io';
const hash = 'a'.repeat(64);
const allow = () => ({limit: async () => ({success:true})});
const request = (path, method = 'GET', extraHeaders = {}) => new Request('https://security.example' + path, {
  method, headers:{Origin:origin, 'CF-Connecting-IP':'192.0.2.9', ...extraHeaders},
  ...(method === 'POST' ? {body:'{}'} : {})
});

const protectedRoutes = [
  ['GET','/v1/profile/group-code?accountId=' + hash],
  ...['/v1/pb/notify','/v1/profile/notify','/v1/profile/cosmetics','/v1/profile/group-code',
    '/v1/extra-tracks/submissions','/v1/extra-tracks/reports','/v1/extra-tracks/unranked'].map(path => ['POST',path])
];

test('all per-user protected routes fail closed before storage on missing or broken bindings', async () => {
  for (const limiter of [undefined, null, {}, {limit:1}, {limit:async()=>{throw Error('offline');}},
    {limit:async()=>undefined}, {limit:async()=>null}, {limit:async()=>({})},
    {limit:async()=>({success:'true'})}]) {
    for (const [method,path] of protectedRoutes) {
      let storage = 0;
      const env = {ALLOWED_ORIGINS:origin, __TEST_UID:'owner', WRITE_IP_RATE_LIMITER:allow(),
        PB_NOTIFY_RATE_LIMITER:limiter, __TEST_FIRESTORE:async()=>{storage++;assert.fail('storage must not run');}};
      const response = await handleRequest(request(path,method),env);
      assert.equal(response.status,503,method + ' ' + path);
      assert.equal((await response.json()).error,'user_limiter_unavailable');
      assert.equal(response.headers.get('Retry-After'),'60');
      assert.equal(response.headers.get('Cache-Control'),'no-store, max-age=0');
      assert.equal(storage,0);
    }
  }
});

test('per-user denials return 429 and share the authenticated UID across routes', async () => {
  const keys = [];
  const env = {ALLOWED_ORIGINS:origin, __TEST_UID:'authenticated-owner', WRITE_IP_RATE_LIMITER:allow(),
    PB_NOTIFY_RATE_LIMITER:{limit:async({key})=>{keys.push(key);return {success:false};}},
    __TEST_FIRESTORE:async()=>assert.fail('storage must not run')};
  for (const [method,path] of protectedRoutes) {
    const response = await handleRequest(request(path,method,{'X-Forwarded-For':'spoofed'}),env);
    assert.equal(response.status,429);
    assert.equal((await response.json()).error,'rate_limited');
    assert.equal(response.headers.get('Retry-After'),'60');
  }
  assert.deepEqual(keys,protectedRoutes.map(()=>'authenticated-owner'));
});

test('an admitted per-user request still checks document ownership', async () => {
  let reads = 0;
  const env = {ALLOWED_ORIGINS:origin,__TEST_UID:'owner',WRITE_IP_RATE_LIMITER:allow(),
    PB_NOTIFY_RATE_LIMITER:allow(),__TEST_FIRESTORE:async()=>{reads++;return null;}};
  const response = await handleRequest(request('/v1/profile/notify','POST'),env);
  assert.equal(response.status,400);
  const ownedRequest = new Request('https://security.example/v1/profile/notify',{
    method:'POST',headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.9'},body:JSON.stringify({accountId:hash})});
  const result = await handleRequest(ownedRequest,env);
  assert.equal(result.status,403);
  assert.equal((await result.json()).error,'profile_not_owned');
  assert.equal(reads,1);
});

test('weekly cache misses require a healthy public limiter for metadata, tracks and images', async t => {
  let fetches = 0;
  t.mock.method(globalThis,'fetch',async()=>{fetches++;assert.fail('no upstream request may escape admission');});
  const previous = globalThis.caches;
  globalThis.caches = {default:{match:async()=>undefined}};
  t.after(()=>{if(previous === undefined)delete globalThis.caches;else globalThis.caches=previous;});
  for (const limiter of [undefined,null,{}, {limit:async()=>{throw Error('down');}},
    {limit:async()=>({})}, {limit:async()=>({success:false})}]) {
    for (const path of ['/v1/kodub-weekly','/v1/kodub-weekly/track/'+hash,'/v1/kodub-weekly/image/'+hash]) {
      const response = await handleRequest(request(path),{ALLOWED_ORIGINS:origin,PUBLIC_READ_RATE_LIMITER:limiter});
      assert.equal(response.status,429);
      assert.equal(response.headers.get('Retry-After'),'60');
      assert.equal(response.headers.get('Cache-Control'),'no-store');
    }
  }
  assert.equal(fetches,0);
});

test('weekly cached responses remain available without limiter or caller IP', async t => {
  t.mock.method(globalThis,'fetch',async()=>assert.fail('cache hit must not fetch upstream'));
  const previous = globalThis.caches;
  globalThis.caches = {default:{match:async()=>Response.json({cached:true})}};
  t.after(()=>{if(previous === undefined)delete globalThis.caches;else globalThis.caches=previous;});
  const response = await handleRequest(new Request('https://security.example/v1/kodub-weekly',{
    headers:{Origin:origin}}),{ALLOWED_ORIGINS:origin});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{cached:true});
});

test('weekly uncached admission uses trusted edge IP and never forwards client credentials', async t => {
  let fetches = 0;
  const keys = [];
  const previous = globalThis.caches;
  globalThis.caches = {default:{match:async()=>undefined}};
  t.after(()=>{if(previous === undefined)delete globalThis.caches;else globalThis.caches=previous;});
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    fetches++;
    assert.equal(url,'https://vps.kodub.com/v6/trackOfTheWeek?version=0.6.3');
    assert.equal(init.headers.Authorization,undefined);
    assert.equal(init.headers.Cookie,undefined);
    return Response.json({current:null});
  });
  const env = {ALLOWED_ORIGINS:origin,PUBLIC_READ_RATE_LIMITER:{limit:async({key})=>{
    keys.push(key);return {success:true};}}};
  const response = await handleRequest(request('/v1/kodub-weekly?noise=1','GET',{
    Authorization:'Bearer client-value',Cookie:'client-value','X-Forwarded-For':'spoofed'}),env);
  assert.equal(response.status,200);
  assert.deepEqual(keys,['192.0.2.9']);
  assert.equal(fetches,1);
  const missingIp = await handleRequest(new Request('https://security.example/v1/kodub-weekly',{
    headers:{Origin:origin,'X-Forwarded-For':'192.0.2.9'}}),env);
  assert.equal(missingIp.status,429);
  assert.equal(fetches,1);
});

test('weekly proxy cannot fetch without explicit successful admission, but cache hits bypass admission', async () => {
  for (const admit of [undefined,async()=>false,async()=>({success:true}),async()=>{throw Error('down');}]) {
    const response = await kodubWeekly(request('/v1/kodub-weekly'),{}, {},{
      cache:{match:async()=>undefined},admit,fetch:async()=>assert.fail('must not fetch')});
    assert.equal(response.status,429);
  }
  const hit = await kodubWeekly(request('/v1/kodub-weekly'),{}, {},{
    cache:{match:async()=>Response.json({cached:true})},admit:async()=>assert.fail('must not admit hit')});
  assert.equal(hit.status,200);
});
