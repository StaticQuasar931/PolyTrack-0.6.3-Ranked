import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { preparePolyTrackOverallPlacements } from './record-placement.mjs';

const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
function section(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
// Extracted production routes must include their shared transport dependency.
function runClientSource(code,context,...options){
  if(code.includes('rankedFetch(')&&!code.includes('function rankedFetch(')){
    context.Headers=Headers;context.performance=performance;context.noteDeveloperEvent=()=>{};
    vm.runInContext(section('  function rankedFetch(', '  function rankedBrokerUrl('),context);
  }
  return vm.runInContext(code,context,...options);
}


test('protected refresh control visibly locks and unlocks without changing loading-owned disabled state',()=>{
  let locked=true;const attrs=new Map();
  const button={disabled:false,dataset:{},style:{removeProperty:()=>{}},setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k)};
  const context=vm.createContext({String,snapshotOnlyForNewAccount:()=>locked,snapshotUnlockLabel:()=> 'Live refresh unlocks in 10:00',snapshotCaptureLabel:()=> 'Snapshot captured 2 hours ago'});
  runClientSource(section('  function syncSnapshotRefreshControl(', '  async function readPublicSnapshotBackup('),context);
  context.syncSnapshotRefreshControl(button);assert.equal(button.disabled,true);assert.match(button.title,/Saved standings.*Reload/);assert.equal(attrs.get('aria-disabled'),'true');
  context.syncSnapshotRefreshControl(button);locked=false;context.syncSnapshotRefreshControl(button);assert.equal(button.disabled,false);
  button.disabled=true;locked=true;context.syncSnapshotRefreshControl(button);locked=false;context.syncSnapshotRefreshControl(button);assert.equal(button.disabled,true);
});
test('snapshot age labels do not pretend each track was updated when the snapshot was captured',()=>{
  const context=vm.createContext({publicSnapshotPublishedAt:123,ageLabel:at=>{assert.equal(at,123);return '2 hours ago';}});
  runClientSource(section('  function snapshotCaptureLabel(', '  function syncSnapshotRefreshControl('),context);
  assert.equal(context.snapshotCaptureLabel(),'Snapshot package published 2 hours ago');
  context.publicSnapshotPublishedAt=0;assert.match(context.snapshotCaptureLabel(),/unavailable/);
});

test('retained legacy new-account protection needs fifteen minutes and a saved finish, and survives reloads',()=>{
  let now=Date.UTC(2026,9,7),accountId='a'.repeat(64),cached=null,local=[];const storage=new Map();
  const create=()=>{
    const context=vm.createContext({Date:{now:()=>now},activeRankedAccountId:()=>accountId,
      readOverallSnapshotCache:()=>cached,readLocalRaceRows:()=>local,canonicalRaceTimeMs:row=>row.timeMs||0,snapshotRacerDirectoryEntries:{},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}});
    runClientSource(section('  const NEW_ACCOUNT_SNAPSHOT_MS=', '  let localOverallController=').replace('const PUBLIC_STANDINGS_SNAPSHOT_ONLY=true','const PUBLIC_STANDINGS_SNAPSHOT_ONLY=false'),context);return context;
  };
  let context=create();assert.equal(context.snapshotOnlyForNewAccount(),true);
  assert.equal(context.snapshotRefreshState().remainingMs,900000);
  assert.equal(context.snapshotUnlockLabel(),'Snapshot standings');
  assert.equal(context.snapshotRefreshState().needsFinish,true);
  local=[{accountId,timeMs:12345}];
  now+=899999;context=create();assert.equal(context.snapshotOnlyForNewAccount(),true);
  assert.equal(context.snapshotRefreshState().remainingMs,1);
  assert.doesNotMatch(context.snapshotUnlockLabel(),/finish required/);
  assert.equal(context.snapshotRefreshState().needsFinish,false);
  assert.match(context.snapshotAccessNotice(),/You can race and submit runs normally/);
  assert.doesNotMatch(context.snapshotAccessNotice(),/first saved finish/);
  now++;assert.equal(context.snapshotOnlyForNewAccount(),false);
  assert.equal(context.snapshotUnlockLabel(),'Snapshot standings');
  accountId='b'.repeat(64);assert.equal(context.snapshotOnlyForNewAccount(),true);
  cached={entries:[{accountId,accountCreatedAt:now-86400000}]};assert.equal(context.snapshotOnlyForNewAccount(),false);
});
test('older racer-directory identities unlock bounded live refresh without a local finish',()=>{
  const now=Date.UTC(2026,9,7),accountId='c'.repeat(64);
  const context=vm.createContext({Date:{now:()=>now},activeRankedAccountId:()=>accountId,readOverallSnapshotCache:()=>null,
    readLocalRaceRows:()=>[],canonicalRaceTimeMs:()=>0,snapshotRacerDirectoryEntries:{[accountId]:{updatedAt:now-900000}},
    localStorage:{getItem:()=>String(now-900000),setItem:()=>{}}});
  runClientSource(section('  const NEW_ACCOUNT_SNAPSHOT_MS=', '  let localOverallController=').replace('const PUBLIC_STANDINGS_SNAPSHOT_ONLY=true','const PUBLIC_STANDINGS_SNAPSHOT_ONLY=false'),context);
  assert.equal(context.snapshotOnlyForNewAccount(),false);
});

