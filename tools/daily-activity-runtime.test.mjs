import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as dailyModule from './daily-activity-sync.mjs';

const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const section=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);};
const copy=value=>value==null?value:JSON.parse(JSON.stringify(value));
const LOCAL='polytrack-0.6.3-daily-activity-local-v2';
const PENDING='polytrack-0.6.3-daily-activity-pending-v1';
const LEGACY='polytrack-0.6.2-daily-streak-v1';
const settle=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};

function harness(){
  let clock=Date.parse('2026-11-02T12:00:00Z'),account='account',user={uid:'owner'},best=0,cloud=null,upload=0;
  let afterDb=null,afterGet=null,dailyFailure=null,canonicalFailure=false,failStorage=false,quota=0;
  const disk=new Map(),listeners=new Map(),logs=[];
  const stats={db:0,reads:0,writes:0,canonicalReads:0,quota:0,locks:0,replays:0};
  class Clock extends Date {static now(){return clock;}}
  const listen=(name,fn)=>{const rows=listeners.get(name)||[];rows.push(fn);listeners.set(name,rows);};
  const database={collection:kind=>({doc:id=>({kind,id})})};
  const c={Date:Clock,Map,Set,WeakSet,Number,String,Boolean,Math,JSON,Array,Error,Promise,
    dailyModule,TRACK_CATALOG:new Map([['target',{id:'target',name:'Target',type:'official'}]]),
    activeRankedAccountId:()=>account,utcDayKey:(offset=0)=>new Date(clock+offset*86400000).toISOString().slice(0,10),
    window:{firebase:{auth:()=>({currentUser:user}),firestore:{FieldValue:{serverTimestamp:()=> 'server'}}},addEventListener:listen},
    document:{visibilityState:'visible',addEventListener:listen},navigator:{onLine:true,locks:{request:async(_key,fn)=>{stats.locks++;return fn();}}},
    localStorage:{getItem:key=>disk.get(key)??null,setItem:(key,value)=>{if(failStorage)throw Error('disk full');disk.set(key,String(value));}},
    compatibilityOnlineAllowed:true,FIREBASE_QUOTA_PAUSE_KEY:'quota',firebaseQuotaPaused:()=>clock<quota,
    readJsonStorage:(key,fallback)=>key==='quota'?quota:disk.has(key)?JSON.parse(disk.get(key)):fallback,
    noteFirebaseQuota:error=>{stats.quota++;if(/resource-exhausted/.test(error?.code||''))quota=clock+900000;},
    safeDisplayName:name=>name,getLastKnownName:()=> 'Racer',log:(...args)=>logs.push(args),
    COLLECTIONS:{dailyStreaks:'streaks',raceResults:'races',profilesPublic:'profiles'},
    db:async()=>{stats.db++;if(afterDb)await afterDb();return database;},
    runFirebaseTransaction:async(_database,callback)=>{
      const staged=[];
      const result=await callback({
        get:async ref=>{
          if(ref.kind==='streaks'){
            stats.reads++;assert.ok(disk.has(PENDING),'pending must be durable before document read');
            if(dailyFailure)throw Object.assign(Error(dailyFailure),{code:dailyFailure});
            const value=copy(cloud);if(afterGet)await afterGet();return {exists:!!value,data:()=>value};
          }
          stats.canonicalReads++;if(canonicalFailure)throw Object.assign(Error('canonical failed'),{code:'unavailable'});
          return {exists:false,data:()=>({})};
        },
        set:(ref,row)=>staged.push({ref,row:copy(row)})
      });
      for(const {ref,row} of staged)if(ref.kind==='streaks'){stats.writes++;cloud=row;}
      return result;
    },
    parsePayload:value=>value,accountIdFromPayload:async payload=>payload.accountId,guestAccountId:'account',
    LAST_ACTIVE_NAME_KEY:'name',sanitizeDisplayName:value=>value,enforceSafeDisplayName:async value=>value,setLastKnownName:()=>{},
    invalidateNativePartialReplayAccount:()=>{},__pt062NormalizeStyle:value=>value,__pt062RememberStyle:()=>{},
    safePositiveInt:value=>Number(value)||0,normalizeReplayPayloadString:value=>value,
    sha256Hex:async()=> 'a'.repeat(64),currentPlaytimeMs:()=>0,deploymentSourceOrigin:()=> 'fixture',
    lastMirrorSig:'',lastMirrorAt:0,nextUploadId:()=>++upload,readLocalRaceRows:()=>[],readTrackSnapshotCache:()=>null,
    canonicalRaceTimeMs:row=>row?.timeMs||0,localPersonalBestMs:()=>best,addLocalRaceRow:()=>true,
    writeRecordingStore:()=>{stats.replays++;},resolveManualNameOverride:async(_db,_id,name)=>name,readOverallSnapshotCache:()=>null,
    claimCloudProfileName:async(_db,_tx,_id,_uid,_profile,name)=>name,legacyNameTransactions:new WeakSet(),assertCloudOwner:()=>{},
    confirmedRecordingUploads:new Map(),showPublicNameAdjustment:()=>{},safeRecordingId:value=>value||null,
    rememberConfirmedLocalPb:()=>{},localPbSyncSignature:()=> 'signature',localPbCanonicalConflict:()=>false,
    LOCAL_PB_RECONCILE_STATE_KEY:'reconcile',writeJsonStorage:(key,value)=>{disk.set(key,JSON.stringify(value));return true;},
    saveClaimedPublicProfile:async()=> 'Racer',sendRankedNotification:async()=>{},syncExactCarPreview:async()=>{},
    OVERALL_PB_DIRTY_KEY:'dirty',overallLoadState:{},retainTrackSnapshotAfterLocalPb:()=>{},
    scheduleLocalPbCloudReconcile:()=>{},showCloudOwnerConflict:()=>{},opponentShortcutBoard:()=>null,opponentShortcutStatus:()=>{},
    isCurrentLocalPbReconcileIdentity:()=>true
  };
  vm.createContext(c);
  vm.runInContext(section("  const DAILY_ACTIVITY_LOCAL_KEY=",'  async function loadStreakLeader('),c);
  vm.runInContext('dailyActivityModulePromise=Promise.resolve(dailyModule);',c);
  vm.runInContext(section('  function localPbDrivingActive(','  function localBestRowsForAccount('),c);
  return {c,disk,stats,listeners,logs,cloud:()=>copy(cloud),
    local:()=>JSON.parse(disk.get(LOCAL)||'{"version":2,"buckets":[]}'),
    pending:()=>JSON.parse(disk.get(PENDING)||'{"version":1,"entries":[]}'),
    record:(track,time,pb)=>c.recordDailyActivity(track,time,pb,pb?10:0,account,'Racer'),
    run:async(time,track='target')=>{const result=await c.mirrorRaceResult('fixture',{accountId:account,trackId:track,frames:time,timeMs:time,recording:'replay-'+time,nickname:'Racer',carStyle:'style'});await settle();return result;},
    setBest:value=>{best=value;},switchAccount:value=>{account=value;},relogin:()=>{user={uid:'owner'};},
    setUser:value=>{user=value;},advance:ms=>{clock+=ms;},afterDb:fn=>{afterDb=fn;},afterGet:fn=>{afterGet=fn;},
    dailyFailure:value=>{dailyFailure=value;},canonicalFailure:value=>{canonicalFailure=value;},failStorage:value=>{failStorage=value;},
    resume:()=>c.syncDailyActivity(),flush:activity=>c.syncDailyActivity(activity)};
}

