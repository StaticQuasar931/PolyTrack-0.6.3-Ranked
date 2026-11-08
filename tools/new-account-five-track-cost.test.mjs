import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {Socket} from 'node:net';
import worker,{computeTrackEntries,reconcileCanonicalChanges} from '../workers/ranked/src/index.js';
import {preparePublicationPages,loadPublicationEntries} from '../workers/ranked/src/paged-publication.js';
import {eventRuntime,consumeEventInbox} from '../workers/ranked/src/events-runtime.js';
import {eventPeriod,EVENT_COLLECTIONS as E} from '../workers/ranked/src/events.js';
import {eventEncode,eventDecode} from '../workers/ranked/src/events-store.js';
import {VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION} from '../workers/ranked/src/verification.js';
import {utcEventCandidates} from '../events/schedule.mjs';
import {keepEventBest,matchingEventRuns} from '../events/session.mjs';
import {createEventSubmissionRetry,sameEventSubmission} from '../events/client.mjs';
import {claimProfileNameWithLegacyBridge} from './unique-profile-name.mjs';
import {createFirebaseAuthApp} from './firebase-auth-app.mjs';
import * as dailyModule from './daily-activity-sync.mjs';

// Actual client functions and Worker services, but synthetic finishes, identity,
// snapshots and verdicts. This is not browser gameplay or a physics verification.
const blocked=()=>{throw Error('JOURNEY_NETWORK_FORBIDDEN');};
globalThis.fetch=blocked;Socket.prototype.connect=blocked;
const rawPatch=readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const patch=rawPatch.replace(/\r\n/g,'\n');
const eventClient=readFileSync(new URL('../events/client.mjs',import.meta.url),'utf8');
const config=JSON.parse(readFileSync(new URL('../workers/ranked/wrangler.jsonc',import.meta.url),'utf8'));
const localCatalog=JSON.parse(readFileSync(new URL('../events/public-catalog.json',import.meta.url),'utf8'));
const account='e'.repeat(64),owner='journey-owner',origin='https://journey.invalid';
const accountId=account;
const docBase='projects/journey-offline/databases/(default)/documents/';
const start=Date.UTC(2026,10,4,9,30);
const sha=value=>createHash('sha256').update(value).digest('hex');
const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
function section(text,from,to){const a=text.indexOf(from),b=text.indexOf(to,a+from.length);assert.ok(a>=0&&b>a,from);return text.slice(a,b);}
function fn(text,name){
  const at=text.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert.ok(at>=0,name);
  const tail=text.slice(at);
  for(const end of tail.matchAll(/\n  }[^\n]*/g)){
    const candidate=tail.slice(0,end.index+end[0].length);
    try{new vm.Script(candidate);return candidate;}catch(error){if(!(error instanceof SyntaxError))throw error;}
  }
  assert.fail('Unterminated production function '+name);
}