test('snapshot racer-directory overlays overall identity only when profile metadata is newer',()=>{
  const id='d'.repeat(64),directory={updatedAt:300,name:'Natsujo',nickname:'Natsujo',countryCode:'JP',carStyle:'style-v2',carId:'car-2',carColors:'ffffff00000000000000',profileCosmetics:{theme:'classic'}};
  const context=vm.createContext({snapshotRacerDirectoryEntries:{[id]:directory},cleanUserId:value=>String(value||''),
    getLastKnownName:()=>'',__pt062GetRememberedStyle:()=>'',PROFILE_COSMETICS_KEY:'local-profile-cosmetics',readJsonStorage:()=>null,activeRankedAccountId:()=>''});
  runClientSource(section('  function snapshotRacerDirectoryIdentity(', '  function hasExplicitProfileCosmetics('),context);
  const [row]=context.overlaySnapshotRacerDirectory([{userId:id,name:'Unknown',countryCode:'',carStyle:'',carId:'',carColors:''}]);
  assert.equal(row.name,'Natsujo');assert.equal(row.countryCode,'JP');assert.equal(row.carStyle,'style-v2');assert.equal(row.carId,'car-2');

  const live=[{userId:id,name:'Current live name',identityUpdatedAt:400}];
  assert.equal(context.overlaySnapshotRacerDirectory(live)[0].name,'Current live name');
  const newerDirectory={...directory,updatedAt:500};context.snapshotRacerDirectoryEntries[id]=newerDirectory;
  const [updated]=context.overlaySnapshotRacerDirectory(live);
  assert.equal(updated.name,'Natsujo');assert.equal(updated.identityUpdatedAt,500);
  assert.equal(context.snapshotRacerDirectoryIdentity(id,0,600),null);
  const pbNewer=[{userId:id,name:'Latest canonical PB name',identityUpdatedAt:900,pbAt:900}];
  assert.equal(context.overlaySnapshotRacerDirectory(pbNewer)[0].name,'Latest canonical PB name');
});

test('native per-track identity uses a newer directory profile but preserves fresher cached live identity',()=>{
  const id='e'.repeat(64),rows=[{userId:id,name:'Cached live profile',identityUpdatedAt:700,carStyle:'live-style'}];
  const context=vm.createContext({overallEntriesCache:rows,readOverallSnapshotCache:()=>null,cleanUserId:value=>String(value||''),
    snapshotRacerDirectoryEntries:{[id]:{updatedAt:600,name:'Old directory name',carStyle:'old-style'}},
    snapshotCosmeticEntries:{},activeRankedAccountId:()=>'',readJsonStorage:()=>null,PROFILE_COSMETICS_KEY:'profile',
    rankedIdentityIndex:null,rankedIdentityIndexSource:null});
  runClientSource(section('  function snapshotRacerDirectoryIdentity(', '  function hasExplicitProfileCosmetics('),context);
  runClientSource(section('  function rankedIdentityRows(){', '  function decorateNativeLeaderboardIdentity('),context);
  const preserved=context.rankedIdentityForRacer({userId:id,name:'Track cached name',identityUpdatedAt:700,carStyle:'track-style'});
  assert.equal(preserved.name,'Cached live profile');assert.equal(preserved.carStyle,'live-style');
  context.snapshotRacerDirectoryEntries[id]={updatedAt:800,name:'Natsujo',carStyle:'directory-style',countryCode:'JP',profileCosmetics:{theme:'classic'}};
  const hydrated=context.rankedIdentityForRacer({userId:id,name:'Track cached name',identityUpdatedAt:700});
  assert.equal(hydrated.name,'Natsujo');assert.equal(hydrated.carStyle,'directory-style');assert.equal(hydrated.countryCode,'JP');
  assert.equal(hydrated.profileCosmetics.theme,'classic');assert.equal(hydrated.identityUpdatedAt,800);
  const latestPb=context.rankedIdentityForRacer({userId:id,name:'Latest canonical PB name',identityUpdatedAt:900,pbAt:900});
  assert.equal(latestPb.name,'Latest canonical PB name');assert.equal(latestPb.carStyle,'directory-style');
});

test('canonical display names choose the freshest row identity over older live and directory caches',()=>{
  const id='g'.repeat(64),context=vm.createContext({cleanUserId:value=>String(value||''),safeDisplayName:value=>String(value||''),
    overallEntriesCache:[{userId:id,name:'Cached live name',identityUpdatedAt:700}],
    readOverallSnapshotCache:()=>({entries:[{userId:id,name:'Older disk name',identityUpdatedAt:650}]}),
    snapshotRacerDirectoryEntries:{[id]:{updatedAt:800,name:'Directory name'}},getLastKnownName:()=> 'Stale remembered name',setLastKnownName:()=>{}});
  runClientSource(section('  function snapshotRacerDirectoryIdentity(', '  function hasExplicitProfileCosmetics('),context);
  runClientSource(section('  function rowIdentityFreshness(', '  function overlaySnapshotRacerDirectory('),context);
  runClientSource(section('  function canonicalDisplayName(', '  const sdkScriptLoads='),context);
  assert.equal(context.canonicalDisplayName(id,'Newest canonical PB',900),'Newest canonical PB');
  assert.equal(context.canonicalDisplayName(id,'Older track label',600),'Directory name');
  context.readOverallSnapshotCache=()=>({entries:[{userId:id,name:'Newest cached profile',identityUpdatedAt:950}]});
  assert.equal(context.canonicalDisplayName(id,'Older track label',600),'Newest cached profile');
});

