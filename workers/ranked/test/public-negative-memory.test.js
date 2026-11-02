import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const root=process.env.POLYTRACK_REPO?pathToFileURL(process.env.POLYTRACK_REPO.replaceAll('\\','/')+'/'):new URL('../../../',import.meta.url);
const {handleRequest,persistTrackSnapshot}=await import(new URL('workers/ranked/src/index.js',root));
const {recallPublicResponse,rememberPublicResponse,clearPublicResponseMemory,publicResponseCacheScope}=await import(new URL('workers/ranked/src/public-response-memory.js',root));
const {createWorkerCaptureFetch}=await import(new URL('tools/worker-capture-fetch.mjs',root));
const origin='https://negative-cache.invalid',base='https://polytrack-ranked-worker.staticquasar931.workers.dev';
const trackId='a'.repeat(64),path='/v1/snapshot/track?trackId='+trackId;
const missing=()=>Response.json({error:'snapshot_not_ready'},{status:404,headers:{'Cache-Control':'public, max-age=10'}});
function fixture(t,{broken=false}={}){
  const old=globalThis.caches;
  if(broken)globalThis.caches={default:{match:async()=>{throw Error('cache');},put:async()=>{throw Error('cache');}}};else delete globalThis.caches;
  t.after(()=>{if(old===undefined)delete globalThis.caches;else globalThis.caches=old;});
  t.mock.method(console,'log',()=>{});
  t.mock.method(globalThis,'fetch',async()=>assert.fail('external network forbidden'));
  const f={reads:0,track:null,failCommit:false,readGate:null};
  f.env={ALLOWED_ORIGINS:origin,PUBLIC_READ_RATE_LIMIT_REQUIRED:'true',PUBLIC_READ_RATE_LIMITER:{limit:async()=>({success:true})},
    __TEST_FIRESTORE:async(p,init)=>{
      if(p===':commit'){
        if(f.failCommit)throw Error('FIRESTORE_412');
        const writes=JSON.parse(init.body).writes;
        for(const write of writes)if(write.update?.name.endsWith('/0.6.2_s1_leaderboards_track/'+trackId))f.track={fields:write.update.fields};
        return {writeResults:writes.map(()=>({updateTime:'2026-11-01T00:00:00Z'}))};
      }
      if(p.endsWith('/'+trackId)){f.reads++;const captured=f.track;if(f.readGate)await f.readGate;return captured;}
      return null;
    }};
  f.get=(suffix='',requestOrigin=origin)=>handleRequest(new Request(base+path+suffix,{headers:{Origin:requestOrigin,'CF-Connecting-IP':'192.0.2.1'}}),f.env);
  return f;
}
for(const broken of [false,true])test('eight same-key missing snapshots use one document operation, cache broken='+broken,async t=>{
  const f=fixture(t,{broken});let now=100000;t.mock.method(Date,'now',()=>now);
  for(let i=0;i<8;i++){const response=await f.get('&noise='+i);assert.equal(response.status,404);assert.equal((await response.json()).error,'snapshot_not_ready');}
  assert.equal(f.reads,1);
  now+=9000;assert.equal((await f.get()).headers.get('Cache-Control'),'public, max-age=1');assert.equal(f.reads,1);
  f.track={fields:{entries:{arrayValue:{values:[]}}}};
  now+=1000;assert.equal((await f.get()).status,200);assert.equal(f.reads,2);
});
test('negative responses expire, bound TTL and stay environment/key scoped',async()=>{
  const env={},other={};
  const response=Response.json({error:'snapshot_not_ready'},{status:404,headers:{'Cache-Control':'public, max-age=900'}});
  await rememberPublicResponse(env,'track',response,1000);
  assert.equal(recallPublicResponse(env,'track',1000).headers.get('Cache-Control'),'public, max-age=10');
  assert.equal(recallPublicResponse(env,'different',1000),null);assert.equal(recallPublicResponse(other,'track',1000),null);
  assert.equal(recallPublicResponse({__FIRESTORE_ROOT_ENV:env},'track',1000).status,404);
  assert.equal(recallPublicResponse(env,'track',11000),null);
});
test('auth, quota, server and non-sentinel errors are never remembered',async()=>{
  const env={};
  for(const status of [400,401,403,409,429,500,502,503]){
    await rememberPublicResponse(env,String(status),Response.json({error:'snapshot_not_ready'},{status,headers:{'Cache-Control':'public, max-age=10'}}),1000);
    assert.equal(recallPublicResponse(env,String(status),1000),null);
  }
  for(const [body,headers] of [[{error:'not_found'},{}],[{error:'snapshot_not_ready',private:'secret'},{}],
    [{error:'snapshot_not_ready'},{'Cache-Control':'private, max-age=10'}],[{error:'snapshot_not_ready'},{'Set-Cookie':'private=1'}]]){
    await rememberPublicResponse(env,'bad',Response.json(body,{status:404,headers:{'Cache-Control':'public, max-age=10',...headers}}),1000);
    assert.equal(recallPublicResponse(env,'bad',1000),null);
  }
});
test('negative memory retains the existing 64-entry limit',async()=>{
  const env={};for(let i=0;i<65;i++)await rememberPublicResponse(env,String(i),missing(),1000);
  assert.equal(recallPublicResponse(env,'0',1000),null);assert.equal(recallPublicResponse(env,'64',1000).status,404);
});
test('explicit memory purge clears positive and negative entries and fences old writes',async()=>{
  const env={},old=publicResponseCacheScope(env);
  await rememberPublicResponse(env,'negative',missing(),1000);
  await rememberPublicResponse(env,'positive',Response.json({ok:true},{headers:{'Cache-Control':'public, max-age=300'}}),1000);
  clearPublicResponseMemory(env);
  assert.equal(recallPublicResponse(env,'negative',1000),null);assert.equal(recallPublicResponse(env,'positive',1000),null);
  await rememberPublicResponse(env,'negative',missing(),1000,old);assert.equal(recallPublicResponse(env,'negative',1000),null);
});
test('successful publication invalidates missing responses immediately; failed commit does not',async t=>{
  const f=fixture(t);assert.equal((await f.get()).status,404);f.failCommit=true;
  await assert.rejects(persistTrackSnapshot(f.env,trackId,[]),/412/);
  assert.equal((await f.get()).status,404);assert.equal(f.reads,1);
  f.failCommit=false;await persistTrackSnapshot(f.env,trackId,[]);
  const response=await f.get();assert.equal(response.status,200);assert.deepEqual((await response.json()).entries,[]);assert.equal(f.reads,2);
});
test('publication fences an old in-flight miss and does not rejoin it',async t=>{
  const f=fixture(t);let release;f.readGate=new Promise(r=>release=r);
  const pending=f.get();while(!f.reads)await new Promise(r=>setImmediate(r));
  await persistTrackSnapshot(f.env,trackId,[]);f.readGate=null;
  assert.equal((await f.get()).status,200);release();assert.equal((await pending).status,404);
  assert.equal((await f.get()).status,200);assert.equal(f.reads,2);
});
test('in-flight snapshot reads do not cross environment owners',async t=>{
  const f=fixture(t);let release;f.readGate=new Promise(r=>release=r);
  const pending=f.get();while(!f.reads)await new Promise(r=>setImmediate(r));
  const other={...f.env,__TEST_FIRESTORE:async()=>({fields:{entries:{arrayValue:{values:[]}}}})};
  const response=await handleRequest(new Request(base+path,{headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.2'}}),other);
  assert.equal(response.status,200);release();assert.equal((await pending).status,404);
});
test('warm signed-capture 404 cannot bypass exact-path, expiry, issuer, origin or unsigned auth gates',async t=>{
  const f=fixture(t);
  const email='negative-cache-test@polytrack-052.iam.gserviceaccount.com',keys=generateKeyPairSync('rsa',{modulusLength:2048});
  f.env.PUBLIC_FIRESTORE_READ_MODE='capture-only';f.env.CAPTURE_SERVICE_ACCOUNT_EMAIL=email;
  t.mock.method(globalThis,'fetch',async url=>{assert.equal(url,'https://www.googleapis.com/service_accounts/v1/jwk/'+encodeURIComponent(email));return Response.json({keys:[{...keys.publicKey.export({format:'jwk'}),kid:'negative-test'}]});});
  let signed;
  const transport=createWorkerCaptureFetch({serviceAccount:{type:'service_account',client_email:email,private_key_id:'negative-test',private_key:keys.privateKey.export({format:'pem',type:'pkcs8'})},
    fetchImpl:(url,init)=>{signed=new Request(url,init);return handleRequest(signed,f.env);}});
  for(let i=0;i<8;i++)assert.equal((await transport(base+path,{headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'}})).status,404);
  assert.equal(f.reads,1);
  assert.equal((await f.get()).status,403);
  assert.equal((await handleRequest(new Request(base+path+'&different=1',signed),f.env)).status,403);
  assert.equal((await handleRequest(signed,{...f.env,CAPTURE_SERVICE_ACCOUNT_EMAIL:'other@polytrack-052.iam.gserviceaccount.com'})).status,403);
  assert.equal((await handleRequest(new Request(signed,{headers:{...Object.fromEntries(signed.headers),Origin:'https://foreign.invalid'}}),f.env)).status,403);
  const expired=createWorkerCaptureFetch({serviceAccount:{type:'service_account',client_email:email,private_key_id:'negative-test',private_key:keys.privateKey.export({format:'pem',type:'pkcs8'})},
    now:()=>Date.now()-61000,fetchImpl:(url,init)=>handleRequest(new Request(url,init),f.env)});
  assert.equal((await expired(base+path,{headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'}})).status,403);assert.equal(f.reads,1);
});

test('direct Overall publication clears memory only after successful PATCH',async()=>{
  const source=await readFile(new URL('workers/ranked/src/index.js',root),'utf8');
  const start=source.indexOf('async function writeOverallSnapshot('),end=source.indexOf('\nasync function readDocumentsForCollections(',start);
  assert.ok(start>=0&&end>start);
  const env={};let fail=true;
  const h=vm.createContext({prepareOverallSnapshotDocuments:async()=>[{data:{entries:[]}}],COLLECTIONS:{overall:'overall'},
    writeDocument:async()=>{if(fail)throw Error('PATCH failed');return {};},clearPublicResponseMemory,commitDocuments:()=>assert.fail('direct path expected')});
  vm.runInContext(source.slice(start,end),h);
  await rememberPublicResponse(env,'overall',missing(),1000);
  await assert.rejects(h.writeOverallSnapshot(env,null,{}),/PATCH failed/);assert.equal(recallPublicResponse(env,'overall',1000).status,404);
  fail=false;await h.writeOverallSnapshot(env,null,{});assert.equal(recallPublicResponse(env,'overall',1000),null);
});

test('retired miss cannot refill a working edge cache after publication',async t=>{
  const f=fixture(t),entries=new Map();
  globalThis.caches={default:{match:async key=>entries.get(key.url)?.clone()||null,put:async(key,response)=>entries.set(key.url,response.clone())}};
  let release;f.readGate=new Promise(r=>release=r);const pending=f.get();
  while(!f.reads)await new Promise(r=>setImmediate(r));
  await persistTrackSnapshot(f.env,trackId,[]);f.readGate=null;
  assert.equal((await f.get()).status,200);release();assert.equal((await pending).status,404);
  assert.equal(entries.size,0,'retired request cannot enqueue stale edge storage');
  assert.equal((await f.get()).status,200);assert.equal(f.reads,2);
});
