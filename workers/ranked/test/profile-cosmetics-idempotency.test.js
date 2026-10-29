import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest,sanitizeProfileCosmetics} from '../src/index.js';
import {eventEncode,eventDecode} from '../src/events-store.js';

const origin='https://cosmetics-audit.invalid',accountId='audit-racer';
const profilePath='0.6.2_profiles_public/'+accountId;
const overallPath='0.6.2_s1_leaderboards_overall/main';
const jobPath='0.6.2_s1_worker_jobs/profile_'+accountId;
const cosmetics=sanitizeProfileCosmetics({});

async function fixture(t) {
  t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));
  t.mock.method(console,'log',()=>{});
  const identity={accountId,name:'Racer',countryCode:'',carId:null,carColors:null,carStyle:'',
    profileCosmetics:cosmetics,groupCode:'',groupCodeUpdatedAt:0,identityUpdatedAt:123};
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(identity)));
  const signature=btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const db=new Map([
    [profilePath,{accountId,ownerUid:'owner',nickname:'Racer',profileCosmetics:cosmetics,cosmeticsSyncedAt:1,identityUpdatedAt:123}],
    [overallPath,{entries:[{userId:accountId,profileCosmetics:cosmetics,identityUpdatedAt:123}],revision:1}],
    [jobPath,{identity,signature,active:false,pendingTrackIds:[]}]
  ]);
  let reads=0,queries=0;const writes=[],tasks=[];
  const allow={limit:async()=>({success:true})};
  const env={ALLOWED_ORIGINS:origin,OPEN_BETA_ENABLED:'false',__TEST_UID:'owner',
    WRITE_IP_RATE_LIMITER:allow,PB_NOTIFY_RATE_LIMITER:allow,__TEST_FIRESTORE:async(path,init={})=>{
      if(path===':commit') {
        const batch=JSON.parse(init.body).writes;
        for(const write of batch) {
          assert.ok(write.update,'these fixtures never delete');
          const key=write.update.name.split('/documents/')[1];writes.push(key);
          db.set(key,eventDecode({mapValue:{fields:write.update.fields}}));
        }
        return {writeResults:batch.map(()=>({updateTime:'2026-10-01T00:00:00Z'}))};
      }
      if(init.method==='PATCH') {
        writes.push(path.slice(1));db.set(path.slice(1),eventDecode({mapValue:{fields:JSON.parse(init.body).fields}}));
        return {updateTime:'2026-10-01T00:00:00Z'};
      }
      if(path===':runQuery'){
        reads++;queries++;
        const query=JSON.parse(init.body).structuredQuery;
        assert.equal(query.from[0].collectionId,'0.6.2_race_results');
        return [...db].filter(([key,data])=>key.startsWith('0.6.2_race_results/')&&data.accountId===accountId)
          .slice(0,query.limit).map(([key,data])=>({document:{name:'projects/test/databases/(default)/documents/'+key,
            fields:eventEncode(data).mapValue.fields,updateTime:'2026-10-01T00:00:00Z'}}));
      }
      reads++;const data=db.get(path.slice(1));
      return data?{fields:eventEncode(data).mapValue.fields,updateTime:'2026-10-01T00:00:00Z'}:null;
    }};
  return {db,writes,env,reads:()=>reads,queries:()=>queries,async save(value=cosmetics) {
    const response=await handleRequest(new Request(origin+'/v1/profile/cosmetics',{method:'POST',
      headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify({accountId,cosmetics:value})}),env,
      {waitUntil:p=>tasks.push(p)});
    await Promise.all(tasks.splice(0));return response;
  }};
}

test('three identical fully propagated cosmetics saves go from six writes to zero',async t=>{
  const f=await fixture(t);
  for(let i=0;i<3;i++)assert.equal((await f.save()).status,200);
  assert.equal(f.reads(),24,'eight reads per request remain; no unmeasured read savings claimed');
  assert.equal(f.writes.length,0);assert.equal(f.queries(),0);
  assert.equal(f.db.get(profilePath).identityUpdatedAt,123);
});

test('an equal profile still repairs stale Overall without rewriting the profile',async t=>{
  const f=await fixture(t);
  f.db.get(overallPath).entries[0].profileCosmetics=sanitizeProfileCosmetics({theme:'cyan'});
  f.db.get(overallPath).entries[0].identityUpdatedAt=1;
  assert.equal((await f.save()).status,200);
  assert.deepEqual(f.writes,[overallPath]);
  assert.equal(f.db.get(overallPath).entries[0].profileCosmetics.theme,cosmetics.theme);
  assert.equal(f.db.get(overallPath).entries[0].identityUpdatedAt,123);
  assert.equal((await f.save()).status,200);assert.equal(f.writes.length,1);
});

test('an equal profile still recreates a missing propagation job',async t=>{
  const f=await fixture(t);f.db.delete(jobPath);
  assert.equal((await f.save()).status,202);
  assert.equal(f.queries(),1);assert.ok(f.db.has(jobPath));
  assert.equal(f.writes.filter(path=>path===jobPath).length,2);
  assert.equal(f.writes.includes(profilePath),false);assert.equal(f.writes.includes(overallPath),false);
});

