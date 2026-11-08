const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8').replace(/\r\n/g,'\n');
const ACCOUNT='a'.repeat(64),TRACK='b'.repeat(64),OTHER='c'.repeat(64),hash=value=>createHash('sha256').update(value).digest('hex');
const local=patch=>({accountId:ACCOUNT,userId:ACCOUNT,trackId:TRACK,timeMs:10000,replayHash:hash('old'),replay:'old',localPending:true,cloudConfirmed:false,...patch});
const published=patch=>({accountId:ACCOUNT,updatedAt:100,results:[{trackId:TRACK,timeMs:10000,replayHash:hash('old'),runVerified:false}],...patch});
function extract(name){
  const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n  }',start)+4);
}
function deferred(){let resolve;const promise=new Promise(value=>resolve=value);return {promise,resolve};}
function fixture({rows=[local()],profile=published(),cloud=null,failStatic=false}={}){
  let user={uid:'owner'},active=ACCOUNT,reader=async()=>profile,now=1000000;
  const storage=new Map(),timers=new Map(),uploads=[],cost={static:0,db:0,get:0,confirm:0,ownership:0};let serial=0;
  const c=vm.createContext({Map,Set,Promise,JSON,Math,Array,Number,String,Error,Date:{now:()=>now},
    profileSnapshotEpoch:7,plannerPublishedProfiles:new Map(),profileSnapshotResults:new Map(),profileSnapshotRequests:new Map(),profileSnapshotRetryAt:new Map(),
    cleanUserId:value=>String(value||''),activeRankedAccountId:()=>active,
    readPublicSnapshotBackup:async(kind,id)=>{assert.equal(kind,'profile-results');assert.equal(id,ACCOUNT);cost.static++;if(failStatic)throw Error('missing package');return reader();},
    localBestRowsForAccount:()=>rows.map(row=>({...row})),canonicalRaceTimeMs:row=>Number(row?.timeMs)||0,
    LOCAL_PB_RECONCILE_STATE_KEY:'state',FIREBASE_QUOTA_PAUSE_KEY:'quota',OVERALL_PB_DIRTY_KEY:'dirty',
    localPbReconcilePromises:new Map(),localPbReconcileTimers:new Map(),COLLECTIONS:{raceResults:'races'},
    readJsonStorage:(key,fallback)=>storage.has(key)?JSON.parse(JSON.stringify(storage.get(key))):fallback,
    writeJsonStorage:(key,value)=>{storage.set(key,JSON.parse(JSON.stringify(value)));return true;},
    firebaseQuotaPaused:()=>false,noteFirebaseQuota(){},log(){},overallLoadState:{},
    setTimeout:(fn,delay)=>{const id=++serial;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    navigator:{onLine:true},document:{visibilityState:'visible',addEventListener(){}},compatibilityOnlineAllowed:true,
    window:{addEventListener(){},firebase:{auth:()=>({currentUser:user})}},
    db:async()=>{cost.db++;return {collection:kind=>{assert.equal(kind,'races');return {doc:id=>({get:async options=>{
      assert.equal(options.source,'server');cost.get++;
      const trackId=id.slice(ACCOUNT.length+1);
      const value=cloud||{accountId:ACCOUNT,ownerUid:'owner',trackId,timeMs:10000,replayHash:hash('old')};
      return {exists:true,metadata:{fromCache:false},data:()=>value};
    }})};}};},
    cloudOwnerConflicts:new Map(),showCloudOwnerConflict(){},
    assertCloudOwner:(accountId,uid,row)=>{cost.ownership++;assert.equal(row.accountId,accountId);assert.equal(row.ownerUid,uid);},
    readRecordingStore:()=>[],safeRecordingId:value=>value,normalizeReplayPayloadString:value=>String(value||''),
    safePositiveInt:value=>Number(value)||1,getLastKnownName:()=> 'Racer',getDefaultCarStyle:()=>'',addLocalRaceRow(){},
    mirrorRaceResult:async(_url,row)=>{uploads.push(row);c.rememberConfirmedLocalPb(ACCOUNT,row);return {saved:true};}
  });
  vm.runInContext(extract('loadProfileSnapshotResults'),c);
  const start=source.indexOf('  function localPbSyncSignature('),end=source.indexOf('  function hookLegacyNetworking(',start);
  vm.runInContext(source.slice(start,end),c);
  const confirm=c.rememberConfirmedLocalPb;c.rememberConfirmedLocalPb=(...args)=>{cost.confirm++;return confirm(...args);};
  return {c,rows,storage,timers,cost,uploads,run:()=>c.reconcileLocalPersonalBestsToCloud(ACCOUNT),
    read:value=>{reader=value;},user:value=>{user=value;},account:value=>{active=value;},advance:ms=>{now+=ms;}};
}
test('exact raw published observation costs zero DB/GET without confirmation, verification or false fresh acknowledgement',async()=>{
  const h=fixture(),result=await h.run();
  assert.equal(result.observed,1);assert.equal(result.checked,0);assert.equal(result.publishedObserved,true);
  assert.equal(h.cost.static,1);assert.equal(h.cost.db,0);assert.equal(h.cost.get,0);assert.equal(h.cost.confirm,0);
  assert.equal(h.storage.get('state')?.[ACCOUNT]?.confirmed,undefined);assert.equal(h.storage.get('state')?.[ACCOUNT]?.fingerprint,undefined);
  assert.equal(h.rows[0].cloudConfirmed,false);assert.equal(h.rows[0].localPending,true);assert.equal(h.rows[0].runVerified,undefined);
  assert.equal(h.uploads.length,0);assert.equal(h.timers.size,0);
  for(let i=0;i<3;i++)assert.equal((await h.run()).observed,1);
  assert.equal(h.cost.static,1);assert.equal(h.cost.db,0);
});
for(const [label,patch]of [['different time',{timeMs:11000}],['different hash',{replayHash:hash('foreign')}],
  ['missing hash',{replayHash:undefined}],['short hash',{replayHash:'a'.repeat(63)}],['foreign row account',{accountId:OTHER}],
  ['foreign row user',{userId:OTHER}],['fractional time',{timeMs:10000.5}],['string time',{timeMs:'10000'}],
  ['non-positive time',{timeMs:0}],['localPending',{localPending:true}],['local',{local:true}],['pending',{pending:true}],
  ['malformed pending flag',{localPending:'true'}],['malformed hold flag',{reviewHold:'yes'}],
  ['verification excluded',{verificationStatus:'excluded'}],['review excluded',{reviewStatus:'excluded'}],
  ['review excluded reason',{reason:'review_excluded'}],['rejected',{validationState:'rejected'}],['review hold',{reviewHold:true}],['needs review',{needsReview:true}],
  ['reason hold',{reason:'review_hold'}],['unavailable authority',{complete:false}]])
  test('unusable published '+label+' safely falls back to one server GET',async()=>{
    const profile=published();Object.assign(profile.results[0],patch);
    const h=fixture({profile});await h.run();assert.equal(h.cost.db,1);assert.equal(h.cost.get,1);assert.equal(h.cost.ownership,1);
  });
for(const [label,profile]of [['missing',null],['foreign profile',published({accountId:OTHER})],['no row',published({results:[]})],
  ['malformed rows',published({results:[null]})],['profile hold',published({reviewHold:true})],
  ['local profile',published({_localPlacementsOnly:true})]])
  test(label+' never infers absence or permission from static input',async()=>{
    const h=fixture({profile});await h.run();assert.equal(h.cost.get,1);assert.equal(h.cost.ownership,1);
  });
test('all duplicate or conflicting track rows fail closed, even identical rows',async()=>{
  for(const different of [false,true]){
    const profile=published(),row={...profile.results[0]};if(different)row.replayHash=hash('conflict');profile.results.push(row);
    const h=fixture({profile});await h.run();assert.equal(h.cost.get,1);
  }
});
test('merged/warmed display profile cannot provide published authority or suppress the coalesced raw fetch',async()=>{
  const h=fixture({profile:null});h.c.profileSnapshotResults.set(ACCOUNT,published());
  await h.run();assert.equal(h.cost.static,1);assert.equal(h.cost.get,1);assert.equal(h.c.plannerPublishedProfiles.has(ACCOUNT),false);
});
test('static own-profile reads coalesce across concurrent reconciliation and UI loading',async()=>{
  const h=fixture(),gate=deferred();h.read(()=>gate.promise);
  const first=h.run(),second=h.run(),ui=h.c.loadProfileSnapshotResults(ACCOUNT);
  assert.equal(h.cost.static,1);gate.resolve(published());
  const results=await Promise.all([first,second,ui]);assert.equal(results[0].observed,1);assert.equal(results[1].observed,1);
  assert.equal(h.cost.db,0);assert.equal(h.cost.static,1);
});
test('stale raw epoch is not accepted, including when exact display rows remain cached',async()=>{
  const h=fixture({profile:null});
  h.c.plannerPublishedProfiles.set(ACCOUNT,{epoch:6,profile:published()});h.c.profileSnapshotResults.set(ACCOUNT,published());
  await h.run();assert.equal(h.cost.static,1);assert.equal(h.cost.get,1);
});
test('observation does not survive package change and never creates a durable confirmed/fresh fingerprint',async()=>{
  const h=fixture();await h.run();assert.equal(h.cost.get,0);
  h.c.profileSnapshotEpoch++;h.read(async()=>null);
  await h.run();assert.equal(h.cost.get,1);assert.equal(h.cost.confirm,1,'only the actual server response can confirm');
});
for(const change of ['user','signout','account','epoch'])test(change+' during static await defers before DB setup',async()=>{
  const h=fixture(),gate=deferred();h.read(()=>gate.promise);const pending=h.run();
  assert.equal(h.cost.static,1);
  if(change==='user')h.user({uid:'owner'});if(change==='signout')h.user(null);if(change==='account')h.account(OTHER);if(change==='epoch')h.c.profileSnapshotEpoch++;
  gate.resolve(published());const result=await pending;
  assert.equal(result.deferred,true);assert.equal(result.observed,0);assert.equal(h.cost.db,0);assert.equal(h.cost.get,0);
  assert.equal(h.rows[0].cloudConfirmed,false);
});
test('a faster PB arriving during static fetch is re-read locally and preserved for normal upload',async()=>{
  const h=fixture(),gate=deferred();h.read(()=>gate.promise);const pending=h.run();
  h.rows[0].timeMs=9000;h.rows[0].replayHash=hash('faster');h.rows[0].replay='faster';
  gate.resolve(published());const result=await pending;
  assert.equal(result.observed,0);assert.equal(h.cost.get,1);assert.equal(h.uploads.length,1);
  assert.equal(h.uploads[0].timeMs,9000);assert.equal(h.uploads[0].replayHash,hash('faster'));
});
test('mixed batch excludes observations from confirmation and from recurring pending timers',async()=>{
  const h=fixture({rows:[local(),local({trackId:OTHER})]});const result=await h.run();
  assert.equal(result.observed,1);assert.equal(result.checked,1);assert.equal(h.cost.get,1);
  const confirmed=h.storage.get('state')[ACCOUNT].confirmed;
  assert.equal(confirmed[TRACK],undefined);assert.ok(confirmed[OTHER]);
  assert.equal(h.storage.get('state')[ACCOUNT].fingerprint,null);assert.equal(h.timers.size,0);
});
test('static fetch failure remains ordinary server reconciliation, not proof of absence',async()=>{
  const h=fixture({failStatic:true});await h.run();assert.equal(h.cost.static,1);assert.equal(h.cost.get,1);
});
test('a false fingerprint without matching canonical confirmation signatures cannot suppress a server read',async()=>{
  const h=fixture({profile:null}),row=h.rows[0];
  const fingerprint=row.trackId+':'+row.timeMs+':'+row.replayHash.slice(0,16);
  h.storage.set('state',{[ACCOUNT]:{fingerprint}});
  await h.run();assert.equal(h.cost.get,1);
});

for(const settled of ['confirmed','published'])test('track 501 remains uploadable after 500 '+settled+' PBs with no extra observed GETs',async()=>{
  const rows=Array.from({length:501},(_,i)=>local({trackId:(i+1).toString(16).padStart(64,'0'),uploadId:i+1}));
  const last=rows.at(-1),profile=published({results:settled==='published'?rows.slice(0,500).map(r=>({trackId:r.trackId,timeMs:r.timeMs,replayHash:r.replayHash})):[]});
  const h=fixture({rows,profile,cloud:{accountId:ACCOUNT,ownerUid:'owner',trackId:last.trackId,timeMs:11000,replayHash:hash('slower')}});
  h.c.readLocalRaceRows=()=>h.rows;vm.runInContext(extract('localBestRowsForAccount'),h.c);
  if(settled==='confirmed')h.storage.set('state',{[ACCOUNT]:{confirmed:Object.fromEntries(rows.slice(0,500).map(r=>[r.trackId,JSON.stringify([r.trackId,r.timeMs,r.replayHash])]))}});
  assert.equal(h.c.localBestRowsForAccount(ACCOUNT).length,501);
  const result=await h.run();assert.equal(result.checked,1);assert.equal(result.uploaded,1);assert.equal(h.cost.get,1);assert.equal(h.cost.ownership,1);
  assert.equal(h.uploads[0].trackId,last.trackId);assert.equal(h.uploads[0].timeMs,10000);
  if(settled==='published')assert.equal(result.observed,500);
  await h.run();assert.equal(h.cost.get,1,'settled and snapshot-observed rows never add confirmation reads');
});