function fixture(t,{edge='healthy'}={}){
  t.mock.method(console,'log',()=>{});t.mock.method(console,'error',()=>{});
  let clock=start,user=null,serial=0,upload=0,step='setup',sdkFailure=null,edgeMode=edge;
  const data=new Map(),versions=new Map(),disk=new Map(),localRows=[],recordings=new Map(),events=[],tasks=new Set();
  const http=[],snapshotReads=[],timers=new Map(),sdkLoads=[],diagnostics=[];let timer=0;
  class Clock extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  t.mock.method(Date,'now',()=>clock);
  const note=(lane,op,key,count=1,status='ok')=>events.push({step,lane,op,key,count,status});
  const version=key=>versions.get(key)||'';
  const put=(key,value)=>{data.set(key,clone(value));versions.set(key,new Date(start+ ++serial).toISOString());};
  const wire=(key,source=data,vs=versions)=>source.has(key)?{name:docBase+key,
    fields:eventEncode(source.get(key)).mapValue.fields,updateTime:vs.get(key)}:null;
  const trackTask=promise=>{tasks.add(promise);promise.finally(()=>tasks.delete(promise)).catch(()=>{});return promise;};
  const failSdk=(op,key)=>{
    if(!sdkFailure||sdkFailure.remaining===0||sdkFailure.op!==op||sdkFailure.collection&&!key.startsWith(sdkFailure.collection+'/'))return;
    if(sdkFailure.remaining>0)sdkFailure.remaining--;
    note('sdk','failed-'+op,key,null,sdkFailure.code);
    throw Object.assign(Error(sdkFailure.code),{code:sdkFailure.code});
  };
  const snap=key=>{const value=clone(data.get(key));return {exists:data.has(key),data:()=>value,metadata:{fromCache:false}};};
  const database={collection:collection=>({doc:id=>({collection,id,key:collection+'/'+id,
    get:async()=>{const key=collection+'/'+id;failSdk('read',key);note('sdk','read',key);return snap(key);},
    set:async(value,options)=>{const key=collection+'/'+id;failSdk('write',key);put(key,options?.merge?{...data.get(key),...value}:value);note('sdk','write',key);}})}),
    settings(){},runTransaction:async callback=>{
      const staged=[];let writing=false;
      const result=await callback({get:async ref=>{assert.equal(writing,false,'SDK reads precede writes');failSdk('read',ref.key);note('sdk','read',ref.key);return snap(ref.key);},
        set:(ref,value,options)=>{writing=true;staged.push({op:'write',ref,value,options});},
        delete:ref=>{writing=true;staged.push({op:'delete',ref});}});
      for(const write of staged)failSdk('write',write.ref.key);
      for(const write of staged){const key=write.ref.key;if(write.op==='delete'){data.delete(key);versions.delete(key);}
        else put(key,write.options?.merge?{...data.get(key),...write.value}:write.value);note('sdk',write.op,key);}
      return result;
    }};
  const transactions=new Map();
  const queryValue=value=>{const decoded=value.referenceValue??eventDecode(value);return decoded?.__firestoreTimestamp||decoded;};
  function match(value,filter){
    if(!filter)return true;
    if(filter.compositeFilter)return filter.compositeFilter.filters.every(item=>match(value,item));
    const f=filter.fieldFilter,actual=value[f.field.fieldPath],wanted=eventDecode(f.value);
    const a=actual?.__firestoreTimestamp||actual,b=wanted?.__firestoreTimestamp||wanted;
    return f.op==='EQUAL'?a===b:f.op==='GREATER_THAN_OR_EQUAL'?a>=b:f.op==='LESS_THAN_OR_EQUAL'?a<=b:false;
  }
  const request=async(route,init={})=>{
    const body=init.body?JSON.parse(init.body):null;http.push({step,route});
    if(route===':beginTransaction'){
      const id='tx-'+ ++serial;transactions.set(id,{data:structuredClone(data),versions:new Map(versions),reads:new Set()});return {transaction:id};
    }
    if(route===':rollback'){assert.ok(transactions.delete(body.transaction));return {};}
    if(route===':batchGet')return body.documents.map(name=>{const key=name.slice(docBase.length);note('worker','read',key);const found=wire(key);return found?{found}:{missing:name};});
    if(route===':runQuery'){
      const q=body.structuredQuery,collection=q.from[0].collectionId;
      const sortFields=q.orderBy?.map(item=>item.field.fieldPath)||['__name__'];
      const values=([key,value])=>sortFields.map(field=>field==='__name__'?docBase+key:value[field]?.__firestoreTimestamp||value[field]);
      const compare=(a,b)=>{for(let i=0;i<Math.min(a.length,b.length);i++){if(a[i]!==b[i])return a[i]<b[i]?-1:1;}return 0;};
      let rows=[...data].filter(([key,value])=>key.startsWith(collection+'/')&&match(value,q.where)).sort((a,b)=>compare(values(a),values(b)));
      if(q.startAt){const cursor=q.startAt.values.map(queryValue);rows=rows.filter(row=>compare(values(row),cursor)>=(q.startAt.before?0:1));}
      if(q.endAt){const cursor=q.endAt.values.map(queryValue);rows=rows.filter(row=>compare(values(row),cursor)<(q.endAt.before?0:1));}
      rows=rows.slice(0,q.limit||100);note('worker','query',collection,Math.max(1,rows.length));
      return rows.length?rows.map(([key])=>({document:wire(key),readTime:new Date(clock).toISOString()})):[{readTime:new Date(clock).toISOString()}];
    }
    if(route===':commit'){
      const tx=body.transaction?transactions.get(body.transaction):null;if(body.transaction)assert.ok(tx);
      for(const w of body.writes){const key=(w.update?.name||w.delete).slice(docBase.length);
        if(w.currentDocument?.exists===false)assert.equal(data.has(key),false,key);
        if(w.currentDocument?.updateTime)assert.equal(w.currentDocument.updateTime,version(key),'Worker CAS '+key);
        if(tx&&w.currentDocument?.updateTime)assert.ok(tx.reads.has(key),'transaction preimage '+key);
      }
      const results=body.writes.map(w=>{const key=(w.update?.name||w.delete).slice(docBase.length);
        if(w.delete){data.delete(key);versions.delete(key);note('worker','delete',key);}
        else{let value=eventDecode({mapValue:{fields:w.update.fields}});if(w.updateMask)value={...data.get(key),...value};
          for(const tr of w.updateTransforms||[])value[tr.fieldPath]={__firestoreTimestamp:new Date(clock).toISOString()};
          put(key,value);note('worker','write',key);}
        return {updateTime:version(key)||new Date(clock).toISOString()};});
      if(tx)transactions.delete(body.transaction);return {writeResults:results};
    }
    const url=new URL('https://offline.invalid'+route),key=decodeURIComponent(url.pathname.slice(1));
    if(init.method==='PATCH'){put(key,eventDecode({mapValue:{fields:body.fields}}));note('worker','write',key);return {updateTime:version(key)};}
    const txId=url.searchParams.get('transaction'),tx=txId?transactions.get(txId):null;
    if(txId){assert.ok(tx);tx.reads.add(key);}note('worker','read',key);
    return tx?wire(key,tx.data,tx.versions):wire(key);
  };
  const env={...config.vars,FIREBASE_PROJECT_ID:'journey-offline',ALLOWED_ORIGINS:origin,OPEN_BETA_ENABLED:'false',
    __TEST_UID:owner,__TEST_FIRESTORE:request,PB_NOTIFY_RATE_LIMITER:{limit:async()=>({success:true})},
    WRITE_IP_RATE_LIMITER:{limit:async()=>({success:true})},PUBLIC_READ_RATE_LIMITER:{limit:async()=>({success:true})},
    EVENT_RATE_LIMITER:{limit:async()=>({success:true})}};
  const runtime=eventRuntime(request,{projectId:'journey-offline',now:()=>clock});
  const ls={getItem:key=>disk.get(key)??null,setItem:(key,value)=>disk.set(key,String(value)),removeItem:key=>disk.delete(key)};
  const sdk={apps:[],auth:()=>({currentUser:user}),firestore:{FieldValue:{serverTimestamp:()=>({__firestoreTimestamp:new Date(clock).toISOString()})}},
    initializeApp(){this.apps.push({});return app;},app:()=>app};
  const app={auth:()=>({get currentUser(){return user;},signInAnonymously:async()=>{user={uid:owner,getIdToken:async()=> 'synthetic-token'};}}),firestore:()=>database};
  const c={Date:Clock,Intl,crypto:webcrypto,TextEncoder,URL,Headers,Request,Response,Promise,Map,Set,WeakSet,JSON,Math,Number,String,Array,Error,
    window:{firebase:sdk,addEventListener(){}},document:{visibilityState:'visible',addEventListener(){},getElementById:()=>null,querySelectorAll:()=>[]},
    navigator:{onLine:true,locks:{request:async(_key,options,work)=>typeof options==='function'?options():work({})}},localStorage:ls,
    setTimeout:(callback,delay)=>{const id=++timer;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id),
    FIREBASE_QUOTA_PAUSE_KEY:'quota',MODERATION_REFRESH_MS:600000,firestorePromise:null,firebaseRetryAt:0,
    compatibilityOnlineAllowed:true,assertOnlineCompatibility(){},observeFirestore:async value=>value,
    loadScript:async url=>{sdkLoads.push(url);},legacyNameTransactions:new WeakSet(),
    profileNameModulePromise:Promise.resolve({claimProfileNameWithLegacyBridge}),moderationDecision:()=>({blocked:false}),
    profileIdentityPostSequence:0,profileIdentityPostTail:Promise.resolve(),profileIdentityAcknowledgement:null,
    manualModerationCache:new Map(),manualModerationRequests:new Map(),cloudOwnerConflicts:new Map(),
    activeRankedAccountId:()=>ls.getItem('polytrack-0.6.2-active-account-id')||account,
    accountIdFromPayload:async value=>value.accountId||account,guestAccountId:account,parsePayload:value=>value,
    cleanUserId:value=>String(value||''),sanitizeDisplayName:value=>String(value||''),enforceSafeDisplayName:async value=>value,
    getOrCreateDefaultDisplayName:()=> 'Journey Racer',getLastKnownName:()=>ls.getItem('name')||'Journey Racer',setLastKnownName:(_id,name)=>ls.setItem('name',name),
    LAST_ACTIVE_NAME_KEY:'name',__pt062NormalizeStyle:value=>String(value||''),getDefaultCarStyle:()=> 'fixture-style',__pt062RememberStyle(){},
    safeDisplayName:value=>String(value||''),showPublicNameAdjustment(){},showCloudOwnerConflict(){},invalidateNativePartialReplayAccount(){},log:(...args)=>diagnostics.push(args),
    readJsonStorage:(key,fallback)=>disk.has(key)?JSON.parse(disk.get(key)):clone(fallback),
    writeJsonStorage:(key,value)=>{disk.set(key,JSON.stringify(value));return true;},
    readLocalRaceRows:()=>localRows,addLocalRaceRow:row=>{const index=localRows.findIndex(old=>old.accountId===row.accountId&&old.trackId===row.trackId);
      if(index<0)localRows.push(clone(row));else if(localRows[index].timeMs>=row.timeMs)localRows[index]=clone(row);return true;},
    localPersonalBestMs:(trackId,id)=>localRows.find(row=>row.trackId===trackId&&row.accountId===id)?.timeMs||0,
    readRecordingStore:ids=>ids.map(id=>recordings.get(id)).filter(Boolean),writeRecordingStore:(id,value)=>{recordings.set(id,clone(value));},
    nextUploadId:()=>++upload,sha256Hex:async value=>sha(value),canonicalRaceTimeMs:row=>Number(row?.timeMs)||0,
    safePositiveInt:(value,fallback=0)=>Number(value)>0?Number(value):fallback,safeRecordingId:value=>Number(value)>0?Number(value):null,
    normalizeReplayPayloadString:value=>String(value||''),currentPlaytimeMs:()=>60000, deploymentSourceOrigin:()=> 'offline-journey-fixture',
    lastMirrorSig:'',lastMirrorAt:0,confirmedRecordingUploads:new Map(),
    LOCAL_PB_RECONCILE_STATE_KEY:'reconcile',OVERALL_PB_DIRTY_KEY:'dirty',overallLoadState:{},
    localPbReconcilePromises:new Map(),localPbReconcileTimers:new Map(),
    readTrackSnapshotCache:()=>null,readOverallSnapshotCache:()=>null,retainTrackSnapshotAfterLocalPb(){},
    opponentShortcutBoard:()=>null,opponentShortcutStatus(){},PUBLIC_STANDINGS_SNAPSHOT_ONLY:true,
    snapshotRefreshState:()=>({locked:true}),rememberSnapshotAccountAge(){},makeUserPayload:value=>({accountId,...value}),
    readPublicSnapshotBackup:async(kind,id)=>{snapshotReads.push({step,kind,id});return {accountId:kind==='profile'?id:undefined,entries:[],source:'synthetic-static-snapshot'};},
    rankedBrokerUrl:()=>origin,rankedEdgeAvailable:()=>edgeMode!=='offline',clearRankedEdgeFailure(){},markRankedEdgeUnavailable(){},rankedEdgeState:{},
    RANKED_NOTIFY_QUEUE_KEY:'ranked-notify',rankedNotifyQueue:()=>c.readJsonStorage('ranked-notify',[]),
    getCarThumbRenderer:()=>async()=> 'data:image/png;base64,AAAA',normalizeThumbResult:value=>value,
    eventRequestSignal:()=>undefined,medalForRank:()=>null,preciseAgeLabel:()=> 'fixture',utcDayKey:offset=>new Date(clock+(offset||0)*86400000).toISOString().slice(0,10),
    utcWeekKey:()=>new Date(clock-((new Date(clock).getUTCDay()+6)%7)*86400000).toISOString().slice(0,10)};
  vm.createContext(c);
  const collectionsAt=patch.indexOf('  const COLLECTIONS =');
  vm.runInContext(patch.slice(collectionsAt,patch.indexOf('\n  });',collectionsAt)+6),c);
  vm.runInContext(section(patch,'  const TRACK_CATALOG =','  const LEGACY_TRACK_CATALOG')+'\nthis.catalogForAudit=TRACK_CATALOG;',c);
  c.ensureFirebaseAuthApp=createFirebaseAuthApp({window:c.window,loadScript:c.loadScript,resolveFirebaseConfig:async()=>({projectId:'journey-offline'}),waitForInitialAuth:async()=>{},assertOnlineCompatibility:()=>{}});
  c.rankedFetch=async(url,options)=>{
    assert.equal(new URL(url).origin,origin);http.push({step,route:new URL(url).pathname});
    if(edgeMode==='403')return Response.json({error:'synthetic-network-filter'},{status:403});
    const response=await worker.fetch(new Request(url,{...options,headers:{...options.headers,Origin:origin,'CF-Connecting-IP':'127.0.0.1'}}),env,{waitUntil:trackTask});
    diagnostics.push({route:new URL(url).pathname,status:response.status,body:await response.clone().json()});return response;
  };
  for(const name of ['firebaseQuotaRetryAt','firebaseQuotaPaused','noteFirebaseQuota','db','runFirebaseTransaction','resolveManualNameOverride',
    'assertCloudOwner','syncAcknowledgedPublicIdentity','claimCloudProfileName','saveClaimedPublicProfile','mockPayload',
    'mirrorRaceResult','syncExactCarPreview','queueRankedNotification','sendRankedNotification','sendRankedProfileNotification','snapshotOnlyForNewAccount'])
    vm.runInContext(fn(patch,name),c);
  vm.runInContext(section(patch,"  const DAILY_ACTIVITY_LOCAL_KEY=",'  async function loadStreakLeader('),c);
  vm.runInContext(section(patch,'  function localBestRowsForAccount(','  function hookLegacyNetworking('),c);
  vm.runInContext('dailyActivityModulePromise=Promise.resolve(dailyModule);',vm.createContext(Object.assign(c,{dailyModule})));
  const originalDaily=c.syncDailyActivity;c.syncDailyActivity=(...args)=>trackTask(originalDaily(...args));
  c.updateOverallIdentity=async(_db,id)=>c.sendRankedProfileNotification(id); // UI/cache mutation is local; execute the actual paid notification.
  const catalog=[...c.catalogForAudit.values()],official=catalog.filter(track=>track.type==='official').map(track=>track.id);
  const candidates=utcEventCandidates(clock,official,catalog.map(track=>track.id));
  const weeklyIndex=(Number(c.utcWeekKey().replaceAll('-',''))*17+11)%catalog.length;
  const kodubTrack=localCatalog.periods.find(period=>period.kind==='kodub').trackId;
  const roles=[{role:'normal-daily-spotlight',trackId:c.dailyActivityIdentity().targetTrackId},
    {role:'normal-weekly-cup',trackId:catalog[weeklyIndex].id},...candidates.map(period=>({role:'finite-'+period.kind,trackId:period.trackId})),
    {role:'kodub-fixture',trackId:kodubTrack}];
  const selected=[...new Set(roles.map(row=>row.trackId))];for(const id of official)if(selected.length<5&&!selected.includes(id))selected.push(id);
  assert.equal(selected.length,5,'the bounded journey must cover five distinct tracks');
  const code='PolyTrack2'+'A'.repeat(128),endsAt=Date.UTC(2026,10,8,12);
  const periodInputs=[...candidates,{id:'kodub_'+endsAt,kind:'kodub',trackId:kodubTrack,startsAt:endsAt-7*86400000,endsAt,maxRp:700,
    kodub:{source:'kodub-v6-track-of-the-week',trackCode:code,trackCodeHash:sha(code),officialTrackAssetHash:sha(code),officialEndTime:endsAt,
      officialFastestVerifiedMs:20000,name:'Synthetic Kodub period; local track pin',author:'Fixture',environment:0}}];
  const periods=periodInputs.map(p=>eventPeriod({...p,enabled:true,graceMs:86400000,targetMs:20000,
    eligibility:'best-submitted-during-period',capacity:JSON.parse(config.vars.EVENT_CAPACITY_JSON)}));
  for(const p of periods){put(E.periods+'/'+p.id,p);put(E.queues+'/'+p.id,{slots:[],runIds:[],subjects:[],admitted:0,entrants:0,replayBytes:0,storageVersion:2,retentionCount:0,retentionPages:0});
    put(E.public+'/'+p.id,{period:p,entries:[],pendingPlaybacks:[],racerCount:0,revision:1});}
  put(E.catalog+'/main',{periods});put(E.public+'/totals',{entries:[],revision:1,publicationPending:false,pendingPeriodIds:[]});
  put('0.6.2_s1_leaderboards_overall/main',{entries:[],complete:true});
  put('0.6.2_s1_release_meta/current',{revision:1,builtRevision:1,dirty:false});
  put('0.6.2_s1_worker_jobs/canonical_reconcile_v2',{backfillComplete:true,schemaVersion:2,pendingTrackIds:[],pendingResultIds:{},pendingFullRebuildTrackIds:[]});
  for(const id of selected)put('0.6.2_s1_leaderboards_track/'+id,{trackId:id,entries:[],totalEntries:0,sourceComplete:true,complete:true,revision:1,
    algorithmVersion:'participation-v8-s1',schemaVersion:6,signature:'synthetic-existing-board'});
  const eventStore='polytrack-062-events-v1',eventDiskKey=eventStore+'-queue',eventRetryKey=eventStore+'-submission-retry-v1';
  Object.assign(c,{now:()=>clock,bridge:{accountId:()=>account},sessions:{current:()=>null},eventIntent:null,archiveIntent:null,latestFinish:null,
    catalog:{periods},knownPeriods:new Map(periods.map(p=>[p.id,p])),bestRecords:{},hasPending:false,flushing:false,
    STORE:eventStore,QUEUE:eventDiskKey,BEST:'event-best',REPLAYS:'event-replays',matchingEventRuns,keepEventBest,sameEventSubmission,cache:new Map(),
    read:(key,fallback)=>c.readJsonStorage(key,fallback),write:(key,value)=>c.writeJsonStorage(key,value),cacheWrite:(key,value)=>c.writeJsonStorage(key,value),
    invalidateReceipt(){},message(){},tick(){}});
  c.submissionRetry=createEventSubmissionRetry({now:()=>clock,random:()=>0,
    load:()=>c.readJsonStorage(eventRetryKey,null),save:value=>c.writeJsonStorage(eventRetryKey,value)});
  const submitStart=patch.indexOf('submit:async run=>{'),submitEnd=patch.indexOf('\n        }\n',submitStart);
  assert.ok(submitStart>0&&submitEnd>submitStart);
  c.bridge.submit=vm.runInContext('('+patch.slice(submitStart+'submit:'.length,submitEnd+'\n        }'.length)+')',c);
  vm.runInContext(fn(eventClient,'flush')+'\n'+fn(eventClient,'captured'),c);
  const originalFlush=c.flush;c.flush=()=>trackTask(originalFlush());
  const settle=async()=>{for(let i=0;i<20;i++){await Promise.resolve();if(tasks.size)await Promise.all([...tasks]);}assert.equal(tasks.size,0);};
  const totals=(since=0)=>events.slice(since).reduce((sum,event)=>{if(event.op==='read'||event.op==='query')sum.reads+=event.count;
    if(event.op==='write')sum.writes+=event.count;if(event.op==='delete')sum.deletes+=event.count;
    if(event.op.startsWith('failed-'))sum.failedAttempts++;return sum;},{reads:0,writes:0,deletes:0,failedAttempts:0});
  const stages=[];
  const phase=async(label,work)=>{step=label;const from=events.length,requests=http.length,snapshots=snapshotReads.length;
    const result=await work();await settle();stages.push({label,...totals(from),workerRequests:http.length-requests,snapshotReads:snapshotReads.length-snapshots});return result;};
  const finish=async(trackId,timeMs,{capture=true}={})=>{
    clock+=10000;const run={accountId,trackId,timeMs,frames:timeMs,recording:Buffer.from('synthetic-not-physics-'+trackId+'-'+timeMs).toString('base64url'),nickname:'Journey Racer',carStyle:'fixture-style'};
    const saved=await c.mirrorRaceResult('synthetic-finish',run);
    if(capture)c.captured({...run,replay:run.recording,raceId:'fixture-car-'+ ++serial});await settle();return saved;
  };
  const drainInbox=async()=>{for(let i=0;i<16;i++){const result=await consumeEventInbox(runtime);if(!result.consumed)return;}assert.fail('bounded intake did not quiesce');};
  const verdicts=async()=>{for(const p of periods)await runtime.service.processBatch(p.id,async jobs=>jobs.map(job=>({resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,
    replayHash:job.replayHash,status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,binding:{resultId:job.resultId,trackId:job.trackId,nativeTrackId:job.trackId,
      timeMs:job.timeMs,replayHash:job.replayHash,actualReplayHash:job.replayHash,engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,
      ...(p.kind==='kodub'?{trackContentHash:p.kodub.trackCodeHash}:{})}})));};
  events.length=0;http.length=0;
  return {c,data,disk,events,stages,http,snapshotReads,localRows,recordings,sdkLoads,periods,selected,roles,runtime,env,phase,finish,settle,totals,drainInbox,verdicts,diagnostics,put,transactions,
    profilePost:()=>c.mockPayload(new URL(origin+'/user'),'POST',{accountId,nickname:'Journey Racer',carStyle:'fixture-style'}),
    profileGet:()=>c.mockPayload(new URL(origin+'/user'),'GET',{accountId}),
    rename:()=>c.mockPayload(new URL(origin+'/user'),'POST',{accountId,nickname:'Renamed Journey',carStyle:'fixture-style'}),
    reconcile:()=>c.reconcileLocalPersonalBestsToCloud(account),advance:ms=>{clock+=ms;},setEdge:value=>{edgeMode=value;},
    now:()=>clock,eventRetryAt:()=>{const ledger=c.readJsonStorage(eventRetryKey,null);assert.ok(ledger,'retry state must be persisted');
      return Math.max(ledger.quotaUntil||0,...Object.values(ledger.accounts).map(row=>row.nextAt),...Object.values(ledger.attempts).map(row=>row.nextAt));},
    fail:(code,collection,remaining=1,op='read')=>{sdkFailure=code?{code,collection,remaining,op}:null;},
    queue:()=>c.readJsonStorage(eventDiskKey,[]),clearConfirmations:()=>disk.delete('reconcile'),
    report:scenario=>process.stdout.write('FIVE_TRACK_JOURNEY '+JSON.stringify({scenario,headFixture:'synthetic-not-gameplay',executedClientSha256:sha(rawPatch),roles,
      tracks:selected.map(id=>({id,name:catalog.find(track=>track.id===id)?.name||'Local Kodub track pin'})),stages,total:totals(),
      byLane:['sdk','worker'].map(lane=>({lane,reads:events.filter(e=>e.lane===lane&&(e.op==='read'||e.op==='query')).reduce((n,e)=>n+e.count,0),
        writes:events.filter(e=>e.lane===lane&&e.op==='write').length,deletes:events.filter(e=>e.lane===lane&&e.op==='delete').length})),
      byCollection:[...new Set(events.map(event=>event.key.split('/')[0]))].sort().map(collection=>{
        const rows=events.filter(event=>event.key.split('/')[0]===collection);return {collection,
          reads:rows.filter(row=>row.op==='read'||row.op==='query').reduce((n,row)=>n+row.count,0),
          writes:rows.filter(row=>row.op==='write').length,deletes:rows.filter(row=>row.op==='delete').length,
          failedAttempts:rows.filter(row=>row.op.startsWith('failed-')).length};}),
      localPbs:localRows.length,localReplays:recordings.size,pendingEventOutbox:c.readJsonStorage(eventDiskKey,[]).length,
      failedBilling:'unknown; failed attempts are not counted as zero billable reads',excluded:'actual auth/network, SDK retries, rules/index reads, physics, scheduled Overall/event publication, real browser UI'})+'\n')};
}