test('actual first-PB mirror path queues before canonical failure; slower third finish still completes',async()=>{
  const h=harness();h.canonicalFailure(true);
  const failed=await h.run(100);assert.equal(failed.saved,false);
  assert.equal(h.cloud().dayRuns,1);assert.equal(h.cloud().dayPbs,1);
  h.setBest(100);await h.run(120);assert.equal(h.stats.writes,1);
  await h.run(130);assert.equal(h.cloud().dayRuns,3);assert.equal(h.cloud().dayPbs,1);
  assert.equal(h.cloud().goalCompleted,true);assert.equal(h.stats.writes,2);
});

test('first PB on run two uses actual cumulative counters from both mirror finish paths',async()=>{
  const h=harness();h.setBest(100);await h.run(120);assert.equal(h.stats.db,0);
  await h.run(90);assert.equal(h.cloud().dayRuns,2);assert.equal(h.cloud().dayPbs,1);
  assert.equal(h.stats.reads,1);assert.equal(h.cloud().goalCompleted,false);
});

test('a pending goal transaction cannot block replay durability or canonical PB saving',async()=>{
  const h=harness();let release;const gate=new Promise(resolve=>{release=resolve;});
  h.afterGet(async()=>{assert.ok(h.stats.replays>0,'replay must be saved before streak read');await gate;});
  const result=await h.run(100);
  assert.equal(result.saved,true);assert.ok(h.stats.canonicalReads>=2);assert.ok(h.stats.replays>0);
  assert.equal(h.stats.writes,0);assert.equal(h.local().buckets[0].targetRuns,1);
  h.c.document.visibilityState='hidden';release();await settle();
  assert.equal(h.stats.writes,0);assert.equal(h.pending().entries[0].acknowledged,null);
});