test('cached track rows return immediately and start at most one bounded background refresh',async()=>{
  let refreshes=0,now=100000;
  const cached={entries:[{userId:'f'.repeat(64)}],fetchedAt:0,serverUpdatedAt:10};
  const context=vm.createContext({Date:{now:()=>now},unrankedExtraTrackIds:new Set(),readTrackSnapshotCache:()=>cached,TRACK_REFRESH_MS:100,
    trackSnapshotMetadataIsNewer:()=>false,selectCachedTrackState:()=>{},trackEntryRequests:new Map(),trackCacheBackgroundRefreshAt:new Map(),loadTrackEntries:async()=>{refreshes++;return cached.entries;}});
  runClientSource(section('  async function getTrackEntries(', '  function trackSnapshotMetadataIsNewer('),context);
  const first=await context.getTrackEntries('track',10);
  const second=await context.getTrackEntries('track',10);
  assert.equal(first.length,1);assert.equal(second.length,1);assert.equal(refreshes,1);
  const force=await context.getTrackEntries('track',10,true);
  assert.equal(force.length,1);assert.equal(refreshes,2);
});

test('selecting a cached track advances generation and rejects an older response from banner state',()=>{
  const context=vm.createContext({document:{documentElement:{classList:{remove:()=>{}}}},TRACK_REFRESH_MS:60000,
    setTimeout:()=>{},updateTrackFreshnessBanner:()=>{}});
  runClientSource('let currentTrackLoadState={trackId:"old-track",status:"loading"};let trackLoadGeneration=4;',context);
  runClientSource(section('  function selectCachedTrackState(', '  async function getTrackEntries('),context);
  runClientSource(section('  function setTrackLoadStateForGeneration(', '  async function getTrackEntries('),context);
  const result=runClientSource(`(()=>{const oldGeneration=trackLoadGeneration;selectCachedTrackState('new-track',{serverUpdatedAt:700,fetchedAt:650,checkedAt:640});const rejected=setTrackLoadStateForGeneration(oldGeneration,{trackId:'old-track',status:'stale',fetchedAt:999});return {state:currentTrackLoadState,rejected,generation:trackLoadGeneration};})()`,context);
  assert.equal(result.state.trackId,'new-track');assert.equal(result.state.status,'cache');
  assert.equal(result.state.fetchedAt,700);assert.equal(result.state.checkedAt,640);
  assert.equal(result.rejected,false);assert.equal(result.generation,5);
});

test('newer published track metadata bypasses an apparently fresh local cache',()=>{
  const context=vm.createContext({snapshotTrackStatistics:{track:{updatedAt:500}}});
  runClientSource(section('  function trackSnapshotMetadataIsNewer(', '  async function loadTrackEntries('),context);
  assert.equal(context.trackSnapshotMetadataIsNewer('track',{serverUpdatedAt:400,fetchedAt:Date.now()}),true);
  assert.equal(context.trackSnapshotMetadataIsNewer('track',{serverUpdatedAt:500}),false);
  assert.equal(context.trackSnapshotMetadataIsNewer('track',{serverUpdatedAt:600}),false);
});

test('menu placement merges only complete exact-PB profile snapshot rows without cloud data',()=>{
  const accountId='h'.repeat(64),trackA='a'.repeat(64),trackB='b'.repeat(64);
  const context=vm.createContext({cleanUserId:value=>String(value||'')});
  runClientSource(section('  let profilePlacementMergeCache=null;', '  function ensureRecordPlacementUi('),context);
  const overall={source:'edge',revision:8,sourceRevision:8,builtRevision:8,serverUpdatedAt:700,updatedAt:700,
    algorithmVersion:'ranked-model',schemaVersion:5,entries:[{userId:accountId,resultSamples:[
      {trackId:trackA,rank:8,fieldSize:20,timeMs:1100,snapshotCapturedAt:700}
    ]},{userId:'other'}]};
  const profile={accountId,updatedAt:900,results:[
    {trackId:trackA,rank:4,fieldSize:20,timeMs:1000,snapshotCapturedAt:900,complete:true},
    {trackId:trackB,rank:2,fieldSize:10,timeMs:800,complete:false}
  ]};
  let merged=context.mergeProfilePlacementSnapshot(overall,profile,accountId);
  let placements=preparePolyTrackOverallPlacements(merged,accountId,{authoritative:true,expectedAlgorithmVersion:'ranked-model',minSchemaVersion:5});
  assert.equal(placements.get(trackA).timeMs,1000);assert.equal(placements.get(trackA).rank,4);
  assert.equal(placements.has(trackB),false,'an incomplete board must not supply placement metadata');
  assert.ok(merged.entries.some(row=>row.userId==='other'),'other overall racers are retained');

  merged=context.mergeProfilePlacementSnapshot(null,profile,accountId);
  placements=preparePolyTrackOverallPlacements(merged,accountId,{authoritative:true});
  assert.equal(placements.get(trackA).fieldSize,20);
  assert.equal(placements.has(trackB),false);
  const local=context.mergeProfilePlacementSnapshot({...overall,source:'local'},profile,accountId);
  assert.equal(local.source,'public-backup','local state is not promoted to authoritative');
});