async function waitForEventRetry(f){
  const deadline=f.eventRetryAt();assert.ok(deadline>f.now(),'recovery must respect a future persisted deadline');
  const before=f.totals(),pending=f.queue();
  f.advance(deadline-f.now()-1);await f.c.flush();await f.settle();
  assert.deepEqual(f.totals(),before,'no paid attempts before the persisted retry deadline');
  assert.deepEqual(f.queue(),pending,'cooldown retains the exact pending PBs');
  f.advance(1);
}

test('EXACT fresh first five successful finishes: one PB per role, no extra finishes or mocked verdicts',async t=>{
  const f=fixture(t);
  await f.phase('startup-profile-static-snapshot',f.profileGet);
  assert.deepEqual(f.totals(),{reads:0,writes:0,deletes:0,failedAttempts:0});
  await f.phase('fresh-account-profile-create',f.profilePost);
  for(const id of f.selected){
    const beforeViews=f.totals();
    await f.phase('static-track-view-'+id.slice(0,6),()=>f.c.readPublicSnapshotBackup('track',id));
    await f.phase('static-profile-view-'+id.slice(0,6),f.profileGet);
    assert.deepEqual(f.totals(),beforeViews,'display providers are static fixtures, not Firestore reads');
    const result=await f.phase('ONE-successful-finish-'+id.slice(0,6),()=>f.finish(id,30000));
    assert.equal(result.saved,true);assert.equal(result.cloudConfirmed,true);
  }
  assert.equal(f.localRows.length,5);assert.equal(f.recordings.size,5);
  assert.equal(f.data.get(E.profiles+'/'+account).pbCount,5);
  assert.equal(f.queue().length,0,'all three matching event submissions were admitted, not left only in the browser outbox');
  assert.equal(f.data.has(E.totals+'/'+account),false,'no simulated or real verifier was called, so no Event RP was awarded');
  for(const id of f.selected){const row=f.data.get(E.canonical+'/'+account+'_'+id);assert.equal(row.timeMs,30000);assert.equal(row.ownerUid,owner);assert.equal(row.verified,false);}
  for(const p of f.periods){assert.equal(f.data.get(E.queues+'/'+p.id).admitted,1);assert.equal(f.data.get(E.queues+'/'+p.id).slots.length,1);}
  assert.equal(f.transactions.size,0);
  assert.equal(f.snapshotReads.length,11,'six profile and five track provider calls are separate from the Firestore ledger');
  assert.deepEqual(f.totals(),{reads:75,writes:52,deletes:0,failedAttempts:0});
  f.report('EXACT-first-five-one-PB-per-role-no-verdicts');
});