test('closing before helper import completes leaves a durable bucket recoverable on page restoration',async()=>{
  const h=harness();vm.runInContext('dailyActivityModulePromise=new Promise(()=>{});',h.c);
  const result=await h.run(100);
  assert.equal(result.saved,true);assert.ok(h.stats.replays>0);assert.equal(h.disk.has(PENDING),false);
  assert.equal(h.local().buckets[0].targetPbs,1);
  const restored=harness();for(const [key,value] of h.disk)restored.disk.set(key,value);
  await restored.resume();assert.equal(restored.cloud().dayRuns,1);assert.equal(restored.cloud().dayPbs,1);
});

test('completion is durable when the prior first-PB attempt exhausted quota; visible resume recovers',async()=>{
  const h=harness();h.dailyFailure('resource-exhausted');h.canonicalFailure(true);
  await h.run(100);h.setBest(100);await h.run(120);await h.run(130);
  assert.equal(h.stats.reads,1);assert.equal(h.pending().entries[0].progress.targetRuns,3);
  assert.equal(h.pending().entries[0].acknowledged,null);
  h.advance(900000);h.dailyFailure(null);await h.resume();
  assert.equal(h.cloud().goalCompleted,true);assert.equal(h.cloud().dayPbs,1);
});

test('legacy unbound state stays untouched and another account never inherits its counters',async()=>{
  const h=harness(),legacy={activityDay:'2026-11-02',streak:99,targetRuns:999,targetPbs:99};
  h.disk.set(LEGACY,JSON.stringify(legacy));assert.equal(h.c.dailySpotlight().targetRuns,0);
  await h.flush(h.record('target',100,true));h.switchAccount('another');
  assert.equal(h.c.dailySpotlight().targetRuns,0);
  const activity=h.record('target',90,true);assert.equal(activity.targetRuns,1);assert.equal(activity.targetPbs,1);
  assert.equal(JSON.parse(h.disk.get(LEGACY)).targetRuns,999);
});

test('new-day display carries same-owner streak but no old daily counts or completion',async()=>{
  const h=harness();for(const [time,pb] of [[100,true],[120,false],[130,false]])await h.flush(h.record('target',time,pb));
  h.advance(86400000);const display=h.c.dailySpotlight();
  assert.equal(display.streak,1);assert.equal(display.runs,0);assert.equal(display.targetRuns,0);assert.equal(display.completed,false);
  const next=h.record('other',150,false);assert.equal(next.streak,1);assert.equal(next.targetRuns,0);
  h.switchAccount('another');assert.equal(h.c.dailySpotlight().streak,0);
});

for(const change of ['account','same-uid-login','day'])test(change+' during db initialization prevents all streak reads',async()=>{
  const h=harness(),activity=h.record('target',100,true);
  h.afterDb(()=>{if(change==='account')h.switchAccount('another');else if(change==='day')h.advance(86400000);else h.relogin();});
  assert.equal((await h.flush(activity)).status,'paused');
  assert.equal(h.stats.reads,0);assert.equal(h.stats.writes,0);assert.equal(h.pending().entries[0].acknowledged,null);
});