test('same-PB profile placement replaces overall only when its per-row observation is newer',()=>{
  const accountId='h'.repeat(64),track='a'.repeat(64);
  const context=vm.createContext({cleanUserId:value=>String(value||'')});
  runClientSource(section('  let profilePlacementMergeCache=null;', '  function ensureRecordPlacementUi('),context);
  const overall={source:'live',entries:[{userId:accountId,resultSamples:[
    {trackId:track,rank:6,fieldSize:20,timeMs:1000,snapshotCapturedAt:900}
  ]}]};
  const profile={accountId,updatedAt:2000,results:[
    {trackId:track,rank:4,fieldSize:20,timeMs:1000,snapshotCapturedAt:800,complete:true}
  ]};
  let merged=context.mergeProfilePlacementSnapshot(overall,profile,accountId);
  assert.equal(merged.entries[0].resultSamples[0].rank,6,'stale profile rank cannot regress newer live observation');
  profile.results=[{...profile.results[0],timeMs:900}];
  merged=context.mergeProfilePlacementSnapshot(overall,profile,accountId);
  assert.equal(merged.entries[0].resultSamples[0].timeMs,1000,'a faster but stale snapshot cannot resurrect an older PB');
  profile.results=[{...profile.results[0],timeMs:1000,snapshotCapturedAt:1000}];
  merged=context.mergeProfilePlacementSnapshot(overall,profile,accountId);
  assert.equal(merged.entries[0].resultSamples[0].rank,4,'newer per-row observation may update the same PB placement');
  const unknownFreshness={...overall,entries:[{...overall.entries[0],resultSamples:[{trackId:track,rank:6,fieldSize:20,timeMs:1000}]}]};
  profile.results=[{...profile.results[0],snapshotCapturedAt:800}];
  merged=context.mergeProfilePlacementSnapshot(unknownFreshness,profile,accountId);
  assert.equal(merged.entries[0].resultSamples[0].rank,6,'unknown overall freshness is not treated as older');
  assert.equal(context.mergeProfilePlacementSnapshot(unknownFreshness,{...profile,accountId:'x'.repeat(64)},accountId),unknownFreshness,
    'a profile with a conflicting root account ID is rejected');
});

test('menu placement merge reuses its result until snapshot or profile results are replaced',()=>{
  const accountId='h'.repeat(64),track='a'.repeat(64);
  const context=vm.createContext({cleanUserId:value=>String(value||'')});
  runClientSource(section('  let profilePlacementMergeCache=null;', '  function ensureRecordPlacementUi('),context);
  const snapshot={source:'live',entries:[{userId:accountId,resultSamples:[]}]};
  const profile={accountId,updatedAt:10,results:[{trackId:track,rank:3,fieldSize:12,timeMs:900,snapshotCapturedAt:20,complete:true}]};
  const first=context.mergeProfilePlacementSnapshot(snapshot,profile,accountId);
  assert.equal(context.mergeProfilePlacementSnapshot(snapshot,profile,accountId),first,'unchanged inputs reuse the merged object');
  profile.results=[{trackId:track,rank:2,fieldSize:12,timeMs:900,snapshotCapturedAt:30,complete:true}];
  const refreshed=context.mergeProfilePlacementSnapshot(snapshot,profile,accountId);
  assert.notEqual(refreshed,first,'replacement results invalidate the memo even with unchanged updatedAt and count');
  assert.equal(refreshed.entries[0].resultSamples[0].rank,2);
});

test('idle visitors and another account saved runs never unlock live standings',()=>{
  let now=Date.UTC(2026,9,7),rows=[];
  const context=vm.createContext({Date:{now:()=>now},activeRankedAccountId:()=> 'self',readOverallSnapshotCache:()=>null,
    readLocalRaceRows:()=>rows,canonicalRaceTimeMs:row=>row.timeMs||0,snapshotRacerDirectoryEntries:{},localStorage:{getItem:()=>null,setItem:()=>{}}});
  runClientSource(section('  const NEW_ACCOUNT_SNAPSHOT_MS=', '  let localOverallController=').replace('const PUBLIC_STANDINGS_SNAPSHOT_ONLY=true','const PUBLIC_STANDINGS_SNAPSHOT_ONLY=false'),context);
  assert.equal(context.snapshotOnlyForNewAccount(),true);now+=86400000;
  assert.equal(context.snapshotOnlyForNewAccount(),true);
  rows=[{accountId:'other',timeMs:12345},{accountId:'self',timeMs:0}];assert.equal(context.snapshotOnlyForNewAccount(),true);
  rows.push({accountId:'self',timeMs:12345});assert.equal(context.snapshotOnlyForNewAccount(),false);
});