test('separate extended journey: five roles, 15 PBs plus five slower finishes and simulated verdicts',async t=>{
  const f=fixture(t);
  await f.phase('startup-profile-snapshot',f.profileGet);assert.deepEqual(f.totals(),{reads:0,writes:0,deletes:0,failedAttempts:0});
  await f.phase('fresh-account-profile-create',f.profilePost);
  assert.equal(f.data.get(E.profiles+'/'+account).ownerUid,owner);
  for(const id of f.selected){
    await f.phase('track-snapshot-'+id.slice(0,6),()=>f.c.readPublicSnapshotBackup('track',id));
    for(const ms of [30000,29000,28000])await f.phase('finish-'+id.slice(0,6)+'-'+ms,()=>f.finish(id,ms));
    const before=f.totals();await f.phase('slower-local-'+id.slice(0,6),()=>f.finish(id,31000));
    assert.equal(f.totals().reads,before.reads,'known slower finish must not reread canonical data');
    assert.equal(f.totals().writes,before.writes,'known slower finish does not rewrite canonical/profile');
    await f.phase('profile-view-'+id.slice(0,6),f.profileGet);
  }
  await f.phase('local-PB-warm-reconciliation',f.reconcile);
  assert.equal(f.localRows.length,5);assert.equal(f.data.get(E.profiles+'/'+account).pbCount,15);
  assert.equal(f.queue().length,0);
  for(const p of f.periods)assert.equal(f.data.get(E.queues+'/'+p.id).admitted,3,JSON.stringify({period:p.id,diagnostics:f.diagnostics.slice(-10),receipts:[...f.data].filter(([key])=>key.startsWith(E.receipts+'/'))}));
  await f.phase('mock-verdict-completion-not-physics',f.verdicts);
  assert.ok(f.data.get(E.totals+'/'+account).rp>0);
  assert.equal(f.transactions.size,0,'all actual fixture transaction handles are closed');
  assert.deepEqual(f.totals(),{reads:337,writes:202,deletes:0,failedAttempts:0});
  for(const id of f.selected){
    const row=f.data.get(E.canonical+'/'+account+'_'+id);
    assert.equal(row.ownerUid,owner);assert.equal(row.timeMs,28000);assert.equal(row.verified,false);
  }
  assert.equal(f.data.get(E.profiles+'/'+account).pbCount,15,'simulated event completion does not double-count the already saved normal PB');
  f.report('healthy-15-PBs-plus-five-slower-finishes');
});