test('same-uid auth object replacement after get prevents write',async()=>{
  const h=harness();h.afterGet(()=>h.relogin());await h.flush(h.record('target',100,true));
  assert.equal(h.stats.reads,1);assert.equal(h.stats.writes,0);assert.equal(h.pending().entries[0].acknowledged,null);
});

for(const field of ['hidden','offline'])test(field+' milestone queues durably without initializing DB and resumes through existing hooks',async()=>{
  const h=harness();if(field==='hidden')h.c.document.visibilityState='hidden';else h.c.navigator.onLine=false;
  await h.flush(h.record('target',100,true));assert.equal(h.stats.db,0);assert.equal(h.pending().entries.length,1);
  h.c.document.visibilityState='visible';h.c.navigator.onLine=true;
  assert.ok(h.listeners.get('online').length);assert.ok(h.listeners.get('pageshow').length);assert.ok(h.listeners.get('visibilitychange').length);
  h.listeners.get(field==='hidden'?'visibilitychange':'online')[0]();
  for(let i=0;i<30;i++)await Promise.resolve();
  assert.equal(h.stats.reads,1);assert.equal(h.cloud().dayRuns,1);
});

test('no pending and non-target slower finishes never bootstrap Firebase',async()=>{
  const h=harness();await h.resume();assert.equal(h.stats.db,0);assert.equal(h.disk.has(PENDING),false);
  h.setBest(100);await h.run(120,'other');assert.equal(h.stats.db,0);assert.equal(h.disk.has(PENDING),false);
});

test('storage failure blocks streak cloud work and routes failure through quota notifier',async()=>{
  const h=harness();h.failStorage(true);
  assert.equal(h.record('target',100,true),null);await h.resume();assert.equal(h.stats.db,0);assert.ok(h.stats.quota>0);
  h.failStorage(false);const activity=h.record('target',100,true);h.failStorage(true);
  await h.flush(activity);assert.equal(h.stats.db,0);
});

test('past non-target-only days do not exhaust retained pending capacity; unbound history is never assigned an owner',async()=>{
  const h=harness();
  for(let i=0;i<70;i++){assert.ok(h.record('other',100,false));h.advance(86400000);}
  assert.ok(h.local().buckets.length<=1);assert.equal(h.stats.db,0);
  h.setUser(null);h.record('target',100,true);h.advance(86400000);h.setUser({uid:'owner'});
  const current=h.record('target',90,true);assert.equal(current.targetRuns,1);
  assert.ok(h.disk.has('polytrack-0.6.3-daily-activity-unbound-history-v1'));
  await h.flush(current);assert.equal(h.cloud().dayRuns,1);
});

test('64 genuinely unsynced bound target days are never evicted to admit a newer day',()=>{
  const h=harness();
  for(let i=0;i<64;i++){assert.ok(h.record('target',100,false));h.advance(86400000);}
  const before=h.disk.get(LOCAL);
  assert.equal(h.record('target',100,false),null);
  assert.equal(h.disk.get(LOCAL),before);assert.equal(h.local().buckets.length,64);
  assert.ok(h.logs.some(args=>String(args).includes('full of retained unsynced')));assert.equal(h.stats.db,0);
});

test('unbound local-only history has a separate explicit 64-bucket retention cap',()=>{
  const h=harness();h.setUser(null);
  for(let i=0;i<70;i++){assert.ok(h.record('target',100,true));h.advance(86400000);}
  const history=JSON.parse(h.disk.get('polytrack-0.6.3-daily-activity-unbound-history-v1'));
  assert.equal(history.buckets.length,64);assert.ok(history.buckets.every(bucket=>bucket.ownerUid===''));
  assert.equal(h.local().buckets.length,1);assert.ok(h.logs.some(args=>String(args).includes('STREAK_HISTORY_RETENTION')));
  assert.equal(h.stats.db,0);
});

test('actual runtime import is versioned and the daily section adds no polling timer',()=>{
  const daily=section("  const DAILY_ACTIVITY_LOCAL_KEY=",'  async function loadStreakLeader(');
  assert.match(daily,/import\('\.\/tools\/daily-activity-sync\.mjs\?v=\d+'\)/);
  assert.doesNotMatch(daily,/setInterval|setTimeout|ensureFirestoreBootstrap/);
});