test('new-account gate tolerates blocked storage and rejects future timestamps',()=>{
  const now=Date.UTC(2026,9,7);
  for(const storage of [{getItem:()=>String(now+86400000),setItem:()=>{}},{getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}}]){
    const context=vm.createContext({Date:{now:()=>now},activeRankedAccountId:()=>'',readOverallSnapshotCache:()=>null,readLocalRaceRows:()=>[],canonicalRaceTimeMs:()=>0,snapshotRacerDirectoryEntries:{},localStorage:storage});
    runClientSource(section('  const NEW_ACCOUNT_SNAPSHOT_MS=', '  let localOverallController=').replace('const PUBLIC_STANDINGS_SNAPSHOT_ONLY=true','const PUBLIC_STANDINGS_SNAPSHOT_ONLY=false'),context);
    assert.equal(context.snapshotOnlyForNewAccount(),true);
  }
});

test('new accounts cannot bypass snapshot mode with refresh or missing event snapshots',async()=>{
  let reads=0;
  const context=vm.createContext({snapshotOnlyForNewAccount:()=>true,readPublicSnapshotBackup:async()=>null,
    rankedEdgeAvailable:()=>{reads++;return true;},db:async()=>{reads++;throw Error('Unexpected cloud');}});
  runClientSource(section('  async function fetchRankedSnapshot(', '  function rankedNotifyQueue('),context);
  assert.equal(await context.fetchRankedSnapshot('overall','',{refresh:true}),null);
  runClientSource(section('  async function loadEventCloudRead(', '  const archiveMonthReads='),context);
  await assert.rejects(context.loadEventCloudRead('/v1/events/d_new/snapshot','0.6.2_event_public','d_new'),/Saved standings are unavailable/);
  assert.equal(reads,0);
});

test('native replay loading resolves packaged recordings without opening Firestore',async()=>{
  let cloud=0,active=0,peak=0;
  const context=vm.createContext({readRecordingStore:ids=>ids.map(()=>null),cachedNativeRecording:row=>row||null,
    nativeRecordingMemory:new Map(),nativeRecordingRequests:new Map(),nativeRecordingRetryAt:new Map(),nativeRecordingEpoch:0,
    playbackWorkerBridgePromise:Promise.resolve(null),
    currentTrackLoadState:{trackId:''},Date,rememberNativeRecording:()=>{},
    readPublicSnapshotBackup:async(kind,id)=>{assert.equal(kind,'recording');active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return {recording:id,frames:1};},
    db:async()=>{cloud++;throw Error('Unexpected cloud');}});
  runClientSource(section('  async function readNativeRecordings(', '  const LOCAL_RACE_STORE_KEY'),context);
  const ids=Array.from({length:10},(_,i)=>i+1),rows=await context.readNativeRecordings(ids);
  assert.equal(rows.length,10);assert.equal(cloud,0);assert.ok(peak<=4);
  assert.deepEqual(Array.from(rows,row=>row.recording),ids.map(String));
});

test('native replay package epoch invalidation discards an in-flight static response without caching it',async()=>{
  let release,remembered=0,cloud=0;
  const context=vm.createContext({readRecordingStore:ids=>ids.map(()=>null),cachedNativeRecording:row=>row||null,
    nativeRecordingMemory:new Map(),nativeRecordingRequests:new Map(),nativeRecordingRetryAt:new Map(),nativeRecordingEpoch:0,
    playbackWorkerBridgePromise:Promise.resolve(null),
    currentTrackLoadState:{trackId:''},Date,rememberNativeRecording:()=>{remembered++;},
    readPublicSnapshotBackup:()=>new Promise(resolve=>{release=resolve;}),
    db:()=>{cloud++;throw Error('Unexpected cloud');}});
  runClientSource(section('  async function readNativeRecordings(', '  const LOCAL_RACE_STORE_KEY'),context);
  const pending=context.readNativeRecordings([42]);context.nativeRecordingEpoch++;
  release({recording:'old-package',frames:1});
  assert.deepEqual(Array.from(await pending),[null]);assert.equal(remembered,0);assert.equal(cloud,0);
});