test('fresh-account snapshot/profile repeats remain separate from SDK, ownership and name claim costs',async t=>{
  const f=fixture(t);
  await f.phase('first-profile-create',f.profilePost);
  const first=f.totals();
  await f.phase('20-identical-profile-POSTs',async()=>{for(let i=0;i<20;i++)await f.profilePost();});
  assert.deepEqual(f.totals(),first);
  await f.phase('20-profile-snapshot-GETs',async()=>{for(let i=0;i<20;i++)await f.profileGet();});assert.deepEqual(f.totals(),first);
  assert.equal(f.snapshotReads.length,20);
  await f.phase('genuine-name-change',f.rename);
  assert.ok(f.totals().deletes>0,'rename releases the old owned name claim');
  assert.equal(f.data.get(E.profiles+'/'+account).nickname,'Renamed Journey');
  f.report('fresh-profile-warm-noops-and-real-rename');
});

for(const mode of ['offline','403'])test('mixed event outbox '+mode+': latest PB retained, then bounded recovery',async t=>{
  const f=fixture(t,{edge:mode});await f.phase('profile-init',f.profilePost);
  f.fail('unavailable',E.inbox,-1,'write');
  await f.phase('five-local-tracks-with-cloud-inbox-unavailable',async()=>{for(const id of f.selected)await f.finish(id,30000);});
  assert.ok(f.queue().length>0);const queued=f.queue().length;
  await f.phase('same-minute-event-flush-is-local-backoff',()=>f.c.flush());assert.equal(f.queue().length,queued);
  f.fail(null);await waitForEventRetry(f);await f.phase('recover-inbox-writes',()=>f.c.flush());assert.equal(f.queue().length,0);
  await f.phase('worker-consumes-recovered-inbox',f.drainInbox);
  for(const p of f.periods)assert.equal(f.data.get(E.queues+'/'+p.id).admitted,1,JSON.stringify([...f.data].filter(([key])=>key.startsWith(E.receipts+'/'))));
  assert.equal(f.c.firebaseQuotaPaused(),false,'ordinary unavailable/403 is not demonstrated quota exhaustion');
  f.report('event-outbox-'+mode+'-recovery');
});

