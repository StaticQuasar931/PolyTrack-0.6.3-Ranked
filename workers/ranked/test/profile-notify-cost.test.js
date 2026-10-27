import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../src/index.js';
import {encode,decode} from '../../../tools/verifier/firestore.mjs';
const origin='https://staticquasar931.github.io',accountId='profile-cost-racer';
function fixture(){
 let profile={accountId,ownerUid:'owner',nickname:'Racer One',profileUpdatedAt:1000},profileUpdateTime='2026-10-01T00:00:00.000Z',job=null,queries=0,writes=0,profileQueries=0;const tasks=[];
 const env={ALLOWED_ORIGINS:origin,OPEN_BETA_ENABLED:'false',PB_NOTIFY_RATE_LIMITER: {limit: async () => ({success:true})}, __TEST_UID:'owner',__TEST_FIRESTORE:async(path,init={})=>{
  if(path===':runQuery'){queries++;const q=JSON.parse(init.body).structuredQuery;if(q.where?.fieldFilter?.field?.fieldPath==='accountId')profileQueries++;return [];}
  if(path===':commit'){const body=JSON.parse(init.body);for(const write of body.writes){if(write.update?.name.includes('/0.6.2_s1_worker_jobs/profile_'))job=decode({mapValue:{fields:write.update.fields}});writes++;}return{writeResults:body.writes.map(()=>({updateTime:'v2'}))};}
  if(init.method==='PATCH'){writes++;job=decode({mapValue:{fields:JSON.parse(init.body).fields}});return{updateTime:'v1'};}
  const data=path.includes('/0.6.2_profiles_public/')?profile:path.includes('/0.6.2_s1_worker_jobs/')?job:null;
  return data?{fields:encode(data).mapValue.fields,updateTime:path.includes('/0.6.2_profiles_public/')?profileUpdateTime:'v1'}:null;
 }};
 return {async notify(){const response=await handleRequest(new Request('https://ranked.example/v1/profile/notify',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({accountId})}),env,{waitUntil:task=>tasks.push(task)});await Promise.all(tasks.splice(0));return{status:response.status,body:await response.json()};},reset(){queries=0;writes=0;profileQueries=0;},profileQueries:()=>profileQueries,counts:()=>({queries,writes}),identity:()=>job?.identity,reorderIdentity(){job.identity=Object.fromEntries(Object.entries(job.identity).reverse());},clearIdentityTimestamp(){job.identity.identityUpdatedAt=0;},pending(active=true){job={...job,pendingTrackIds:['remaining-track'],active};},rename(){profile={...profile,nickname:'Racer Two',profileUpdatedAt:2000};profileUpdateTime='2026-10-02T00:00:00.000Z';},disown(){profile.ownerUid='different-owner';}};
}
test('unchanged completed and pending profile jobs skip all race queries and writes',async()=>{
 const h=fixture();assert.equal((await h.notify()).status,202);assert.equal(h.counts().queries,1);
 assert.equal(h.identity().identityUpdatedAt,Date.parse('2026-10-01T00:00:00.000Z'));
 const firstTimestamp=h.identity().identityUpdatedAt;
 h.reset();for(let i=0;i<8;i++){const result=await h.notify();assert.equal(result.status,200);assert.equal(result.body.unchanged,true);}
 assert.equal(h.identity().identityUpdatedAt,firstTimestamp,'unchanged notifications preserve the established identity timestamp');
 assert.deepEqual(h.counts(),{queries:0,writes:0});h.pending();h.reset();
 const pending=await h.notify();assert.equal(pending.status,202);assert.equal(pending.body.queued,1);assert.equal(pending.body.unchanged,true);assert.deepEqual(h.counts(),{queries:0,writes:0});
 h.rename();h.reset();assert.equal((await h.notify()).status,202);assert.equal(h.counts().queries,1,'a real rename still discovers affected tracks');assert.equal(h.identity().identityUpdatedAt,Date.parse('2026-10-02T00:00:00.000Z'));
});
test('profile ownership remains checked before skipping an unchanged job',async()=>{
 const h=fixture();await h.notify();h.disown();h.reset();assert.equal((await h.notify()).status,403);assert.deepEqual(h.counts(),{queries:0,writes:0});
});

test('reordered stored identity keys do not reprocess an unchanged profile',async()=>{
 const h=fixture();await h.notify();h.reorderIdentity();h.reset();
 const result=await h.notify();assert.equal(result.status,200);assert.equal(result.body.unchanged,true);assert.deepEqual(h.counts(),{queries:0,writes:0});
});

test('legacy matching identity without a timestamp is repaired once',async()=>{
 const h=fixture();await h.notify();h.clearIdentityTimestamp();h.reset();
 const repaired=await h.notify();assert.equal(repaired.status,202);assert.equal(h.identity().identityUpdatedAt,Date.parse('2026-10-01T00:00:00.000Z'));assert.equal(h.counts().queries,1);
 h.reset();const unchanged=await h.notify();assert.equal(unchanged.status,200);assert.equal(unchanged.body.unchanged,true);assert.deepEqual(h.counts(),{queries:0,writes:0});
});

for (const active of [false, null]) test('unscheduled pending profile work is rebuilt: active='+active,async()=>{
 const h=fixture();await h.notify();h.pending(active);h.reset();
 const response=await h.notify();assert.equal(response.status,202);assert.notEqual(response.body.unchanged,true);assert.equal(h.profileQueries(),1,'recovery queries this racers tracks once');assert.ok(h.counts().writes>0);
});
