import test from 'node:test';
import assert from 'node:assert/strict';
import {Socket} from 'node:net';
import {execFileSync} from 'node:child_process';
import {eventEncode, eventDecode} from '../src/events-store.js';
import {profileRetryEntries, deferProfileTrack, PROFILE_RETRY_MAX_MS} from '../src/profile-maintenance.js';
const baseline = process.env.PROFILE_RETRY_BASELINE === '1';
const api = baseline ? await import('data:text/javascript,' + encodeURIComponent(execFileSync('git',
  ['show','58ccdc1c357d0bd7a2ac9e9c188f1a25f8cb0c7e:workers/ranked/src/index.js'], {encoding:'utf8'})
  .replace(/from '(\.\/[^']+)'/g, (_, p) => `from '${new URL('../src/' + p.slice(2), import.meta.url).href}'`))) : await import('../src/index.js');
const jobs='0.6.2_s1_worker_jobs', boards='0.6.2_s1_leaderboards_track', races='0.6.2_race_results';
const base='projects/profile-retry-offline/databases/(default)/documents/';
const start=Date.UTC(2026,10,5,0,7), origin='https://profile-retry.invalid';
const jobKey=account=>jobs+'/profile_'+account;
function fixture(t, ids=['one','two','three','four']) {
  t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
  t.mock.method(Socket.prototype,'connect',()=>assert.fail('network forbidden'));
  t.mock.method(console,'log',()=>{});
  const errors=[]; t.mock.method(console,'error',(...args)=>errors.push(args));
  let now=start, serial=0;
  t.mock.method(Date,'now',()=>now);
  const data=new Map(), versions=new Map(), calls=[], commits=[];
  const stats={reads:0,writes:0,requests:0};
  const queryCosts={activeQueries:0,retryQueries:0,emptyMinimumReads:0,queryDocuments:0,pointReads:0};
  const control={beforeCommit:null,afterCommit:null,beforeRead:null,beforeQuery:null};
  const put=(key,value)=>{data.set(key,structuredClone(value));versions.set(key,new Date(now+(++serial)).toISOString());};
  const wire=key=>({name:base+key,fields:eventEncode(data.get(key)).mapValue.fields,updateTime:versions.get(key)});
  const addJob=(account,tracks)=>{
    const identity={accountId:account,name:'Queued '+account,countryCode:'US',identityUpdatedAt:start};
    put(jobKey(account),{kind:'profile',active:true,accountId:account,identity,signature:'sig-'+account,
      pendingTrackIds:tracks,trackDiscovery:{version:1,complete:true,cursor:''},processed:0,changed:0,updatedAt:start});
    put('0.6.2_profiles_public/'+account,{accountId:account,ownerUid:'owner',nickname:identity.name,countryCode:'US'});
    for(const id of tracks)put(races+'/'+account+'_'+id,{accountId:account,trackId:id});
  };
  for(const id of ids){
    put(boards+'/'+id,{trackId:id,entries:[],schemaVersion:0});
    put(jobs+'/capacity_track_'+id,{complete:false,blocked:true,blockedReason:'snapshot_expired',
      baseVersion:versions.get(boards+'/'+id),readTime:new Date(start-3600000).toISOString()});
  }
  put(jobs+'/canonical_reconcile_v2',{activeFullRebuildTrackId:ids[0],pendingTrackIds:ids,pendingFullRebuildTrackIds:ids});
  put('0.6.2_s1_release_meta/current',{revision:1,builtRevision:1,dirty:false});
  put('0.6.2_s1_verification/hold',{slots:{a:{status:'unavailable',reason:'competitive_review',key:'exact-current-binding',retryAt:Number.MAX_SAFE_INTEGER}}});
  addJob('a',ids);
  const env={FIREBASE_PROJECT_ID:'profile-retry-offline',BACKGROUND_MAINTENANCE_MODE:'coordinated',ALLOWED_ORIGINS:origin,
    OPEN_BETA_ENABLED:'false',__TEST_UID:'owner',PB_NOTIFY_RATE_LIMITER:{limit:async()=>({success:true})},
    __TEST_FIRESTORE:async(path,init={})=>{
      stats.requests++;calls.push({path,body:init.body?JSON.parse(init.body):null});
      if(path===':runQuery'){
        await control.beforeQuery?.(JSON.parse(init.body).structuredQuery);
        const q=JSON.parse(init.body).structuredQuery, collection=q.from[0].collectionId, filter=q.where?.fieldFilter;
        if(collection===jobs){
          assert.equal(q.limit,1);assert.ok(['active','profileRetryAt'].includes(filter.field.fieldPath));
          let keys=[...data.keys()].filter(key=>key.startsWith(jobs+'/'));
          if(filter.field.fieldPath==='active')keys=keys.filter(key=>data.get(key).active===true).sort();
          else keys=keys.filter(key=>Number.isSafeInteger(data.get(key).profileRetryAt)&&data.get(key).profileRetryAt<=Number(filter.value.integerValue))
            .sort((a,b)=>data.get(a).profileRetryAt-data.get(b).profileRetryAt||a.localeCompare(b));
          queryCosts[filter.field.fieldPath==='active'?'activeQueries':'retryQueries']++;
          queryCosts.emptyMinimumReads+=keys.length?0:1;queryCosts.queryDocuments+=Math.min(q.limit,keys.length);
          stats.reads+=Math.max(1,Math.min(q.limit,keys.length));return keys.slice(0,q.limit).map(key=>({document:wire(key)}));
        }
        assert.equal(collection,races);assert.equal(q.limit,100);
        const account=filter.value.stringValue;
        const keys=[...data.keys()].filter(key=>key.startsWith(races+'/')&&data.get(key).accountId===account).sort();
        stats.reads+=Math.max(1,keys.length);return keys.map(key=>({document:wire(key)}));
      }
      if(path===':commit'){
        const writes=JSON.parse(init.body).writes;
        await control.beforeCommit?.(writes);
        for(const w of writes){const key=w.update.name.slice(base.length);
          assert.ok(w.currentDocument,'every mutable write has a fence');
          const condition=data.has(key)?{updateTime:versions.get(key)}:{exists:false};
          if(JSON.stringify(w.currentDocument)!==JSON.stringify(condition))throw Error('FIRESTORE_412');
        }
        const writeResults=writes.map(w=>{const key=w.update.name.slice(base.length);put(key,eventDecode({mapValue:{fields:w.update.fields}}));stats.writes++;return {updateTime:versions.get(key)};});
        commits.push(structuredClone(writes));await control.afterCommit?.(writes);return {writeResults};
      }
      assert.equal(init.method||'GET','GET');
      const key=decodeURIComponent(path.slice(1));await control.beforeRead?.(key);stats.reads++;queryCosts.pointReads++;
      return data.has(key)?wire(key):null;
    }};
  const turn=async n=>{
    now=start+n*900000;let done;
    api.default.scheduled({cron:'2-59/5 * * * *',scheduledTime:now},env,{waitUntil:p=>{done=p;}});await done;
  };
  const ready=(id,account='a')=>put(boards+'/'+id,{trackId:id,entries:[{accountId:account,name:'Old',timeMs:10000,pbAt:1000,
    uploadId:1,replayHash:'a'.repeat(64),runVerified:false,integrityVerified:true,identityUpdatedAt:1}],
    schemaVersion:6,algorithmVersion:'participation-v8-s1',complete:true,totalEntries:1,signature:'ready',revision:1,sourceRevision:1});
  const notify=async(account,name)=>{
    put('0.6.2_profiles_public/'+account,{...data.get('0.6.2_profiles_public/'+account),nickname:name});
    const tasks=[];const response=await api.handleRequest(new Request(origin+'/v1/profile/notify',{method:'POST',headers:{Origin:origin},body:JSON.stringify({accountId:account})}),env,{waitUntil:p=>tasks.push(p)});
    await Promise.all(tasks);return response;
  };
  return {data,stats,queryCosts,calls,commits,control,put,env,errors,addJob,ready,turn,notify,versions,
    snapshot:()=>structuredClone([...data]),now:()=>now};
}

for(const count of [1,4])test('full blocked-to-recovered pipeline for '+count+' tracks',async t=>{
  const ids=['one','two','three','four'].slice(0,count),f=fixture(t,ids),hold=structuredClone(f.data.get('0.6.2_s1_verification/hold'));
  const identity=structuredClone(f.data.get(jobKey('a')).identity);
  for(let i=0;i<96;i++)await f.turn(i);
  const blocked={...f.stats};
  assert.deepEqual(blocked,baseline ? (count===1?{reads:480,writes:0,requests:480}:{reads:672,writes:96,requests:768}) : (count===1?{reads:296,writes:26,requests:322}:{reads:472,writes:50,requests:522}));
  for(const id of ids)f.ready(id);
  const unblockedAt=f.now();
  let recovery=0;for(let n=96;n<120;n++){await f.turn(n);recovery++;if(!f.data.get(jobKey('a')).pendingTrackIds.length)break;}
  assert.ok(recovery<=4);assert.ok(f.now()-unblockedAt<=60*60000,'repair is observed within one hour in the nominal-cadence fixture');const job=f.data.get(jobKey('a'));
  assert.equal(job.active,false);assert.deepEqual(job.pendingTrackIds,[]);assert.equal(job.processed,count);
  assert.deepEqual(job.identity,identity);assert.deepEqual(f.data.get('0.6.2_s1_verification/hold'),hold);
  assert.equal(job.profileRetryAt,undefined);assert.equal(job.profileMaintenance,undefined);
  for(const id of ids){assert.equal(f.data.get(boards+'/'+id).entries[0].name,identity.name);assert.equal(f.data.get(boards+'/'+id).entries[0].runVerified,false);}
  const writes=f.stats.writes;await f.turn(120);await f.turn(121);assert.equal(f.stats.writes,writes);
  assert.deepEqual(f.errors,[]);
  assert.deepEqual(f.stats,baseline ? (count===1?{reads:485,writes:3,requests:487}:{reads:684,writes:106,requests:786}) : (count===1?{reads:310,writes:29,requests:338}:{reads:491,writes:60,requests:547}));
  assert.equal(f.stats.reads,f.queryCosts.pointReads+f.queryCosts.queryDocuments+f.queryCosts.emptyMinimumReads);
  process.stdout.write('PROFILE_RETRY_PIPELINE '+JSON.stringify({baseline,tracks:count,blocked,recoveryTurns:recovery,total:f.stats,queryCosts:f.queryCosts})+'\n');
});

test('healthy sibling progresses while first profile is blocked',async t=>{
  const f=fixture(t,['one']);f.addJob('z',['ready']);f.ready('ready','z');
  for(let n=0;n<8;n++)await f.turn(n);
  if(baseline){assert.equal(f.data.get(jobKey('z')).active,true);return;}
  assert.equal(f.data.get(jobKey('z')).active,false);assert.equal(f.data.get(boards+'/ready').entries[0].name,'Queued z');
  assert.deepEqual(f.data.get(jobKey('a')).pendingTrackIds,['one']);assert.deepEqual(f.errors,[]);
});

test('ready fourth track is not hidden behind three blocked tracks',async t=>{
  const f=fixture(t);f.ready('four');for(let n=0;n<4;n++)await f.turn(n);
  assert.equal(f.data.get(boards+'/four').entries[0].name,'Queued a');
  assert.equal(f.data.get(jobKey('a')).pendingTrackIds.includes('four'),false);
});

test('backoff preserves exact identity, bounded time and no unchanged heartbeat', {skip:baseline},async t=>{
  const f=fixture(t,['one']);await f.turn(0);await f.turn(1);await f.turn(2);
  const before={...f.stats},job=structuredClone(f.data.get(jobKey('a')));await f.turn(2);
  assert.equal(f.stats.writes,before.writes);assert.deepEqual(f.data.get(jobKey('a')),job);
  for(const entry of Object.values(job.profileMaintenance.entries))assert.ok(entry.retryAt-entry.attemptedAt<=PROFILE_RETRY_MAX_MS);
  assert.equal(f.stats.reads-before.reads,2,'only bounded queue queries, no board or build reads');
});

test('new explicit identity supersedes backoff and eventually publishes every queued track', {skip:baseline},async t=>{
  const f=fixture(t,['one']);await f.turn(0);await f.turn(1);f.ready('one');
  const response=await f.notify('a','Newest racer');assert.equal(response.status,202);
  assert.equal(f.data.get(boards+'/one').entries[0].name,'Newest racer');
  assert.equal(f.data.get(jobKey('a')).profileRetryAt,undefined);assert.equal(f.data.get(jobKey('a')).profileMaintenance,undefined);
});

test('checkpoint conflict cannot overwrite a newer queued identity or binding', {skip:baseline},async t=>{
  const f=fixture(t,['one']);let injected=false;
  f.control.beforeCommit=writes=>{if(!injected&&writes.some(w=>w.update.name.endsWith('/'+jobKey('a')))){
    injected=true;f.put(jobKey('a'),{...f.data.get(jobKey('a')),identity:{...f.data.get(jobKey('a')).identity,name:'New queued identity',identityUpdatedAt:start+1},signature:'new-signature',pendingTrackIds:['one','new-track']});
  }};
  await f.turn(0);assert.equal(f.errors.length,1);const job=f.data.get(jobKey('a'));
  assert.equal(job.identity.name,'New queued identity');assert.deepEqual(job.pendingTrackIds,['one','new-track']);assert.equal(job.profileMaintenance,undefined);
});

for(const lost of [false,true])test('failed or lost retry checkpoint recovers without loss: '+lost,{skip:baseline},async t=>{
  const f=fixture(t,['one']);let failed=false;
  const fail=writes=>{if(!failed&&writes.some(w=>w.update.name.endsWith('/'+jobKey('a')))){failed=true;throw Error('FIRESTORE_503');}};
  if(lost)f.control.afterCommit=fail;else f.control.beforeCommit=fail;
  await f.turn(0);assert.equal(f.errors.length,1);assert.deepEqual(f.data.get(jobKey('a')).pendingTrackIds,['one']);
  f.control.beforeCommit=null;f.control.afterCommit=null;f.ready('one');
  for(let n=1;n<8&&f.data.get(jobKey('a')).pendingTrackIds.length;n++)await f.turn(n);
  assert.deepEqual(f.data.get(jobKey('a')).pendingTrackIds,[]);assert.equal(f.data.get(boards+'/one').entries[0].name,'Queued a');
});

test('quota exhaustion leaves retry state and identity untouched without follow-up storage',{skip:baseline},async t=>{
  const f=fixture(t,['one']);const before=structuredClone(f.data.get(jobKey('a')));
  f.control.beforeRead=()=>{throw Error('FIRESTORE_429');};await f.turn(0);
  assert.deepEqual(f.data.get(jobKey('a')),before);assert.equal(f.stats.writes,0);assert.equal(f.errors.length,1);
});

test('retry hints reject changed identities, poisoned future times and unsafe clocks',()=>{
  const job={identity:{accountId:'a',name:'A'},signature:'sig'},now=start;
  const retry=profileRetryEntries(job,['one'],now);deferProfileTrack(retry.entries,'one',now);
  const saved={...job,profileMaintenance:{version:1,...retry}};
  assert.equal(profileRetryEntries(saved,['one'],now).entries.one.retryAt,now+900000);
  assert.equal(profileRetryEntries({...saved,identity:{...job.identity,name:'B'}},['one'],now).entries.one,undefined);
  assert.equal(profileRetryEntries(saved,['one'],now-1).entries.one,undefined);
  const poisoned=structuredClone(saved);poisoned.profileMaintenance.entries.one.retryAt=Number.MAX_SAFE_INTEGER;
  assert.equal(profileRetryEntries(poisoned,['one'],now).entries.one,undefined);
  for(const value of [NaN,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER])assert.throws(()=>profileRetryEntries(job,['one'],value),/CLOCK_INVALID/);
  const reordered={...saved,identity:{name:'A',accountId:'a'}};
  assert.deepEqual({...profileRetryEntries(reordered,['one'],now).entries.one},{...retry.entries.one});
});

test('unchanged explicit notification preserves valid deferred identity without discovery or heartbeat',{skip:baseline},async t=>{
  const f=fixture(t,['one']);await f.notify('a','Normalized');
  const before=structuredClone(f.data.get(jobKey('a'))),writes=f.stats.writes;
  const discoveries=f.calls.filter(c=>c.body?.structuredQuery?.from?.[0]?.collectionId===races).length;
  const response=await f.notify('a','Normalized');assert.equal(response.status,202);assert.equal((await response.json()).unchanged,true);
  assert.deepEqual(f.data.get(jobKey('a')),before);assert.equal(f.stats.writes,writes);
  assert.equal(f.calls.filter(c=>c.body?.structuredQuery?.from?.[0]?.collectionId===races).length,discoveries);
});

test('invalid deferred marker cannot suppress notification recovery',{skip:baseline},async t=>{
  const f=fixture(t,['one']);await f.notify('a','Normalized');
  f.put(jobKey('a'),{...f.data.get(jobKey('a')),profileRetryAt:Number.MAX_SAFE_INTEGER});
  f.ready('one');await f.notify('a','Normalized');
  assert.deepEqual(f.data.get(jobKey('a')).pendingTrackIds,[]);assert.equal(f.data.get(boards+'/one').entries[0].name,'Normalized');
});

test('newer queued identity invalidates retained retry hints even before their deadline',{skip:baseline},async t=>{
  const f=fixture(t,['one']);await f.turn(0);f.ready('one');
  f.put(jobKey('a'),{...f.data.get(jobKey('a')),active:true,signature:'new',identity:{...f.data.get(jobKey('a')).identity,name:'New queued',identityUpdatedAt:start+10}});
  await f.turn(0);assert.deepEqual(f.data.get(jobKey('a')).pendingTrackIds,[]);
  assert.equal(f.data.get(boards+'/one').entries[0].name,'New queued');
});

test('due retry progresses even while active siblings keep arriving',{skip:baseline},async t=>{
  const f=fixture(t,['one']);await f.turn(0);f.ready('one');
  for(let n=1;n<=2;n++){f.addJob('sibling'+n,['ready'+n]);f.ready('ready'+n,'sibling'+n);await f.turn(n);}
  assert.deepEqual(f.data.get(jobKey('a')).pendingTrackIds,[]);
  assert.equal(f.data.get(boards+'/one').entries[0].name,'Queued a');
});

test('failed lane query never falls through to more reads or changes queued work',{skip:baseline},async t=>{
  const f=fixture(t,['one']),before=f.snapshot();
  f.control.beforeQuery=()=>{throw Error('FIRESTORE_503');};await f.turn(0);
  assert.equal(f.stats.requests,1);assert.equal(f.stats.writes,0);assert.deepEqual(f.snapshot(),before);
  f.control.beforeQuery=null;f.ready('one');await f.turn(1);assert.deepEqual(f.data.get(jobKey('a')).pendingTrackIds,[]);
});

test('work-budget failure before a track check does not rotate or checkpoint untouched work',{skip:baseline},async t=>{
  const f=fixture(t),before=structuredClone(f.data.get(jobKey('a')));
  f.control.beforeRead=()=>{throw Error('OVERALL_REQUEST_BUDGET_EXHAUSTED');};await f.turn(0);
  assert.deepEqual(f.data.get(jobKey('a')),before);assert.equal(f.stats.writes,0);
  f.control.beforeRead=null;f.ready('four');for(let n=1;n<5;n++)await f.turn(n);
  assert.equal(f.data.get(boards+'/four').entries[0].name,'Queued a');
});

test('fresh newer source identity and PB binding survive a delayed old retry',{skip:baseline},async t=>{
  const f=fixture(t,['one']);await f.turn(0);f.ready('one');
  const current={...f.data.get(boards+'/one'),entries:[{...f.data.get(boards+'/one').entries[0],name:'New source',identityUpdatedAt:start+3600000,timeMs:9000,uploadId:2,replayHash:'b'.repeat(64),runVerified:false}]};
  f.put(boards+'/one',current);const hold=structuredClone(f.data.get('0.6.2_s1_verification/hold'));
  for(let n=1;n<8&&f.data.get(jobKey('a')).pendingTrackIds.length;n++)await f.turn(n);
  assert.deepEqual(f.data.get(boards+'/one'),current);assert.deepEqual(f.data.get('0.6.2_s1_verification/hold'),hold);
  assert.deepEqual(f.data.get(jobKey('a')).pendingTrackIds,[]);
});

test('a newer source racing publication rejects CAS and survives fresh recovery',{skip:baseline},async t=>{
  const f=fixture(t,['one']);f.ready('one');let raced=false;
  f.control.beforeCommit=writes=>{if(!raced&&writes.some(w=>w.update.name.endsWith('/'+boards+'/one'))){
    raced=true;f.put(boards+'/one',{...f.data.get(boards+'/one'),entries:[{...f.data.get(boards+'/one').entries[0],name:'Racing source',identityUpdatedAt:start+1}]});
  }};
  await f.turn(0);assert.equal(f.data.get(boards+'/one').entries[0].name,'Racing source');assert.equal(f.errors.length,1);
  f.control.beforeCommit=null;for(let n=1;n<8&&f.data.get(jobKey('a')).pendingTrackIds.length;n++)await f.turn(n);
  assert.equal(f.data.get(boards+'/one').entries[0].name,'Racing source');assert.deepEqual(f.data.get(jobKey('a')).pendingTrackIds,[]);
});

test('multi-track work remains below the shared 42-request plus checkpoint ceiling',{skip:baseline},async t=>{
  const f=fixture(t,Array.from({length:100},(_,i)=>'track'+i));
  for(let n=0;n<12;n++){const before=f.stats.requests;await f.turn(n);assert.ok(f.stats.requests-before<=43);}
  assert.equal(f.data.get(jobKey('a')).pendingTrackIds.length,100);
  assert.ok(JSON.stringify(f.data.get(jobKey('a'))).length<32000);
});

test('large blocked backlog yields the active lane before all tracks are inspected',{skip:baseline},async t=>{
  const f=fixture(t,Array.from({length:100},(_,i)=>'blocked'+i));f.addJob('z',['healthy']);f.ready('healthy','z');
  await f.turn(0);assert.equal(f.data.get(jobKey('a')).active,false);
  await f.turn(1);assert.equal(f.data.get(jobKey('z')).active,false);
  assert.equal(f.data.get(boards+'/healthy').entries[0].name,'Queued z');
  assert.equal(f.data.get(jobKey('a')).pendingTrackIds.length,100);
});

test('96 blocked turns with ready fourth track include all query minimums and eventual repair',async t=>{
  const f=fixture(t);f.ready('four');
  for(let n=0;n<96;n++)await f.turn(n);
  const blocked={...f.stats},blockedQueries={...f.queryCosts};
  assert.equal(f.data.get(boards+'/four').entries[0].name,'Queued a');
  assert.equal(f.data.get(jobKey('a')).pendingTrackIds.includes('four'),false);
  const unblockedAt=f.now();for(const id of ['one','two','three'])f.ready(id);
  for(let n=96;n<100&&f.data.get(jobKey('a')).pendingTrackIds.length;n++)await f.turn(n);
  assert.deepEqual(f.data.get(jobKey('a')).pendingTrackIds,[]);assert.ok(f.now()-unblockedAt<=60*60000);
  assert.equal(f.data.get(jobKey('a')).profileRetryAt,undefined);assert.equal(f.data.get(jobKey('a')).profileMaintenance,undefined);
  await f.turn(120);await f.turn(121);
  assert.equal(f.stats.reads,f.queryCosts.pointReads+f.queryCosts.queryDocuments+f.queryCosts.emptyMinimumReads);
  assert.deepEqual(blocked,baseline?{reads:673,writes:4,requests:676}:{reads:425,writes:52,requests:476});
  assert.deepEqual(f.stats,baseline?{reads:682,writes:11,requests:689}:{reads:442,writes:60,requests:498});
  process.stdout.write('PROFILE_READY_FOURTH_PIPELINE '+JSON.stringify({baseline,blocked,blockedQueries,total:f.stats,queryCosts:f.queryCosts})+'\n');
});

for(const kind of ['scheduled','notify'])test('missing legacy job updateTime never permits an unfenced write: '+kind,{skip:baseline},async t=>{
  const f=fixture(t,['one']);f.versions.delete(jobKey('a'));const before=f.snapshot();
  if(kind==='scheduled'){await f.turn(0);assert.equal(f.errors.length,1);assert.match(String(f.errors[0]),/PROFILE_JOB_PREIMAGE_REQUIRED/);}
  else await assert.rejects(f.notify('a','Changed'),/PROFILE_JOB_PREIMAGE_REQUIRED/);
  assert.equal(f.stats.writes,0);assert.deepEqual(f.data.get(jobKey('a')),new Map(before).get(jobKey('a')));
});

test('a new draft first commit drops both inherited retry fields, with exact job CAS',{skip:baseline},async t=>{
  const f=fixture(t,['one']);await f.notify('a','First draft');
  assert.ok(f.data.get(jobKey('a')).profileMaintenance);const previousVersion=f.versions.get(jobKey('a'));
  const at=f.commits.length;f.ready('one');await f.notify('a','Newest draft');
  const first=f.commits.slice(at).flat().find(w=>w.update.name.endsWith('/'+jobKey('a')));
  assert.deepEqual(first.currentDocument,{updateTime:previousVersion});
  const next=eventDecode({mapValue:{fields:first.update.fields}});
  assert.equal(next.identity.name,'Newest draft');assert.equal(next.profileRetryAt,undefined);assert.equal(next.profileMaintenance,undefined);
  assert.equal(f.data.get(boards+'/one').entries[0].name,'Newest draft');
});

test('new profile job creation cannot replace a concurrently created newer draft',{skip:baseline},async t=>{
  const f=fixture(t,['one']);f.data.delete(jobKey('a'));f.versions.delete(jobKey('a'));let raced=false;
  f.control.beforeCommit=writes=>{if(!raced&&writes.some(w=>w.update.name.endsWith('/'+jobKey('a')))){
    raced=true;f.put(jobKey('a'),{kind:'profile',active:true,accountId:'a',identity:{accountId:'a',name:'Concurrent newer',identityUpdatedAt:start+1},signature:'concurrent',pendingTrackIds:['one']});
  }};
  await assert.rejects(f.notify('a','Older racing request'),/FIRESTORE_412/);
  assert.equal(f.data.get(jobKey('a')).identity.name,'Concurrent newer');assert.equal(f.data.get(jobKey('a')).signature,'concurrent');
});