test('unknown quota state: first failure counted unknown, local five-track PBs survive, no SDK storm',async t=>{
  const f=fixture(t);await f.phase('profile-init',f.profilePost);
  f.fail('resource-exhausted',E.canonical,1);
  await f.phase('quota-first-five-finishes',async()=>{for(const id of f.selected)await f.finish(id,30000);});
  assert.equal(f.c.firebaseQuotaPaused(),true);assert.equal(f.localRows.length,5);assert.equal(f.queue().length,3);
  assert.equal(f.events.filter(e=>e.op==='failed-read').length,1);
  const before=f.totals();await f.phase('bounded-warm-retries-during-cooldown',async()=>{for(let i=0;i<10;i++){await f.profileGet();await f.reconcile();await f.c.flush();}});
  assert.deepEqual(f.totals(),before);
  f.advance(16*60000);await f.phase('quota-recovery-local-PB-reconcile',f.reconcile);
    assert.equal(f.data.get(E.profiles+'/'+account).pbCount,5,'each recovered first PB counts once, not again in the bootstrap floor');assert.equal(f.localRows.length,5);
  await waitForEventRetry(f);await f.phase('quota-recovery-event-outbox',()=>f.c.flush());assert.equal(f.queue().length,0);
  await f.phase('quota-recovery-event-intake',f.drainInbox);
  for(const p of f.periods)assert.equal(f.data.get(E.queues+'/'+p.id).admitted,1);
  f.report('quota-cooldown-recovery');
});

