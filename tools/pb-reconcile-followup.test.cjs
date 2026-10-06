const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8');

function productionHarness({rows,readDoc,paused=()=>false,readRecordingStore=()=>[]}={}){
  const start=source.indexOf('  function localPbSyncSignature(row){');
  const end=source.indexOf('  function hookLegacyNetworking(){',start);
  assert.ok(start>=0&&end>start,'production reconcile and scheduling functions exist');
  let now=1000000,timerId=0;
  const timers=new Map(),storage=new Map();
  const context={
    Date:{now:()=>now},Math,JSON,Map,Array,String,Number,Error,
    LOCAL_PB_RECONCILE_STATE_KEY:'state',FIREBASE_QUOTA_PAUSE_KEY:'quota',OVERALL_PB_DIRTY_KEY:'dirty',
    COLLECTIONS:{raceResults:'race_results'},localPbReconcilePromises:new Map(),localPbReconcileTimers:new Map(),
    cleanUserId:x=>String(x||''),activeRankedAccountId:()=> 'acct',isCurrentLocalPbReconcileIdentity:(id,uid)=>id==='acct'&&(!uid||uid==='uid'),
    localBestRowsForAccount:()=>rows,
    canonicalRaceTimeMs:r=>Number(r?.timeMs||0),localPbSyncSignature:r=>JSON.stringify([String(r.trackId||''),Number(r.timeMs||0),String(r.replayHash||'')]),
    readJsonStorage:(key,fallback)=>storage.has(key)?storage.get(key):fallback,writeJsonStorage:(key,value)=>storage.set(key,JSON.parse(JSON.stringify(value))),
    firebaseQuotaPaused:paused,noteFirebaseQuota:()=>{},
    setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    window:{firebase:{auth:()=>({currentUser:{uid:'uid'}})}},
    db:async()=>({collection:()=>({doc:id=>({get:async()=>readDoc(id)})})}),
    cloudOwnerConflicts:new Map(),showCloudOwnerConflict:()=>{},assertCloudOwner:()=>{},
    readRecordingStore,safeRecordingId:x=>x,normalizeReplayPayloadString:x=>String(x||''),
    safePositiveInt:x=>Number(x)||1,getLastKnownName:()=>'',getDefaultCarStyle:()=>'',
    mirrorRaceResult:async()=>({saved:true}),addLocalRaceRow:()=>{},rememberConfirmedLocalPb:(id,row)=>{
      const state=context.readJsonStorage('state',{})||{};state[id]??={};state[id].confirmed??={};state[id].confirmed[row.trackId]=context.localPbSyncSignature(row);context.writeJsonStorage('state',state);
    },
    writeJsonStorage:undefined,log:()=>{},overallLoadState:{},
  };
  context.writeJsonStorage=(key,value)=>storage.set(key,JSON.parse(JSON.stringify(value)));
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  context.advance=ms=>{now+=ms;};context.timers=timers;context.storage=storage;
  return context;
}

function docMissing(){return {exists:false,metadata:{fromCache:false}};}

test('actual reconcile rotates past 16 permanently denied rows and uploads row 17 within batch limit',async()=>{
  const rows=Array.from({length:17},(_,i)=>({trackId:`t${String(i).padStart(2,'0')}`,timeMs:10000+i,replayHash:`h${i}`,replay:i===16?'replay':''}));
  const read=[];let uploaded=0;
  const h=productionHarness({rows,readDoc:async id=>{read.push(id);if(!id.endsWith('_t16')){const e=Error('row denied');e.code='permission-denied';throw e;}return docMissing();}});
  h.mirrorRaceResult=async(url,payload)=>{uploaded++;h.rememberConfirmedLocalPb('acct',payload);return {saved:true};};
  const result=await h.reconcileLocalPersonalBestsToCloud('acct');
  assert.equal(result.checked,16);assert.equal(read.length,16);assert.equal(uploaded,0);
  assert.ok(result.remaining>0);assert.equal(h.storage.get('state').acct.fingerprint,null);
  h.advance(5*60*1000);read.length=0;
  const second=await h.reconcileLocalPersonalBestsToCloud('acct');
  assert.equal(second.checked,16);assert.equal(read.length,16);assert.ok(read.includes('acct_t16'));assert.equal(uploaded,1);
  assert.equal(second.remaining,16,'failed rows remain unconfirmed');
});

test('actual reconcile catches an early document rejection and progresses to later rows',async()=>{
  const rows=Array.from({length:17},(_,i)=>({trackId:`t${i}`,timeMs:10000+i,replay:'r'}));let calls=0;
  const h=productionHarness({rows,readDoc:async id=>{calls++;if(id.endsWith('_t0'))throw Error('temporary row read failure');return docMissing();}});
  const result=await h.reconcileLocalPersonalBestsToCloud('acct');
  assert.equal(result.checked,16);assert.equal(calls,16);assert.equal(result.failed,1);
  assert.equal(h.storage.get('state').acct.fingerprint,null);
});

