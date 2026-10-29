import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{handleRequest,sanitizeProfileCosmetics} from '../src/index.js';
import {eventEncode,eventDecode} from '../src/events-store.js';
import {preparePublicationPages,PUBLIC_PAGE_COLLECTION} from '../src/paged-publication.js';

const origin='https://cosmetics-audit.invalid',accountId='audit-racer';
const profilePath='0.6.2_profiles_public/'+accountId;
const overallPath='0.6.2_s1_leaderboards_overall/main';
const jobPath='0.6.2_s1_worker_jobs/profile_'+accountId;
const cosmeticJobPath='0.6.2_s1_cosmetic_jobs/'+accountId;
const cosmetics=sanitizeProfileCosmetics({});

async function fixture(t) {
  t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));
  t.mock.method(console,'log',()=>{});
  const errors=[];t.mock.method(console,'error',(...args)=>errors.push(args));
  const identity={accountId,name:'Racer',countryCode:'',carId:null,carColors:null,carStyle:'',
    profileCosmetics:cosmetics,groupCode:'',groupCodeUpdatedAt:0,identityUpdatedAt:123};
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(identity)));
  const signature=btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const db=new Map([
    [profilePath,{accountId,ownerUid:'owner',nickname:'Racer',profileCosmetics:cosmetics,cosmeticsSyncedAt:1,identityUpdatedAt:123}],
    [overallPath,{entries:[{userId:accountId,profileCosmetics:cosmetics,identityUpdatedAt:123}],revision:1}],
    [jobPath,{identity,signature,active:false,pendingTrackIds:[]}]
  ]);
  let reads=0,queries=0,clock=0;const writes=[],tasks=[],readPaths=[];
  const versions=new Map([...db.keys()].map(key=>[key,'2026-10-01T00:00:00Z']));
  const replace=(key,data)=>{
    db.set(key,structuredClone(data));
    const version=new Date(Date.UTC(2026,9,1)+ ++clock).toISOString();
    versions.set(key,version);return version;
  };
  const control={beforeRequest:()=>{}};
  const allow={limit:async()=>({success:true})};
  const env={ALLOWED_ORIGINS:origin,OPEN_BETA_ENABLED:'false',__TEST_UID:'owner',
    WRITE_IP_RATE_LIMITER:allow,PB_NOTIFY_RATE_LIMITER:allow,__TEST_FIRESTORE:async(path,init={})=>{
      await control.beforeRequest(path,init);
      if(path===':commit') {
        const batch=JSON.parse(init.body).writes;
        for(const write of batch) {
          const key=write.update.name.split('/documents/')[1];
          const condition=write.currentDocument;
          if((condition?.updateTime && (!db.has(key) || condition.updateTime!==(versions.get(key)||'2026-10-01T00:00:00Z'))) ||
              (condition?.exists===false && db.has(key))) throw Error('FIRESTORE_412');
        }
        const writeResults=[];
        for(const write of batch) {
          assert.ok(write.update,'these fixtures never delete');
          const key=write.update.name.split('/documents/')[1];writes.push(key);
          writeResults.push({updateTime:replace(key,eventDecode({mapValue:{fields:write.update.fields}}))});
        }
        return {writeResults};
      }
      if(init.method==='PATCH') {
        writes.push(path.slice(1));
        return {updateTime:replace(path.slice(1),eventDecode({mapValue:{fields:JSON.parse(init.body).fields}}))};
      }
      if(path===':runQuery'){
        reads++;queries++;
        const query=JSON.parse(init.body).structuredQuery;
        const collection=query.from[0].collectionId,filter=query.where.fieldFilter;
        assert.ok(['0.6.2_race_results','0.6.2_s1_cosmetic_jobs','0.6.2_s1_worker_jobs'].includes(collection));
        if(collection!=='0.6.2_race_results')assert.equal(query.limit,1);
        return [...db].filter(([key,data])=>key.startsWith(collection+'/')&&data[filter.field.fieldPath]===eventDecode(filter.value))
          .slice(0,query.limit).map(([key,data])=>({document:{name:'projects/test/databases/(default)/documents/'+key,
            fields:eventEncode(data).mapValue.fields,updateTime:versions.get(key)||'2026-10-01T00:00:00Z'}}));
      }
      reads++;readPaths.push(path.slice(1));const data=db.get(path.slice(1));
      return data?{fields:eventEncode(data).mapValue.fields,updateTime:versions.get(path.slice(1))||'2026-10-01T00:00:00Z'}:null;
    }};
  return {db,writes,env,errors,control,replace,readPaths,reads:()=>reads,queries:()=>queries,
    queue(overrides={}){replace(cosmeticJobPath,{accountId,ownerUid:'owner',cosmetics,active:true,updatedAt:1,...overrides});},
    async schedule(){
      let completion;
      worker.scheduled({cron:'2-59/5 * * * *',scheduledTime:900000},env,{waitUntil:p=>{completion=p;}});
      await completion;
    },async save(value=cosmetics) {
    const response=await handleRequest(new Request(origin+'/v1/profile/cosmetics',{method:'POST',
      headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify({accountId,cosmetics:value})}),env,
      {waitUntil:p=>tasks.push(p)});
    await Promise.all(tasks.splice(0));return response;
  }};
}