test('permission-denied and monitor-like 403 do not prove quota; keyed reconciliation backs off',async t=>{
  const f=fixture(t);await f.phase('profile-init',f.profilePost);
  f.c.noteFirebaseQuota(Object.assign(Error('monitor HTTP 403'),{code:'permission-denied'}));assert.equal(f.c.firebaseQuotaPaused(),false);
  f.fail('permission-denied',E.canonical,-1);
  await f.phase('five-permission-denied-finishes',async()=>{for(const id of f.selected)await f.finish(id,30000,{capture:false});});
  assert.equal(f.c.firebaseQuotaPaused(),false);assert.equal(f.localRows.length,5);
  await f.phase('first-denied-reconciliation',f.reconcile);const before=f.totals();
  await f.phase('ten-warm-keyed-retries',async()=>{for(let i=0;i<10;i++)await f.reconcile();});assert.deepEqual(f.totals(),before);
  f.report('permission-denied-not-quota');
});

test('event outbox is account-bound and coalesces two offline improvements to the latest PB',async t=>{
  const f=fixture(t,{edge:'offline'});await f.phase('profile-init',f.profilePost);
  f.fail('unavailable',E.inbox,-1,'write');
  const id=f.periods[0].trackId;
  await f.phase('two-offline-event-improvements',async()=>{await f.finish(id,30000);await f.finish(id,29000);});
  assert.equal(f.queue().length,1);assert.equal(f.queue()[0].timeMs,29000);
  await waitForEventRetry(f);f.c.bridge.accountId=()=> 'f'.repeat(64);const before=f.totals();
  await f.phase('other-account-must-not-upload-old-outbox',()=>f.c.flush());assert.deepEqual(f.totals(),before);assert.equal(f.queue().length,1);
  f.c.bridge.accountId=()=>account;f.fail(null);
  await f.phase('original-account-recovers-one-latest-inbox-write',()=>f.c.flush());assert.equal(f.queue().length,0);
  assert.equal(f.data.get(E.inbox+'/'+f.periods[0].id+'_'+account).timeMs,29000);
  f.report('account-bound-latest-event-outbox');
});

