import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
function section(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}

test('protected refresh control visibly locks and unlocks without changing loading-owned disabled state',()=>{
  let locked=true;const attrs=new Map();
  const button={disabled:false,dataset:{},style:{removeProperty:()=>{}},setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k)};
  const context=vm.createContext({String,snapshotOnlyForNewAccount:()=>locked,snapshotUnlockLabel:()=> 'Live refresh unlocks in 10:00',snapshotCaptureLabel:()=> 'Snapshot captured 2 hours ago'});
  vm.runInContext(section('  function syncSnapshotRefreshControl(', '  async function readPublicSnapshotBackup('),context);
  context.syncSnapshotRefreshControl(button);assert.equal(button.disabled,true);assert.match(button.title,/Live refresh unlocks in 10:00/);assert.equal(attrs.get('aria-disabled'),'true');
  context.syncSnapshotRefreshControl(button);locked=false;context.syncSnapshotRefreshControl(button);assert.equal(button.disabled,false);
  button.disabled=true;locked=true;context.syncSnapshotRefreshControl(button);locked=false;context.syncSnapshotRefreshControl(button);assert.equal(button.disabled,true);
});
test('snapshot age labels do not pretend each track was updated when the snapshot was captured',()=>{
  const context=vm.createContext({publicSnapshotCapturedAt:123,ageLabel:at=>{assert.equal(at,123);return '2 hours ago';}});
  vm.runInContext(section('  function snapshotCaptureLabel(', '  function syncSnapshotRefreshControl('),context);
  assert.equal(context.snapshotCaptureLabel(),'Snapshot captured 2 hours ago');
  context.publicSnapshotCapturedAt=0;assert.match(context.snapshotCaptureLabel(),/unavailable/);
});

test('new-account snapshot protection needs fifteen minutes and a saved finish, and survives reloads',()=>{
  let now=Date.UTC(2026,9,7),accountId='a'.repeat(64),cached=null,local=[];const storage=new Map();
  const create=()=>{
    const context=vm.createContext({Date:{now:()=>now},activeRankedAccountId:()=>accountId,
      readOverallSnapshotCache:()=>cached,readLocalRaceRows:()=>local,canonicalRaceTimeMs:row=>row.timeMs||0,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}});
    vm.runInContext(section('  const NEW_ACCOUNT_SNAPSHOT_MS=', '  let publicSnapshotReaderPromise='),context);return context;
  };
  let context=create();assert.equal(context.snapshotOnlyForNewAccount(),true);
  assert.match(context.snapshotUnlockLabel(),/15:00/);
  local=[{accountId,timeMs:12345}];
  now+=899999;context=create();assert.equal(context.snapshotOnlyForNewAccount(),true);
  assert.match(context.snapshotUnlockLabel(),/0:01/);
  now++;assert.equal(context.snapshotOnlyForNewAccount(),false);
  assert.equal(context.snapshotUnlockLabel(),'Live refresh available');
  accountId='b'.repeat(64);assert.equal(context.snapshotOnlyForNewAccount(),true);
  cached={entries:[{accountId,accountCreatedAt:now-86400000}]};assert.equal(context.snapshotOnlyForNewAccount(),false);
});
test('idle visitors and another account saved runs never unlock live standings',()=>{
  let now=Date.UTC(2026,9,7),rows=[];
  const context=vm.createContext({Date:{now:()=>now},activeRankedAccountId:()=> 'self',readOverallSnapshotCache:()=>null,
    readLocalRaceRows:()=>rows,canonicalRaceTimeMs:row=>row.timeMs||0,localStorage:{getItem:()=>null,setItem:()=>{}}});
  vm.runInContext(section('  const NEW_ACCOUNT_SNAPSHOT_MS=', '  let publicSnapshotReaderPromise='),context);
  assert.equal(context.snapshotOnlyForNewAccount(),true);now+=86400000;
  assert.equal(context.snapshotOnlyForNewAccount(),true);
  rows=[{accountId:'other',timeMs:12345},{accountId:'self',timeMs:0}];assert.equal(context.snapshotOnlyForNewAccount(),true);
  rows.push({accountId:'self',timeMs:12345});assert.equal(context.snapshotOnlyForNewAccount(),false);
});

test('new-account gate tolerates blocked storage and rejects future timestamps',()=>{
  const now=Date.UTC(2026,9,7);
  for(const storage of [{getItem:()=>String(now+86400000),setItem:()=>{}},{getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}}]){
    const context=vm.createContext({Date:{now:()=>now},activeRankedAccountId:()=>'',readOverallSnapshotCache:()=>null,localStorage:storage});
    vm.runInContext(section('  const NEW_ACCOUNT_SNAPSHOT_MS=', '  let publicSnapshotReaderPromise='),context);
    assert.equal(context.snapshotOnlyForNewAccount(),true);
  }
});

