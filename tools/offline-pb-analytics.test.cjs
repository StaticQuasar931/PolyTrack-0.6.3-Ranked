const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createHash}=require('node:crypto');
const path=require('node:path');
const repo=process.env.POLYTRACK_REPO||path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(repo,'polytrack_062_patch.js'),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function harness(disk=new Map()){
  const cloud=new Map();let serial=0,user={uid:'uid'};
  const h={disk,cloud,paused:true,account:'acct',uid:'uid',failStorage:false,dbGate:null,retry:false,
    lastMirrorSig:'',lastMirrorAt:0,guestAccountId:'acct',LAST_ACTIVE_NAME_KEY:'name',
    LOCAL_PB_RECONCILE_STATE_KEY:'receipts',OVERALL_PB_DIRTY_KEY:'dirty',FIREBASE_QUOTA_PAUSE_KEY:'quota',
    COLLECTIONS:{raceResults:'races',profilesPublic:'profiles'},legacyNameTransactions:new WeakSet(),
    confirmedRecordingUploads:new Map(),overallLoadState:{},
    localStorage:{getItem:k=>disk.get(k)||null,setItem:(k,v)=>{if(h.failStorage)throw Error('storage');disk.set(k,v);}},
    readJsonStorage:(k,f)=>JSON.parse(disk.get(k)||JSON.stringify(f)),
    writeJsonStorage:(k,v)=>{if(h.failStorage)return false;disk.set(k,JSON.stringify(v));return true;},
    readLocalRaceRows:()=>h.readJsonStorage('rows',[]),
    addLocalRaceRow:r=>{if(h.failStorage)return false;const rows=h.readLocalRaceRows();const old=rows.find(x=>x.accountId===r.accountId&&x.trackId===r.trackId);if(!old||r.timeMs<old.timeMs)h.writeJsonStorage('rows',[r,...rows.filter(x=>x!==old)]);return true;},
    localRaceRowsForTrack:t=>h.readLocalRaceRows().filter(r=>r.trackId===t),
    parsePayload:x=>x,accountIdFromPayload:async p=>p.accountId,
    sanitizeDisplayName:x=>x,enforceSafeDisplayName:async x=>x,getLastKnownName:()=>'',setLastKnownName:()=>{},
    invalidateNativePartialReplayAccount:()=>{},safePositiveInt:x=>Number(x),normalizeReplayPayloadString:x=>x,
    __pt062NormalizeStyle:x=>x,getDefaultCarStyle:()=>'',safeRecordingId:x=>Number(x)||null,
    nextUploadId:()=>++serial,currentPlaytimeMs:()=>0,sha256Hex:async x=>hash(x),
    __pt062RememberStyle:()=>{},log:()=>{},readTrackSnapshotCache:()=>null,readOverallSnapshotCache:()=>null,
    canonicalRaceTimeMs:r=>Number(r?.timeMs||0),cleanUserId:x=>String(x||''),
    deploymentSourceOrigin:()=> 'test',writeRecordingStore:()=>{},resolveManualNameOverride:async(d,a,n)=>n,
    assertCloudOwner:()=>{},claimCloudProfileName:async(d,t,a,u,p,n)=>n,
    showPublicNameAdjustment:()=>{},safeDisplayName:x=>x,
    syncDailyActivity:async()=>{},sendRankedNotification:async()=>{},syncExactCarPreview:async()=>{},
    saveClaimedPublicProfile:async(d,a,u,p)=>p.name,retainTrackSnapshotAfterLocalPb:()=>{},
    noteFirebaseQuota:()=>{},scheduleLocalPbCloudReconcile:()=>{},firebaseQuotaPaused:()=>h.paused,
    opponentShortcutStatus:()=>{},opponentShortcutBoard:()=>null,showCloudOwnerConflict:()=>{},
    isCurrentLocalPbReconcileIdentity:(a,u)=>a===h.account&&(!u||u===h.uid),
    utcDayKey:()=> '2026-11-01',activeRankedAccountId:()=>h.account,
    TRACK_CATALOG:new Map([['one',{id:'one',type:'official'}]]),
    window:{firebase:{auth:()=>{if(user.uid!==h.uid)user={uid:h.uid};return {currentUser:user};},firestore:{FieldValue:{serverTimestamp:()=>123}}}},
    db:async()=>{if(h.dbGate)await h.dbGate;if(h.paused)throw Object.assign(Error('quota'),{code:'resource-exhausted'});return {collection:c=>({doc:id=>c+'/'+id})};},
    runFirebaseTransaction:async(d,cb)=>{const run=async commit=>{const writes=[];await cb({get:async ref=>({exists:cloud.has(ref),data:()=>cloud.get(ref)}),set:(ref,row,opt)=>writes.push([ref,structuredClone(row),opt])});if(commit)for(const [ref,row,opt] of writes)cloud.set(ref,opt?.merge?{...cloud.get(ref),...row}:row);};if(h.retry)await run(false);await run(true);},
  };
  vm.createContext(h);
  vm.runInContext(section("  const DAILY_ACTIVITY_LOCAL_KEY=",'  function dailySpotlight(')+
    section('  function recordDailyActivity(','  async function syncDailyActivity(')+
    section('  function localPersonalBestMs(','  function deploymentSourceOrigin(')+
    section('  async function mirrorRaceResult(','  function localPbHasAvailableReplay(')+
    section('  function rememberConfirmedLocalPb(','  function scheduleLocalPbCloudReconcile('),h);
  h.submit=(track,time,guard=null)=>h.mirrorRaceResult('test',{accountId:'acct',trackId:track,timeMs:time,frames:time,recording:'replay'+time,nickname:'Racer'},guard);
  h.activity=(account=h.account)=>JSON.parse(disk.get('polytrack-0.6.3-daily-activity-local-v2')||'{"buckets":[]}').buckets.find(row=>row.accountId===account)||{};
  return h;
}
for(const tracks of [['one','one','one'],['one','two','one'],['one','two','three']]){
  test('three quota PBs retain analytics while replay outbox coalesces: '+tracks,async()=>{
    let h=harness();for(let i=0;i<3;i++){const result=await h.submit(tracks[i],3000-i*100);assert.equal(result.localSaved,true);assert.equal(result.cloudConfirmed,undefined);}
    assert.equal(h.activity().pbs,3);assert.equal(h.activity().runs,3);
    const rows=h.localBestRowsForAccount('acct');assert.equal(rows.length,new Set(tracks).size);
    for(const row of rows)assert.equal(h.localPbCloudConfirmed(row,'acct'),false);
    h=harness(h.disk);h.paused=false;h.retry=true;
    for(const row of h.localBestRowsForAccount('acct')){
      const result=await h.submit(row.trackId,row.timeMs,{accountId:'acct',ownerUid:'uid'});
      assert.equal(result.saved,true);assert.equal(result.cloudConfirmed,true);
      assert.equal(h.localPbCloudConfirmed(row,'acct'),true);
    }
    assert.equal(h.activity().pbs,3);assert.equal(h.activity().runs,3);
    assert.equal(h.cloud.get('profiles/acct').pbCount,rows.length,'legacy public counter counts committed bests, not offline events');
    for(const row of rows)await h.submit(row.trackId,row.timeMs,{accountId:'acct',ownerUid:'uid'});
    assert.equal(h.activity().pbs,3);assert.equal(h.cloud.get('profiles/acct').pbCount,rows.length);
  });
}
test('tab close during cloud await leaves all local PB analytics durable',async()=>{
  const h=harness();let release;h.dbGate=new Promise(r=>release=r);
  const pending=h.submit('one',3000);for(let i=0;i<100&&!h.activity().pbs;i++)await new Promise(r=>setImmediate(r));
  assert.equal(h.activity().pbs,1,'the original finish must be durable before cloud work');
  const reopened=harness(h.disk);assert.equal(reopened.activity().pbs,1);assert.equal(reopened.localBestRowsForAccount('acct').length,1);
  release();await pending;assert.equal(h.activity().pbs,1);
});
test('account switch before guarded transaction does not write or count another PB',async()=>{
  const h=harness();await h.submit('one',3000);h.paused=false;
  let release;h.dbGate=new Promise(r=>release=r);const pending=h.submit('one',3000,{accountId:'acct',ownerUid:'uid'});
  await new Promise(r=>setImmediate(r));h.account='other';h.uid='other';release();
  assert.equal((await pending).cancelled,true);assert.equal(h.cloud.size,0);assert.equal(h.activity('acct').pbs,1);
});
test('receipts require matching account, time and exact nonempty hash',()=>{
  const h=harness(),r={accountId:'acct',trackId:'one',timeMs:1000,replayHash:hash('one')};
  for(const bad of [{...r,replayHash:''},{...r,accountId:'other'}]){h.rememberConfirmedLocalPb('acct',bad);assert.equal(h.localPbCloudConfirmed(bad,'acct'),false);}
  h.rememberConfirmedLocalPb('acct',r);assert.equal(h.localPbCloudConfirmed(r,'acct'),true);
  for(const change of [{timeMs:999},{replayHash:hash('two')},{accountId:'other'}])assert.equal(h.localPbCloudConfirmed({...r,...change},'acct'),false);
});
test('failed device and cloud storage cannot claim a local PB or receipt',async()=>{
  const h=harness();h.failStorage=true;const result=await h.submit('one',3000);
  assert.equal(result.localSaved,false);assert.equal(result.saved,false);assert.equal(h.localBestRowsForAccount('acct').length,0);assert.equal(h.disk.has('receipts'),false);
});
test('normal transaction retries count one finish and one PB, not each callback',async()=>{
  const h=harness();h.paused=false;h.retry=true;
  assert.equal((await h.submit('one',3000)).cloudConfirmed,true);
  assert.equal(h.activity().pbs,1);assert.equal(h.activity().runs,1);
  assert.equal(h.cloud.get('profiles/acct').pbCount,1);
});
test('old confirmation cannot label a newer PB submitted; local evidence overrides verified flags',()=>{
  const h=harness();vm.runInContext(section('  function runStatus(','  function matchNativeResult('),h);
  const row={accountId:'acct',trackId:'one',timeMs:3000,replayHash:hash('old')};
  h.rememberConfirmedLocalPb('acct',row);
  const newer={...row,timeMs:2900,replayHash:hash('new')};
  assert.equal(h.localPbCloudConfirmed(newer,'acct'),false);
  assert.equal(h.runStatus({...newer,localPending:true,cloudConfirmed:false,runVerified:true}),'local');
  assert.equal(h.runStatus({...row,localPending:true,cloudConfirmed:h.localPbCloudConfirmed(row,'acct')}),'submitted');
  h.failStorage=true;h.rememberConfirmedLocalPb('acct',newer);
  assert.equal(h.localPbCloudConfirmed(newer,'acct'),false);
});