test('measured candidate only: existing coalesced lane on one additional busy first-five track',async t=>{
  const receipts=[];
  for(const candidate of [false,true]){
    const f=fixture(t),id=f.selected[0];
    const oldRows=Array.from({length:1136},(_,i)=>({accountId:(i+1).toString(16).padStart(64,'0'),trackId:id,
      name:'Fixture '+i,timeMs:50000+i,frames:50000+i,raceTimeFrames:50000+i,uploadId:1,pbAt:1000,
      replay:'AAAA',replayHash:sha('AAAA'),integrityVerified:true}));
    const entries=computeTrackEntries(oldRows,id,{},{}),pages=await preparePublicationPages('track',id,entries,{sourceRevision:1,sourceComplete:true});
    for(const doc of pages.documents)f.put(doc.collection+'/'+doc.id,doc.data);
    f.put('0.6.2_s1_leaderboards_track/'+id,{trackId:id,entries:entries.slice(0,500),pagination:pages.pagination,
      totalEntries:entries.length,totalEntriesExact:true,sourceComplete:true,complete:false,revision:1,sourceRevision:1,
      algorithmVersion:'participation-v8-s1',schemaVersion:6,signature:'synthetic-busy-board'});
    await f.phase('profile-init',f.profilePost);
    if(candidate)f.env.PB_COALESCED_TRACK_IDS_JSON=JSON.stringify([...new Set([...JSON.parse(config.vars.PB_COALESCED_TRACK_IDS_JSON),id])]);
    const before=f.totals(),eventStart=f.events.length;
    for(const ms of [30000,29000,28000])await f.phase((candidate?'candidate-queued-':'current-immediate-')+ms,()=>f.finish(id,ms,{capture:false}));
    if(candidate)await f.phase('candidate-single-bounded-targeted-drain',()=>reconcileCanonicalChanges(f.env,{scanResults:false}));
    const board=f.data.get('0.6.2_s1_leaderboards_track/'+id);
    const published=await loadPublicationEntries(board,'track',id,async(collection,key)=>({data:f.data.get(collection+'/'+key)}));
    const racer=published.find(row=>row.accountId===account);
    assert.equal(racer.timeMs,28000);assert.equal(racer.runVerified,false,'client data and a mocked board cannot manufacture a native proof');
    assert.equal(published.length,1137);
    const counts=f.totals(),delta=Object.fromEntries(Object.keys(counts).map(key=>[key,counts[key]-before[key]]));
    const writes=f.events.slice(eventStart).filter(row=>row.op==='write');
    receipts.push({candidate,trackId:id,populationBefore:1136,delta,publicPageWrites:writes.filter(row=>row.key.startsWith('0.6.2_s1_public_pages/')).length,
      canonicalWrites:writes.filter(row=>row.key.startsWith(E.canonical+'/')).length});
  }
  assert.equal(receipts[0].canonicalWrites,3);assert.equal(receipts[1].canonicalWrites,3);
  assert.equal(receipts[0].publicPageWrites,36);assert.equal(receipts[1].publicPageWrites,12);
  assert.ok(receipts[1].delta.writes<receipts[0].delta.writes);
  process.stdout.write('BUSY_JOURNEY_CANDIDATE '+JSON.stringify({receipts,scope:'fixture-only allowlist input; no production configuration edited',
    excludes:'actual native proof publication, Overall, future readers and production attribution'})+'\n');
});