test('a newer Overall identity timestamp is neither rewritten nor regressed during cosmetics repair',async t=>{
  const f=await fixture(t),entry=f.db.get(overallPath).entries[0];
  entry.identityUpdatedAt=456;
  assert.equal((await f.save()).status,200);assert.equal(f.writes.length,0);
  entry.profileCosmetics=sanitizeProfileCosmetics({theme:'cyan'});
  assert.equal((await f.save()).status,200);assert.deepEqual(f.writes,[overallPath]);
  assert.equal(f.db.get(overallPath).entries[0].identityUpdatedAt,456);
});

test('an active pending job is retained, not declared completed or reset',async t=>{
  const f=await fixture(t),job=f.db.get(jobPath);
  job.active=true;job.pendingTrackIds=['repair-track'];
  assert.equal((await f.save()).status,202);
  assert.deepEqual(f.db.get(jobPath).pendingTrackIds,['repair-track']);
  assert.equal(f.writes.length,0);assert.equal(f.queries(),0);
});

test('an inactive pending job resumes real track repair despite equal cosmetics',async t=>{
  const f=await fixture(t),job=f.db.get(jobPath);
  job.active=false;job.pendingTrackIds=['repair-track'];
  const trackPath='0.6.2_s1_leaderboards_track/repair-track';
  f.db.set(trackPath,{entries:[{accountId,timeMs:1000,name:'Racer',profileCosmetics:sanitizeProfileCosmetics({theme:'cyan'})}],
    signature:'stale',complete:true,totalEntries:1,algorithmVersion:'participation-v8-s1',schemaVersion:6});
  assert.equal((await f.save()).status,202);
  assert.equal(f.queries(),1);assert.ok(f.writes.includes(trackPath));
  assert.equal(f.db.get(trackPath).entries[0].profileCosmetics.theme,cosmetics.theme);
  assert.deepEqual(f.db.get(jobPath).pendingTrackIds,[]);
});

test('legacy equal cosmetics lacking a durable identity timestamp still take the repair path',async t=>{
  const f=await fixture(t);delete f.db.get(profilePath).identityUpdatedAt;
  assert.equal((await f.save()).status,200);
  assert.ok(f.writes.includes(profilePath));assert.ok(f.writes.includes(overallPath));
});

test('a racer absent from Overall does not republish an unrelated shared board',async t=>{
  const f=await fixture(t);f.db.get(overallPath).entries=[];
  assert.equal((await f.save()).status,200);assert.equal(f.writes.length,0);
});

test('ownership and unlock/supersession checks are not bypassed by idempotency',async t=>{
  const f=await fixture(t);f.db.get(profilePath).ownerUid='someone-else';
  assert.equal((await f.save()).status,403);assert.equal(f.writes.length,0);
  f.db.get(profilePath).ownerUid='owner';
  assert.equal((await f.save(sanitizeProfileCosmetics({theme:'cyan'}))).status,409);
  assert.equal(f.writes.length,0);
  delete f.db.get(profilePath).cosmeticsSyncedAt;
  assert.equal((await f.save(sanitizeProfileCosmetics({theme:'forest'}))).status,403);
  assert.equal(f.writes.length,0);
});

test('a genuine cosmetic change publishes profile, Overall and a custom-track job; its retry is a no-op',async t=>{
  const f=await fixture(t),trackId='future_custom_track',trackPath='0.6.2_s1_leaderboards_track/'+trackId;
  delete f.db.get(profilePath).cosmeticsSyncedAt;
  f.db.set('0.6.2_race_results/'+accountId+'_'+trackId,{accountId,trackId});
  f.db.set(trackPath,{entries:[{accountId,timeMs:1000,name:'Racer',profileCosmetics:cosmetics}],
    signature:'old-look',complete:true,totalEntries:1,algorithmVersion:'participation-v8-s1',schemaVersion:6});
  const changed=sanitizeProfileCosmetics({theme:'cyan'});
  assert.equal((await f.save(changed)).status,202);
  assert.equal(f.db.get(profilePath).profileCosmetics.theme,'cyan');
  assert.equal(f.db.get(overallPath).entries[0].profileCosmetics.theme,'cyan');
  assert.equal(f.db.get(trackPath).entries[0].profileCosmetics.theme,'cyan');
  assert.deepEqual(f.db.get(jobPath).pendingTrackIds,[]);
  assert.equal(f.db.get(jobPath).active,false);
  const writes=f.writes.length;
  assert.equal((await f.save(changed)).status,200);assert.equal(f.writes.length,writes);
});

test('a missing Overall cosmetics field repairs once without rewriting an equal profile',async t=>{
  const f=await fixture(t);delete f.db.get(overallPath).entries[0].profileCosmetics;
  assert.equal((await f.save()).status,200);assert.deepEqual(f.writes,[overallPath]);
  assert.equal(f.db.get(overallPath).entries[0].profileCosmetics.theme,cosmetics.theme);
  assert.equal((await f.save()).status,200);assert.equal(f.writes.length,1);
});

test('a missing entire Overall queues existing bounded reconstruction once, without fabricating rankings',async t=>{
  const f=await fixture(t);f.db.delete(overallPath);
  assert.equal((await f.save()).status,200);
  const metaPath='0.6.2_s1_release_meta/current';
  assert.deepEqual(f.writes,[metaPath]);assert.equal(f.db.get(metaPath).dirty,true);
  assert.equal(f.db.has(overallPath),false,'a profile cannot reconstruct all racer rankings');
  assert.equal((await f.save()).status,200);assert.equal(f.writes.length,1);
});