test('native gated rows use the reader preparation hook and await bridge refresh before dispatch',async()=>{
  const trackId='a'.repeat(64),prepared=[],refreshed=[];let release,done=false,cloud=0;
  const normal={recording:'normal-cached-bytes',frames:10,verifiedState:1};
  const entries=[42,43].map(uploadId=>({trackId,uploadId,frames:900}));
  const bridge={refreshPreparedRecording:async(recording,frames)=>{
    refreshed.push([recording,frames]);
    if(recording==='gated-42')await new Promise(resolve=>{release=resolve;});
    if(recording==='gated-43')throw Error('Prepared playback token expired');
  }};
  const context=vm.createContext({Date,nativeRecordingEpoch:0,currentTrackLoadState:{trackId},
    nativeRecordingMemory:new Map(),nativeRecordingRequests:new Map(),nativeRecordingRetryAt:new Map(),
    readRecordingStore:ids=>ids.map(id=>id===44?normal:null),cachedNativeRecording:row=>row||null,
    rememberNativeRecording:()=>{},playbackWorkerBridgePromise:Promise.resolve(bridge),
    readPublicSnapshotBackup:async kind=>kind==='track'?{trackId,entries}:{recording:'raw-must-not-bypass-gate',frames:900},
    publicSnapshotReaderPromise:Promise.resolve({recordingPlayback:async(entry,options)=>{
      assert.equal(entry.trackId,trackId);assert.equal(options.allowPending,true);prepared.push(entry.uploadId);
      return {recording:'gated-'+entry.uploadId,frames:entry.frames,playbackPending:true};
    }}),db:()=>{cloud++;throw Error('Unexpected cloud');}});
  runClientSource(section('  async function readNativeRecordings(', '  const LOCAL_RACE_STORE_KEY'),context);
  const pending=context.readNativeRecordings([42,43,44]).then(rows=>{done=true;return rows;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(prepared,[42,43]);assert.equal(typeof release,'function');assert.equal(done,false,'dispatch must wait for prepared token refresh');
  release();const rows=await pending;
  assert.equal(rows[0].recording,'gated-42');assert.equal(rows[1],null,'refresh failure must not dispatch stale gated bytes');
  assert.equal(rows[2],normal,'the ordinary cached native path must remain unchanged');
  assert.deepEqual(refreshed,[['gated-42',900],['gated-43',900],['normal-cached-bytes',10]]);
  assert.equal(cloud,0);
});

test('Overall refresh stays static while explicit track refresh may read live data',async()=>{
  let cloud=0;const snapshot={entries:[],_publicBackup:true},live={entries:[]};
  const context=vm.createContext({readPublicSnapshotBackup:async()=>snapshot,publicSnapshotRetryAt:0,Date,
    snapshotOnlyForNewAccount:()=>false,
    rankedEdgeAvailable:()=>true,rankedBrokerUrl:()=> 'https://example.test',AbortSignal,
    withTimeout:value=>value,clearRankedEdgeFailure:()=>{},markRankedEdgeUnavailable:()=>{},
    fetch:async()=>{cloud++;return {status:200,ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>live};}});
  const start=source.indexOf('  async function fetchRankedSnapshot('),end=source.indexOf('\n  function ',start);
  // Include only this function so the test exercises the production routing.
  runClientSource(source.slice(start,end),context);
  assert.equal(await context.fetchRankedSnapshot('overall'),snapshot);assert.equal(cloud,0);
  assert.equal(await context.fetchRankedSnapshot('overall','',{refresh:true}),snapshot);assert.equal(cloud,0);
  assert.equal(await context.fetchRankedSnapshot('track','track',{refresh:true}),live);assert.equal(cloud,1);
});

test('actual event bridge serves finalized static archives without a Worker or Firestore read',async()=>{
  const saved={id:'d_old',archived:true};let cloud=0;
  const context=vm.createContext({snapshotOnlyForNewAccount:()=>false,readPublicSnapshotBackup:async()=>saved,rankedEdgeAvailable:()=>{cloud++;return true;}});
  runClientSource(section('  async function loadEventCloudRead(', '  const archiveMonthReads='),context);
  const result=await context.loadEventCloudRead('/v1/events/d_old/snapshot','0.6.2_event_public','d_old');
  assert.equal(result,saved);assert.equal(cloud,0);
});

test('actual event bridge reads live only on explicit refresh',async()=>{
  let cloud=0;const live={id:'d_live',archived:false};
  const context=vm.createContext({snapshotOnlyForNewAccount:()=>false,readPublicSnapshotBackup:async()=>live,eventCloudRetryAt:new Map(),rankedEdgeAvailable:()=>true,
    rankedBrokerUrl:()=> 'https://example.test',eventRequestSignal:()=>undefined,log:()=>{},AbortSignal,fetch:async()=>{cloud++;return {status:200,ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>live};}});
  runClientSource(section('  async function loadEventCloudRead(', '  const archiveMonthReads='),context);
  const saved=await context.loadEventCloudRead('/v1/events/d_live/snapshot','0.6.2_event_public','d_live');
  assert.equal(saved,live);assert.equal(cloud,0);
  const result=await context.loadEventCloudRead('/v1/events/d_live/snapshot','0.6.2_event_public','d_live',true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{...live,_eventLiveCheckedAt:result._eventLiveCheckedAt});
  assert.ok(Number.isSafeInteger(result._eventLiveCheckedAt)&&result._eventLiveCheckedAt>0);
  assert.equal(live._eventLiveCheckedAt,undefined,'source data is not mutated');
  assert.equal(cloud,1);
});

test('actual replay bridge serves archived recordings from static files without cloud reads',async()=>{
  const payload={replay:'encoded'};let cloud=0;
  const context=vm.createContext({eventReplayRequests:new Map(),readPublicSnapshotBackup:async kind=>kind==='event'?{archived:true}:payload,
    rankedEdgeAvailable:()=>{cloud++;return true;}});
  runClientSource(section('  async function readEventReplay(', '  async function ensureEventUi('),context);
  assert.equal(await context.readEventReplay('d_old','a'.repeat(64)),payload);assert.equal(cloud,0);
});


test('a newer package waits for its correct board instead of painting stale players first',async()=>{
 const old={entries:[{accountId:'old',runVerified:false}],fetchedAt:100000};let resolve,loads=0,painted;
 const context=vm.createContext({Date:{now:()=>100000},unrankedExtraTrackIds:new Set(),readTrackSnapshotCache:()=>old,
 readPublicSnapshotBackup:async()=>({tracks:{}}),trackSnapshotMetadataIsNewer:()=>true,trackEntryRequests:new Map(),
 loadTrackEntries:()=>{loads++;return new Promise(done=>resolve=done);}});
 runClientSource(section('  async function getTrackEntries(', '  const nativeTrackSnapshotRefreshes='),context);
 const pending=context.getTrackEntries('track',10).then(rows=>painted=rows);await new Promise(r=>setImmediate(r));
 assert.equal(loads,1);assert.equal(painted,undefined);resolve([{accountId:'new',runVerified:true}]);await pending;
 assert.equal(painted[0].accountId,'new');assert.equal(painted[0].runVerified,true);
});

test('background replacement schedules the visible native rows to refresh exactly once',async()=>{
 let cached={entries:[{accountId:'old',runVerified:false}],fetchedAt:0},resolve;const refreshes=[];
 const context=vm.createContext({Date:{now:()=>100000},TRACK_REFRESH_MS:100,unrankedExtraTrackIds:new Set(),readTrackSnapshotCache:()=>cached,
 trackSnapshotMetadataIsNewer:()=>false,selectCachedTrackState:()=>{},trackEntryRequests:new Map(),trackCacheBackgroundRefreshAt:new Map(),
 loadTrackEntries:()=>new Promise(done=>resolve=done),scheduleNativeTrackSnapshotRefresh:id=>refreshes.push(id)});
 runClientSource(section('  async function getTrackEntries(', '  const nativeTrackSnapshotRefreshes='),context);
 assert.equal((await context.getTrackEntries('track',10))[0].accountId,'old');
 await context.getTrackEntries('track',10);cached={entries:[{accountId:'new',runVerified:true}],fetchedAt:100000};resolve(cached.entries);
 await new Promise(r=>setImmediate(r));assert.deepEqual(refreshes,['track']);
});

function repaintFixture(){
 const timers=new Map();let next=0,clicks=0,verified=true,account='one';
 const policy={disabled:false,click(){clicks++;verified=!verified;}};
 const originalHost={visible:true,querySelector:()=>policy};let host=originalHost;
 const context=vm.createContext({getTrackEntries:{selection:{id:'track'}},activeRankedAccountId:()=>account,
   setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),
   currentTrackLoadState:{trackId:'track'},isElementVisible:node=>Boolean(node?.visible),
   document:{getElementById:()=>null,querySelector:()=>host}});
 runClientSource(section('  const nativeTrackSnapshotRefreshes=', '  function trackSnapshotMetadataIsNewer('),context);
 return {context,originalHost,timers,schedule:()=>context.scheduleNativeTrackSnapshotRefresh('track'),
   flush(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}},
   setAccount:value=>{account=value;},setHost:value=>{host=value;},clicks:()=>clicks,verified:()=>verified};
}
test('cache repaint coalesces and preserves the native verification policy',()=>{
 const f=repaintFixture();f.schedule();f.schedule();assert.equal(f.timers.size,1);f.flush();
 assert.equal(f.clicks(),2);assert.equal(f.verified(),true);
});
for(const stale of ['track','selection','account','host','exit'])test('cache repaint ignores stale '+stale+' ownership',()=>{
 const f=repaintFixture();f.schedule();
 if(stale==='track')f.context.currentTrackLoadState.trackId='other';
 if(stale==='selection')f.context.getTrackEntries.selection={id:'track'};
 if(stale==='account')f.setAccount('two');
 if(stale==='host')f.setHost({...f.originalHost});
 if(stale==='exit')f.originalHost.visible=false;
 f.flush();assert.equal(f.clicks(),0);assert.equal(f.verified(),true);
});