test('scheduled quota-deferred callback rearms beyond extended quota expiry',async()=>{
  const h=productionHarness({rows:[{trackId:'t',timeMs:1}],readDoc:async()=>docMissing(),paused:()=>true});
  h.storage.set('quota',h.Date.now()+180000);
  h.scheduleLocalPbCloudReconcile('acct',900);
  let [id,timer]=[...h.timers][0];h.timers.delete(id);timer.fn();
  await new Promise(resolve=>setImmediate(resolve));
  const replacement=[...h.timers.values()][0];assert.ok(replacement);assert.ok(replacement.delay>=180000);
});

test('ordinary debounce cannot erase a pending retry cooldown',()=>{
  const h=productionHarness({rows:[{trackId:'t',timeMs:1}],readDoc:async()=>docMissing()});
  h.storage.set('state',{acct:{retryAt:h.Date.now()+240000}});
  h.scheduleLocalPbCloudReconcile('acct',900);
  assert.ok([...h.timers.values()][0].delay>=240000);
});

test('global quota raised during a row stops the current batch',async()=>{
  const rows=Array.from({length:3},(_,i)=>({trackId:`t${i}`,timeMs:10+i,replay:'r'}));
  let quota=false,calls=0;
  const h=productionHarness({rows,readDoc:async()=>{calls++;return docMissing();},paused:()=>quota});
  h.mirrorRaceResult=async()=>{quota=true;h.storage.set('quota',h.Date.now()+60000);return {saved:false};};
  await assert.rejects(h.reconcileLocalPersonalBestsToCloud('acct'),/quota cooldown/);
  assert.equal(calls,1,'later rows are not processed after quota pauses');
});

test('unchanged missing-replay rows wait for changed local evidence without confirmation',async()=>{
  const row={trackId:'t',timeMs:10000,replayHash:'same',replay:''};
  const h=productionHarness({rows:[row],readDoc:async()=>docMissing()});
  h.mirrorRaceResult=async(url,payload)=>{h.rememberConfirmedLocalPb('acct',payload);return {saved:true};};
  const first=await h.reconcileLocalPersonalBestsToCloud('acct');
  assert.equal(first.failed,1);assert.equal(h.storage.get('state').acct.confirmed,undefined);
  assert.equal(h.storage.get('state').acct.waitingReplay.t,h.localPbSyncSignature(row));
  assert.equal(h.timers.size,0,'waiting-only rows do not schedule repeated reads');
  const readCount=h.timers.size;
  const notRetried=await h.reconcileLocalPersonalBestsToCloud('acct');
  assert.equal(notRetried.deferred,true,'cooldown prevents unchanged missing-replay rereads');
  row.replay='now available';row.replayHash='changed';
  h.advance(5*60*1000);
  const second=await h.reconcileLocalPersonalBestsToCloud('acct');
  assert.equal(second.checked,1);
  assert.notEqual(h.storage.get('state').acct.confirmed.t,undefined);
  assert.ok(readCount>=0);
});

test('restored stored replay makes same-signature waiting PB eligible immediately',async()=>{
  const row={trackId:'t',timeMs:10000,replayHash:'unchanged-hash',uploadId:'upload-1'};
  let storedRecording='';let reads=0,uploads=0;
  const h=productionHarness({rows:[row],readDoc:async()=>{reads++;return docMissing();},readRecordingStore:()=>storedRecording?[{recording:storedRecording}]:[]});
  h.mirrorRaceResult=async(url,payload)=>{uploads++;assert.equal(payload.recording,'restored replay');h.rememberConfirmedLocalPb('acct',payload);return {saved:true};};
  const signature=h.localPbSyncSignature(row);
  const first=await h.reconcileLocalPersonalBestsToCloud('acct');
  assert.equal(first.failed,1);assert.equal(h.storage.get('state').acct.waitingReplay.t,signature);
  assert.equal(h.timers.size,0);
  storedRecording='restored replay';
  const retried=await h.reconcileLocalPersonalBestsToCloud('acct');
  assert.equal(retried.checked,1);assert.equal(reads,2);assert.equal(uploads,1);
  assert.equal(h.localPbSyncSignature(row),signature,'PB time and hash did not change');
  assert.equal(h.storage.get('state').acct.waitingReplay.t,undefined);
  assert.notEqual(h.storage.get('state').acct.confirmed.t,undefined);
});