function studio(disk=new Map()){
  const h=harness(disk);Object.assign(h,{activeRankedAccountId:()=>h.account,
    sanitizeProfileCosmetics:x=>x||{},PROFILE_COSMETICS_KEY:'design',profileCosmeticDrafts:new Map([['acct',{theme:'gold'}]]),
    cosmeticEpoch:0,overallEntriesCache:[],renderEntries:()=>{},setTimeout:()=>0,clearTimeout:()=>{},
    readCosmeticDirectory:()=>({entries:{}}),writeCosmeticDirectory:()=>{},rankedBrokerUrl:()=>'',
    scheduleCosmeticPublishRetry:()=>{},navigator:{onLine:true},});
  vm.runInContext(section("  const COSMETIC_PUBLISH_QUEUE_KEY=",'  let rankedQueueFlushPromise='),h);
  return h;
}
test('RacerStudio quota failure persists a truthful queued draft across reload',async()=>{
  let h=studio();const status={},button={};assert.equal(await h.saveRankedProfileCosmetics('acct',status,button),false);
  assert.match(status.textContent,/queued/i);assert.equal(h.readCosmeticPublishQueue().entries.acct.cosmetics.theme,'gold');
  h=studio(h.disk);h.paused=false;h.retry=true;const result=await h.flushPendingCosmeticPublishes({force:true});
  assert.equal(result.published,true);assert.equal(h.readCosmeticPublishQueue().entries.acct,undefined);
  assert.equal(h.cloud.get('0.6.2_profiles_public/acct').profileCosmetics.theme,'gold');
});
test('RacerStudio storage failure never claims saved or queued',async()=>{
  const h=studio();h.failStorage=true;const status={},button={};
  assert.equal(await h.saveRankedProfileCosmetics('acct',status,button),false);
  assert.match(status.textContent,/not saved/i);assert.equal(button.disabled,false);assert.equal(h.readCosmeticPublishQueue().entries.acct,undefined);
});
test('RacerStudio account switch retains bound queue and does not publish',async()=>{
  const h=studio();h.queueCosmeticPublish('acct','uid',{theme:'gold'});h.uid='other';h.paused=false;
  const result=await h.flushPendingCosmeticPublishes({force:true});assert.equal(result.published,false);assert.equal(result.switched,true);
  assert.ok(h.readCosmeticPublishQueue().entries.acct);assert.equal(h.cloud.size,0);
});