test('package revision detects a newer board even with a tied timestamp, without replacing a newer live revision',()=>{
 const context=vm.createContext({snapshotTrackStatistics:{track:{updatedAt:500,revision:3}}});
 runClientSource(section('  function trackSnapshotMetadataIsNewer(', '  async function loadTrackEntries('),context);
 assert.equal(context.trackSnapshotMetadataIsNewer('track',{serverUpdatedAt:500,revision:2}),true);
 assert.equal(context.trackSnapshotMetadataIsNewer('track',{serverUpdatedAt:400,revision:4}),false);
});

test('a complete package hydrates a same-revision truncated cache without a timestamp bump',()=>{
 const context=vm.createContext({snapshotTrackStatistics:{track:{complete:true,totalEntries:650,updatedAt:500,revision:3}}});
 runClientSource(section('  function trackSnapshotMetadataIsNewer(', '  async function loadTrackEntries('),context);
 assert.equal(context.trackSnapshotMetadataIsNewer('track',{complete:false,entries:Array(500),serverUpdatedAt:500,revision:3}),true);
 assert.equal(context.trackSnapshotMetadataIsNewer('track',{complete:true,entries:Array(650),serverUpdatedAt:500,revision:3}),false);
 assert.equal(context.trackSnapshotMetadataIsNewer('track',{complete:false,entries:Array(500),serverUpdatedAt:600,revision:4}),false);
});