test('new accounts cannot bypass snapshot mode with refresh or missing event snapshots',async()=>{
  let reads=0;
  const context=vm.createContext({snapshotOnlyForNewAccount:()=>true,readPublicSnapshotBackup:async()=>null,
    rankedEdgeAvailable:()=>{reads++;return true;},db:async()=>{reads++;throw Error('Unexpected cloud');}});
  vm.runInContext(section('  async function fetchRankedSnapshot(', '  function rankedNotifyQueue('),context);
  assert.equal(await context.fetchRankedSnapshot('overall','',{refresh:true}),null);
  vm.runInContext(section('  async function loadEventCloudRead(', '  const archiveMonthReads='),context);
  await assert.rejects(context.loadEventCloudRead('/v1/events/d_new/snapshot','0.6.2_event_public','d_new'),/15 minutes/);
  assert.equal(reads,0);
});

test('native replay loading resolves packaged recordings without opening Firestore',async()=>{
  let cloud=0,active=0,peak=0;
  const context=vm.createContext({readRecordingStore:ids=>ids.map(()=>null),cachedNativeRecording:row=>row||null,
    nativeRecordingMemory:new Map(),nativeRecordingRetryAt:new Map(),Date,rememberNativeRecording:()=>{},
    readPublicSnapshotBackup:async(kind,id)=>{assert.equal(kind,'recording');active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return {recording:id,frames:1};},
    db:async()=>{cloud++;throw Error('Unexpected cloud');}});
  vm.runInContext(section('  async function loadNativeRecordings(', '  const LOCAL_RACE_STORE_KEY'),context);
  const ids=Array.from({length:10},(_,i)=>i+1),rows=await context.loadNativeRecordings(ids);
  assert.equal(rows.length,10);assert.equal(cloud,0);assert.ok(peak<=4);
});

test('ordinary ranked reads use snapshots while explicit refresh reads live data',async()=>{
  let cloud=0;const snapshot={entries:[],_publicBackup:true},live={entries:[]};
  const context=vm.createContext({readPublicSnapshotBackup:async()=>snapshot,publicSnapshotRetryAt:0,Date,
    snapshotOnlyForNewAccount:()=>false,
    rankedEdgeAvailable:()=>true,rankedBrokerUrl:()=> 'https://example.test',AbortSignal,
    withTimeout:value=>value,clearRankedEdgeFailure:()=>{},markRankedEdgeUnavailable:()=>{},
    fetch:async()=>{cloud++;return {status:200,ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>live};}});
  const start=source.indexOf('  async function fetchRankedSnapshot('),end=source.indexOf('\n  function ',start);
  // Include only this function so the test exercises the production routing.
  vm.runInContext(source.slice(start,end),context);
  assert.equal(await context.fetchRankedSnapshot('overall'),snapshot);assert.equal(cloud,0);
  assert.equal(await context.fetchRankedSnapshot('overall','',{refresh:true}),live);assert.equal(cloud,1);
});

test('actual event bridge serves finalized static archives without a Worker or Firestore read',async()=>{
  const saved={id:'d_old',archived:true};let cloud=0;
  const context=vm.createContext({snapshotOnlyForNewAccount:()=>false,readPublicSnapshotBackup:async()=>saved,rankedEdgeAvailable:()=>{cloud++;return true;}});
  vm.runInContext(section('  async function loadEventCloudRead(', '  const archiveMonthReads='),context);
  const result=await context.loadEventCloudRead('/v1/events/d_old/snapshot','0.6.2_event_public','d_old');
  assert.equal(result,saved);assert.equal(cloud,0);
});

test('actual event bridge still gets authoritative live standings from the Worker',async()=>{
  let cloud=0;const live={id:'d_live',archived:false};
  const context=vm.createContext({snapshotOnlyForNewAccount:()=>false,readPublicSnapshotBackup:async()=>live,rankedEdgeAvailable:()=>true,
    rankedBrokerUrl:()=> 'https://example.test',AbortSignal,fetch:async()=>{cloud++;return {status:200,ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>live};}});
  vm.runInContext(section('  async function loadEventCloudRead(', '  const archiveMonthReads='),context);
  assert.equal(await context.loadEventCloudRead('/v1/events/d_live/snapshot','0.6.2_event_public','d_live'),live);
  assert.equal(cloud,1);
});

test('actual replay bridge serves archived recordings from static files without cloud reads',async()=>{
  const payload={replay:'encoded'};let cloud=0;
  const context=vm.createContext({eventReplayRequests:new Map(),readPublicSnapshotBackup:async kind=>kind==='event'?{archived:true}:payload,
    rankedEdgeAvailable:()=>{cloud++;return true;}});
  vm.runInContext(section('  async function readEventReplay(', '  async function ensureEventUi('),context);
  assert.equal(await context.readEventReplay('d_old','a'.repeat(64)),payload);assert.equal(cloud,0);
});