test('three identical fully propagated cosmetics saves go from six writes to zero',async t=>{
  const f=await fixture(t);
  for(let i=0;i<3;i++)assert.equal((await f.save()).status,200);
  assert.equal(f.reads(),27,'nine reads per request including the bounded fallback-job lookup');
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
  f.queue({cosmetics:changed});
  assert.equal((await f.save(changed)).status,202);
  assert.equal(f.db.get(profilePath).profileCosmetics.theme,'cyan');
  assert.equal(f.db.get(overallPath).entries[0].profileCosmetics.theme,'cyan');
  assert.equal(f.db.get(trackPath).entries[0].profileCosmetics.theme,'cyan');
  assert.deepEqual(f.db.get(jobPath).pendingTrackIds,[]);
  assert.equal(f.db.get(jobPath).active,false);
  assert.equal(f.db.get(cosmeticJobPath).active,false);
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

const commitsPath=(init,path)=>init.body && JSON.parse(init.body).writes?.some(write=>write.update?.name.endsWith('/'+path));

test('successful immediate propagation completes its fallback and the next cron only queries once',async t=>{
  const f=await fixture(t);f.queue({error:'previous_failure'});
  assert.equal((await f.save()).status,200);
  assert.deepEqual(f.writes,[cosmeticJobPath]);
  assert.equal(f.db.get(cosmeticJobPath).active,false);
  assert.equal(f.db.get(cosmeticJobPath).error,'');
  assert.ok(f.db.get(cosmeticJobPath).completedAt>0);
  const reads=f.reads();await f.schedule();
  assert.equal(f.reads()-reads,1);assert.equal(f.queries(),1);
  assert.deepEqual(f.writes,[cosmeticJobPath]);assert.deepEqual(f.errors,[]);
});

for(const overrides of [{ownerUid:'other'},{accountId:'other'},{cosmetics:sanitizeProfileCosmetics({theme:'cyan'})},{active:false}]) {
  test('immediate completion ignores a nonmatching or inactive fallback '+JSON.stringify(overrides),async t=>{
    const f=await fixture(t);f.queue(overrides);
    const before=structuredClone(f.db.get(cosmeticJobPath));
    assert.equal((await f.save()).status,200);
    assert.deepEqual(f.db.get(cosmeticJobPath),before);assert.deepEqual(f.writes,[]);
  });
}

for(const scheduled of [false,true])for(const theme of ['classic','cyan']) {
  test(`${scheduled?'scheduled':'immediate'} completion preserves a concurrently queued ${theme} draft by version`,async t=>{
    const f=await fixture(t);f.queue();
    const newer={...f.db.get(cosmeticJobPath),cosmetics:sanitizeProfileCosmetics({theme}),updatedAt:999};
    let raced=false;
    f.control.beforeRequest=(path,init)=>{
      if(path===':commit'&&commitsPath(init,cosmeticJobPath)&&!raced){raced=true;f.replace(cosmeticJobPath,newer);}
    };
    if(scheduled)await f.schedule();else assert.equal((await f.save()).status,200);
    assert.equal(raced,true);assert.deepEqual(f.db.get(cosmeticJobPath),newer);
    assert.deepEqual(f.writes,[]);assert.deepEqual(f.errors,[]);
  });
}

for(const failurePath of [overallPath,jobPath,cosmeticJobPath]) {
  test('failure writing '+failurePath+' retains the fallback for a repairable retry',async t=>{
    const f=await fixture(t);f.queue();
    f.db.get(overallPath).entries[0].profileCosmetics=sanitizeProfileCosmetics({theme:'cyan'});
    f.db.delete(jobPath);
    let failed=false;
    f.control.beforeRequest=(path,init)=>{
      if(!failed && (path===':commit'&&commitsPath(init,failurePath) || path==='/'+failurePath&&init.method==='PATCH')){
        failed=true;throw Error('FIRESTORE_503');
      }
    };
    await assert.rejects(f.save(),/FIRESTORE_503/);
    assert.equal(failed,true);assert.equal(f.db.get(cosmeticJobPath).active,true);
    f.control.beforeRequest=()=>{};
    await f.save();
    assert.equal(f.db.get(cosmeticJobPath).active,false);
    assert.equal(f.db.get(overallPath).entries[0].profileCosmetics.theme,'classic');
    assert.equal(f.writes.filter(path=>path===overallPath).length,1,'successful publication is not repeated on retry');
    assert.equal(f.writes.includes(profilePath),false);
    assert.deepEqual(f.db.get(jobPath).pendingTrackIds,[]);
  });
}

for(const scheduled of [false,true]) {
  test(`${scheduled?'scheduled':'immediate'} completion waits for an accepted profile handoff`,async t=>{
    const f=await fixture(t);f.queue();let profileReads=0;
    f.control.beforeRequest=path=>{
      if(path==='/'+profilePath && ++profileReads===2)f.replace(profilePath,{...f.db.get(profilePath),ownerUid:'other'});
    };
    if(scheduled)await f.schedule();else assert.equal((await f.save()).status,403);
    assert.equal(profileReads,2);assert.equal(f.db.get(cosmeticJobPath).active,true);
    assert.deepEqual(f.writes,[]);
  });
}

test('accepted pending per-track work owns repair after the cosmetic fallback completes',async t=>{
  const f=await fixture(t);f.queue();
  Object.assign(f.db.get(jobPath),{active:true,pendingTrackIds:['repair-track']});
  assert.equal((await f.save()).status,202);
  assert.equal(f.db.get(cosmeticJobPath).active,false);
  assert.deepEqual(f.db.get(jobPath).pendingTrackIds,['repair-track']);
  assert.equal(f.db.get(jobPath).active,true);assert.deepEqual(f.writes,[cosmeticJobPath]);
});

test('failed background track propagation stays repairable in the accepted profile job',async t=>{
  const f=await fixture(t),trackId='repair-track',trackPath='0.6.2_s1_leaderboards_track/'+trackId;
  f.queue();f.db.delete(jobPath);
  f.db.set('0.6.2_race_results/'+accountId+'_'+trackId,{accountId,trackId});
  f.db.set(trackPath,{entries:[{accountId,timeMs:1000,name:'Racer',profileCosmetics:sanitizeProfileCosmetics({theme:'cyan'})}],
    signature:'stale',complete:true,totalEntries:1,algorithmVersion:'participation-v8-s1',schemaVersion:6});
  f.control.beforeRequest=(path,init)=>{if(path===':commit'&&commitsPath(init,trackPath))throw Error('FIRESTORE_503');};
  assert.equal((await f.save()).status,202);
  assert.equal(f.db.get(cosmeticJobPath).active,false);
  assert.equal(f.db.get(jobPath).active,true);assert.deepEqual(f.db.get(jobPath).pendingTrackIds,[trackId]);
  assert.equal(f.errors.length,1);assert.equal(f.writes.includes(trackPath),false);
  f.control.beforeRequest=()=>{};
  let completion;
  worker.scheduled({cron:'2-59/5 * * * *',scheduledTime:1200000},f.env,{waitUntil:p=>{completion=p;}});
  await completion;
  assert.equal(f.db.get(jobPath).active,false);assert.deepEqual(f.db.get(jobPath).pendingTrackIds,[]);
  assert.equal(f.db.get(trackPath).entries[0].profileCosmetics.theme,'classic');
});

test('a delayed fallback checks deltas instead of rewriting an already published identity',async t=>{
  const f=await fixture(t);f.queue();
  await f.schedule();
  assert.deepEqual(f.writes,[cosmeticJobPath]);assert.deepEqual(f.errors,[]);
  assert.equal(f.db.get(cosmeticJobPath).active,false);
});

test('scheduled repair fixes stale Overall without regressing its newer timestamp or rewriting profile',async t=>{
  const f=await fixture(t);f.queue();
  Object.assign(f.db.get(overallPath).entries[0],{profileCosmetics:sanitizeProfileCosmetics({theme:'cyan'}),identityUpdatedAt:456});
  await f.schedule();
  assert.deepEqual(f.writes,[overallPath,cosmeticJobPath]);assert.deepEqual(f.errors,[]);
  assert.equal(f.db.get(overallPath).entries[0].identityUpdatedAt,456);
  assert.equal(f.db.get(overallPath).entries[0].profileCosmetics.theme,'classic');
});

test('scheduled publication failure leaves its job active and retries once without duplicate writes',async t=>{
  const f=await fixture(t);f.queue();delete f.db.get(overallPath).entries[0].profileCosmetics;
  f.control.beforeRequest=(path,init)=>{if(path===':commit'&&commitsPath(init,overallPath))throw Error('FIRESTORE_503');};
  await f.schedule();assert.equal(f.errors.length,1);assert.equal(f.db.get(cosmeticJobPath).active,true);
  assert.deepEqual(f.writes,[]);
  f.control.beforeRequest=()=>{};await f.schedule();
  assert.deepEqual(f.writes,[overallPath,cosmeticJobPath]);assert.equal(f.db.get(cosmeticJobPath).active,false);
});

test('scheduled missing Overall marks reconstruction dirty before completing the fallback',async t=>{
  const f=await fixture(t);f.queue();f.db.delete(overallPath);
  await f.schedule();
  assert.deepEqual(f.writes,['0.6.2_s1_release_meta/current',cosmeticJobPath]);
  assert.equal(f.db.get('0.6.2_s1_release_meta/current').dirty,true);
  assert.equal(f.db.has(overallPath),false);assert.deepEqual(f.errors,[]);
});

test('scheduled fallback for a racer absent from Overall never republishes unrelated rows',async t=>{
  const f=await fixture(t);f.queue();f.db.get(overallPath).entries=[{userId:'other',identityUpdatedAt:999}];
  await f.schedule();assert.deepEqual(f.writes,[cosmeticJobPath]);assert.deepEqual(f.errors,[]);
});

test('scheduled equality still rejects revoked metric-based cosmetic unlocks',async t=>{
  const f=await fixture(t),locked=sanitizeProfileCosmetics({theme:'forest'});
  f.db.get(profilePath).profileCosmetics=locked;f.db.get(overallPath).entries[0].profileCosmetics=locked;
  f.queue({cosmetics:locked});await f.schedule();
  assert.deepEqual(f.writes,[cosmeticJobPath]);
  assert.equal(f.db.get(cosmeticJobPath).error,'cosmetic_locked');assert.deepEqual(f.errors,[]);
});

test('unchanged paged Overall remains inspected; a missing page leaves fallback repair active',async t=>{
  const f=await fixture(t);
  const entries=Array.from({length:205},(_,i)=>({userId:'other-'+i,identityUpdatedAt:1}));
  entries[204]=structuredClone(f.db.get(overallPath).entries[0]);
  const publication=await preparePublicationPages('overall','main',entries,{sourceRevision:1,sourceComplete:true});
  f.db.set(overallPath,{entries:entries.slice(0,200),pagination:publication.pagination,sourceComplete:true,revision:1});
  for(const doc of publication.documents)f.db.set(doc.collection+'/'+doc.id,doc.data);
  assert.equal((await f.save()).status,200);assert.deepEqual(f.writes,[]);
  assert.equal(f.readPaths.filter(path=>path.startsWith(PUBLIC_PAGE_COLLECTION+'/')).length,3);
  f.queue();f.db.delete(publication.documents[2].collection+'/'+publication.documents[2].id);
  await assert.rejects(f.save(),/PUBLIC_PAGE_INCOMPLETE/);
  assert.equal(f.db.get(cosmeticJobPath).active,true);assert.deepEqual(f.writes,[]);
});