test('expired cached boards check live in background and manual refresh joins that request',async()=>{
 let release,calls=0;const cached={entries:[{userId:'a'.repeat(64)}],fetchedAt:0};
 const context=vm.createContext({Date:{now:()=>100000},unrankedExtraTrackIds:new Set(),readTrackSnapshotCache:()=>cached,TRACK_REFRESH_MS:100,
   trackSnapshotMetadataIsNewer:()=>false,trackEntryRequests:new Map(),trackCacheBackgroundRefreshAt:new Map(),
   loadTrackEntries:(_id,_limit,refresh)=>{assert.equal(refresh,true);calls++;return new Promise(done=>release=()=>done(cached.entries));}});
 runClientSource(section('  async function getTrackEntries(', '  function trackSnapshotMetadataIsNewer('),context);
 assert.equal((await context.getTrackEntries('track',10)).length,1);
 assert.equal(context.trackEntryRequests.get('track').ptForceCloud,true);
 const manual=context.getTrackEntries('track',10,true);release();await manual;assert.equal(calls,1);
});

test('an old immutable snapshot board does not start a live background refresh',async()=>{
 let loads=0;const cached={source:'public-backup',entries:[{accountId:'saved'}],fetchedAt:0};
 const context=vm.createContext({Date:{now:()=>1000000},TRACK_REFRESH_MS:1,unrankedExtraTrackIds:new Set(),readTrackSnapshotCache:()=>cached,
  trackSnapshotMetadataIsNewer:()=>false,trackEntryRequests:new Map(),trackCacheBackgroundRefreshAt:new Map(),loadTrackEntries:()=>{loads++;throw Error('unexpected live read');}});
 runClientSource(section('  async function getTrackEntries(', '  const nativeTrackSnapshotRefreshes='),context);
 await context.getTrackEntries('track',10);await context.getTrackEntries('track',10);
 assert.equal(loads,0);assert.equal(context.trackEntryRequests.size,0);
});

test('selected live event replay bypasses a stale saved binding but matching snapshots stay read-free',async()=>{
 const period='d_live',account='a'.repeat(64),track='b'.repeat(64);
 const saved={periodId:period,accountId:account,trackId:track,timeMs:10000,runId:'old'},live={...saved,timeMs:9000,runId:'new',replay:'payload',replayHash:'239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5'};
 let cloud=0,gate;
 const context=vm.createContext({eventReplayRequests:new Map(),readPublicSnapshotBackup:async kind=>kind==='event'?{archived:false}:saved,
 crypto:globalThis.crypto,TextEncoder,compatibilityOnlineAllowed:true,rankedEdgeAvailable:()=>true,rankedBrokerUrl:()=> 'https://example.test',eventRequestSignal:()=>undefined,markRankedEdgeUnavailable:()=>{},
 fetch:async()=>{cloud++;if(gate)await gate;return {ok:true,headers:new Headers(),text:async()=>JSON.stringify(live)};}});
 runClientSource(section('  async function readEventReplay(', '  async function ensureEventUi('),context);
 assert.equal(await context.readEventReplay(period,account,null,{timeMs:10000,trackId:track,runId:'old'}),saved);assert.equal(cloud,0);
 let release;gate=new Promise(resolve=>release=resolve);
 const expected={timeMs:9000,trackId:track,runId:'new'},a=context.readEventReplay(period,account,null,expected),b=context.readEventReplay(period,account,null,expected);
 release();assert.equal((await a).timeMs,9000);assert.equal((await b).runId,'new');assert.equal(cloud,1,'concurrent selection shares the fallback');
});
test('frozen replay mismatches and unavailable live replays never return stale recordings',async()=>{
 const period='d_old',account='a'.repeat(64),track='b'.repeat(64),saved={periodId:period,accountId:account,trackId:track,timeMs:10000};
 let archived=true,cloud=0;
 const context=vm.createContext({eventReplayRequests:new Map(),readPublicSnapshotBackup:async kind=>kind==='event'?{archived}:saved,
 compatibilityOnlineAllowed:false,rankedEdgeAvailable:()=>{cloud++;return false;}});
 runClientSource(section('  async function readEventReplay(', '  async function ensureEventUi('),context);
 const expected={timeMs:9000,trackId:track};
 await assert.rejects(context.readEventReplay(period,account,null,expected),/Archived replay/);assert.equal(cloud,0);
 archived=false;await assert.rejects(context.readEventReplay(period,account,null,expected),/matching recording/);
 assert.equal(cloud,0,'compatibility lockdown performs no network request');
});

test('default public standings are snapshot-only without an account-age or saved-finish lookup',()=>{
 const context=vm.createContext({readOverallSnapshotCache:()=>assert.fail('No age lookup'),readLocalRaceRows:()=>assert.fail('No finish lookup'),localStorage:{getItem:()=>assert.fail('No age storage read')}});
 runClientSource(section('  const NEW_ACCOUNT_SNAPSHOT_MS=', '  let localOverallController='),context);assert.equal(context.snapshotOnlyForNewAccount(),true);
});
