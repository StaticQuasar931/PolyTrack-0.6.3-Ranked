const {createHash}=require('node:crypto');
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'polytrack_062_patch.js'),'utf8').replace(/\r\n/g,'\n');
const baseline=(()=>{
  try{return execFileSync('git',['show','52c3fb786c160f2103402c3bf72df74236c4a611:polytrack_062_patch.js'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:8*1024*1024}).replace(/\r\n/g,'\n');}
  catch{return null;}
})();
const comparisonOptions={skip:baseline?false:'Pinned before/after commit unavailable in this checkout'};
globalThis.fetch=()=>{throw Error('NO_NETWORK_IN_MOCK_TEST');};
const account='a'.repeat(64),track='b'.repeat(64);
function extract(text,name){
  const start=text.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));
  assert.ok(start>=0,name);
  const firstLine=text.slice(start,text.indexOf('\n',start));
  if(firstLine.endsWith('}'))return firstLine;
  const end=text.indexOf('\n  }',start);
  assert.ok(end>start,name);
  return text.slice(start,end+4);
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function harness(text=source,{tracks=[track],warm=false,exact=false}={}){
  let current=account,user={uid:'owner'},gate=deferred(),failure=null,writeFailure=false,clock=1000000;
  const ledger={},docs=new Map();
  const row=id=>({accountId:account,ownerUid:'owner',trackId:id,uploadId:8,replay:warm?'repair':'old',raceTimeFrames:100,carStyle:'style',...(exact?{timeMs:100,replayHash:createHash('sha256').update('repair').digest('hex')}: {})});
  for(const id of tracks)docs.set(account+'_'+id,row(id));
  const rows=tracks.map(id=>row(id));
  const cost=id=>ledger[id]??={getCalls:0,serverDocuments:0,writes:0,deletes:0};
  const database={collection:name=>{assert.equal(name,'0.6.2_race_results');return {doc:id=>({
    get:async()=>{cost(id).getCalls++;const saved=docs.get(id);await gate.promise;if(failure)throw failure;
      cost(id).serverDocuments++;return {exists:!!saved,data:()=>saved,metadata:{fromCache:false}};},
    set:async patch=>{if(writeFailure)throw writeFailure instanceof Error?writeFailure:Error('write unavailable');cost(id).writes++;docs.set(id,{...docs.get(id),...patch});}
  })};}};
  const context={localPbDrivingActive:()=>false,readLocalRaceRows:()=>[],Date:{now:()=>clock},localRaceGeneration:0,trackCacheGeneration:0,profileSnapshotEpoch:0,sha256Hex:exact?async value=>createHash('sha256').update(value).digest('hex'):undefined,activeRankedAccountId:()=>current,window:{firebase:{auth:()=>({currentUser:user}),firestore:{FieldValue:{serverTimestamp:()=> 'server'}}}},
    runFirebaseTransaction:async(_database,callback)=>{
      const writes=[];
      const result=await callback({get:ref=>ref.get(),set:(ref,patch)=>writes.push([ref,patch])});
      for(const [ref,patch] of writes)await ref.set(patch);
      return result;
    },
    readLocalRaceRows:()=>rows,safeRecordingId:value=>Number(value)||null,COLLECTIONS:{raceResults:'0.6.2_race_results'},
    fetch:globalThis.fetch};
  vm.createContext(context);
  vm.runInContext(extract(text,'recordingRepairPatch')+'\n'+extract(text,'repairOwnNativeRecording'),context);
  return {context,database,ledger,docs,rows,
    run:(options={})=>context.repairOwnNativeRecording(options.database||database,options.recId??8,options.recording??'repair',options.payload??{frames:100},options.style??'style',options.colors??null,options.carId??null),
    advance:ms=>{clock+=ms;},release:()=>gate.resolve(),hold:()=>{gate=deferred();},fail:value=>{failure=value;},failWrite:value=>{writeFailure=value;},
    account:value=>{current=value;},user:value=>{user=value;},
    totals:()=>Object.values(ledger).reduce((sum,row)=>{for(const key in sum)sum[key]+=row[key];return sum;},{getCalls:0,serverDocuments:0,writes:0,deletes:0}),
    pending:()=>context.repairOwnNativeRecording.requests?.get(database)?.size||0};
}
async function burst(text,warm=false){
  const h=harness(text,{tracks:[track,'c'.repeat(64),'d'.repeat(64)],warm});
  const calls=Array.from({length:12},()=>h.run());h.release();
  assert.deepEqual(await Promise.all(calls),Array(12).fill(3));
  return h;
}
for(const warm of [false,true])test(`measured ${warm?'warm no-op':'cold repair'} document costs versus pinned HEAD`,comparisonOptions,async t=>{
  const before=await burst(baseline,warm),after=await burst(source,warm);
  assert.deepEqual(before.totals(),{getCalls:36,serverDocuments:36,writes:warm?0:36,deletes:0});
  assert.deepEqual(after.totals(),{getCalls:3,serverDocuments:3,writes:warm?0:3,deletes:0});
  assert.equal(after.pending(),0);
  t.diagnostic(JSON.stringify({scenario:warm?'warm-noop-12x3':'cold-repair-12x3',before:before.ledger,after:after.ledger,liveDocuments:0}));
});
test('settled repairs do not suppress fresh later reads or retain replay payloads',async()=>{
  const h=harness();h.release();await h.run();await h.run();
  assert.deepEqual(h.totals(),{getCalls:2,serverDocuments:2,writes:1,deletes:0});assert.equal(h.pending(),0);
  h.docs.set(account+'_'+track,{...h.docs.get(account+'_'+track),replay:'changed elsewhere'});
  await h.run();assert.equal(h.totals().writes,2);
});
for(const field of ['recording','payload','style','colors','carId'])test(`different ${field} cannot inherit another repair`,async()=>{
  const h=harness(),first=h.run();
  const value=field==='payload'?{frames:101}:'different';
  const second=h.run({[field]:value});assert.equal(h.totals().getCalls,2);h.release();await Promise.all([first,second]);
});
test('frame aliases with the same effective value share; invalid omitted values also share',async()=>{
  for(const payloads of [[{frames:100},{numberOfFrames:'100'},{raceTimeFrames:100}],[{},{frames:'invalid'}]]){
    const h=harness(),calls=payloads.map(payload=>h.run({payload}));assert.equal(h.totals().getCalls,1);h.release();await Promise.all(calls);
  }
});
test('a changed Firebase user object, even with the same UID, does not inherit work',async()=>{
  const h=harness(),first=h.run();h.user({uid:'owner'});const second=h.run();
  assert.equal(h.totals().getCalls,2);h.release();await Promise.all([first,second]);
});
test('separate database instances do not share',async()=>{
  const h=harness(),first=h.run(),second=h.run({database:{collection:h.database.collection}});
  assert.equal(h.totals().getCalls,2);h.release();await Promise.all([first,second]);
});
test('changed local track bindings do not reuse an incomplete in-flight track set',async()=>{
  const h=harness(),first=h.run();h.rows.push({accountId:account,trackId:'c'.repeat(64),uploadId:8});
  const second=h.run();assert.equal(h.totals().getCalls,3);h.release();assert.deepEqual(await Promise.all([first,second]),[1,1]);
});
test('read failures reject all waiters, clear state and permit a successful retry',async()=>{
  const h=harness();h.fail(Object.assign(Error('quota'),{code:'resource-exhausted'}));
  const calls=Array.from({length:12},()=>h.run()),settled=Promise.allSettled(calls);h.release();
  assert.ok((await settled).every(row=>row.status==='rejected'));
  assert.deepEqual(h.totals(),{getCalls:1,serverDocuments:0,writes:0,deletes:0});assert.equal(h.pending(),0);
  h.fail(null);await h.run();assert.equal(h.totals().getCalls,2);assert.equal(h.totals().writes,1);
});
test('failed writes are not acknowledged or cached and retries make progress',async()=>{
  const h=harness();h.failWrite(true);h.release();await assert.rejects(h.run(),/write unavailable/);
  assert.equal(h.totals().writes,0);assert.equal(h.pending(),0);h.failWrite(false);await h.run();assert.equal(h.totals().writes,1);
});
for(const change of ['account','owner','document-owner','document-account','document-track','document-recording'])test(`${change} changes cannot produce unauthorized repair writes`,async()=>{
  const h=harness();
  const field={'document-owner':'ownerUid','document-account':'accountId','document-track':'trackId','document-recording':'uploadId'}[change];
  if(field)h.docs.set(account+'_'+track,{...h.docs.get(account+'_'+track),[field]:'foreign'});
  const result=h.run();if(change==='account')h.account('other');if(change==='owner')h.user({uid:'other'});
  h.release();assert.equal(await result,0);assert.equal(h.totals().writes,0);
});
test('unknown recordings and signed-out callers cost zero documents',async()=>{
  const h=harness();assert.equal(await h.run({recId:99}),0);h.user(null);assert.equal(await h.run(),0);assert.equal(h.totals().getCalls,0);
});
test('the coalescing registry is bounded without dropping unique repairs',async()=>{
  const h=harness(),calls=Array.from({length:40},(_,index)=>h.run({recording:'replay-'+index}));
  assert.equal(h.pending(),32);assert.equal(h.totals().getCalls,40);h.release();
  assert.deepEqual(await Promise.all(calls),Array(40).fill(1));assert.equal(h.pending(),0);
});
test('cold and warm profile GETs stay on published snapshots with zero direct SDK reads',async t=>{
  for(const text of [baseline,source].filter(Boolean)){
    let snapshots=0,schedules=0;
    const context={localPbDrivingActive:()=>false,readLocalRaceRows:()=>[],URL,log(){},parsePayload:()=>({}),guestAccountId:account,accountIdFromPayload:async()=>account,
      invalidateNativePartialReplayAccount(){},localStorage:{setItem(){}},scheduleLocalPbCloudReconcile:()=>{schedules++;},
      PUBLIC_STANDINGS_SNAPSHOT_ONLY:true,readPublicSnapshotBackup:async()=>{snapshots++;return {accountId:account};},
      rememberSnapshotAccountAge(){},makeUserPayload:value=>value,db:()=>{throw Error('Unexpected SDK access');}};
    vm.createContext(context);vm.runInContext(extract(text,'snapshotOnlyForNewAccount')+'\n'+extract(text,'mockPayload'),context);
    for(let i=0;i<2;i++)assert.equal((await context.mockPayload(new URL('https://mock.invalid/user'),'GET',null)).accountId,account);
    assert.equal(snapshots,2);assert.equal(schedules,2);
  }
  t.diagnostic('Profile GET cold/warm: 0 -> 0 direct documents. PB reconciliation is scheduled separately, not treated as free.');
});

function routeHarness(text){
  const h=harness(text),c=h.context,disk=new Map();let at=1000000,localSaves=0;
  Object.assign(c,{Date:{now:()=>at},FIREBASE_QUOTA_PAUSE_KEY:'quota',readJsonStorage:(key,fallback)=>disk.get(key)??fallback,
    writeJsonStorage:(key,value)=>disk.set(key,value),assertOnlineCompatibility(){},ensureFirebaseAuthApp:async()=>{},firestorePromise:Promise.resolve(h.database),observeFirestore:async value=>value,
    log(){},parsePayload:value=>value,normalizeReplayPayloadString:value=>value,safePositiveInt:(value,fallback)=>Number(value)||fallback,
    LAST_ACTIVE_COLORS_KEY:'colors',LAST_ACTIVE_CAR_ID_KEY:'car',localStorage:{getItem:()=>null},cleanCarId:value=>value,
    recordingUploadAlreadyConfirmed:async()=>false,writeRecordingStore:()=>{localSaves++;},unrankedExtraRecordings:new Set()});
  vm.runInContext(['firebaseQuotaRetryAt','firebaseQuotaPaused','noteFirebaseQuota','db','mockPayload'].map(name=>extract(text,name)).join('\n'),c);
  return {...h,advance:ms=>{at+=ms;},localSaves:()=>localSaves,paused:()=>c.firebaseQuotaPaused(),
    post:()=>c.mockPayload(new URL('https://mock.invalid/recordings'),'POST',{recordingId:8,recording:'repair',frames:100,carStyle:'style'})};
}
for(const stage of ['read','write'])test(`actual recording route propagates ${stage} quota and resumes after cooldown`,comparisonOptions,async t=>{
  const observed=[];
  for(const [text,expectedReads] of [[baseline,2],[source,1]]){
    const h=routeHarness(text),error=Object.assign(Error('quota exhausted'),{code:'resource-exhausted'});
    if(stage==='read')h.fail(error);else h.failWrite(error);h.release();
    assert.equal((await h.post()).success,true);assert.equal((await h.post()).success,true);
    assert.equal(h.localSaves(),2);assert.equal(h.totals().getCalls,expectedReads);assert.equal(h.totals().writes,0);
    observed.push(h.totals());assert.equal(h.paused(),text===source);
    h.advance(20*60000);h.fail(null);h.failWrite(false);await h.post();
    assert.equal(h.totals().getCalls,expectedReads+1);assert.equal(h.totals().writes,1);assert.equal(h.localSaves(),3);
  }
  t.diagnostic(JSON.stringify({scenario:stage+'-quota-two-sequential-posts',before:observed[0],after:observed[1],liveDocuments:0}));
});
test('ordinary unavailable and permission failures do not impose quota cooldowns',async()=>{
  for(const code of ['unavailable','permission-denied']){
    const h=routeHarness(source);h.fail(Object.assign(Error(code),{code}));h.release();await h.post();await h.post();
    assert.equal(h.totals().getCalls,2);assert.equal(h.paused(),false);assert.equal(h.localSaves(),2);
  }
});

function pbHarness(text,mode){
  const storage=new Map(),ledger={};let timer=0;
  const row={accountId:account,ownerUid:'owner',trackId:track,timeMs:1000,replayHash:'f'.repeat(64),replay:mode==='missing-replay'?'':'r'};
  const context={localPbDrivingActive:()=>false,readLocalRaceRows:()=>[],Date:{now:()=>1000000},LOCAL_PB_RECONCILE_STATE_KEY:'state',FIREBASE_QUOTA_PAUSE_KEY:'quota',OVERALL_PB_DIRTY_KEY:'dirty',
    COLLECTIONS:{raceResults:'0.6.2_race_results'},localPbReconcilePromises:new Map(),localPbReconcileTimers:new Map(),
    activeRankedAccountId:()=>account,cleanUserId:value=>value,localBestRowsForAccount:()=>[row],canonicalRaceTimeMs:value=>Number(value?.timeMs)||0,
    readJsonStorage:(key,fallback)=>storage.has(key)?JSON.parse(JSON.stringify(storage.get(key))):fallback,
    writeJsonStorage:(key,value)=>{storage.set(key,JSON.parse(JSON.stringify(value)));return true;},
    firebaseQuotaPaused:()=>false,noteFirebaseQuota(){},scheduleLocalPbCloudReconcile(){},
    setTimeout:()=>++timer,clearTimeout(){},window:{addEventListener(){},firebase:{auth:()=>({currentUser:{uid:'owner'}})}},
    document:{addEventListener(){},visibilityState:'visible'},navigator:{onLine:true},compatibilityOnlineAllowed:true,
    cloudOwnerConflicts:new Map(),showCloudOwnerConflict(){},assertCloudOwner:(_id,owner,data)=>assert.equal(data.ownerUid,owner),
    readRecordingStore:()=>[],safeRecordingId:value=>value,normalizeReplayPayloadString:value=>String(value||''),
    mirrorRaceResult:()=>{throw Error('This fixture must not upload or execute PB verification');},log(){},overallLoadState:{},
    db:async()=>({collection:name=>{assert.equal(name,'0.6.2_race_results');return {doc:id=>({get:async options=>{
      assert.equal(options.source,'server');const count=ledger[id]??={getCalls:0,serverDocuments:0,writes:0,deletes:0};count.getCalls++;
      if(mode==='denied')throw Object.assign(Error('denied'),{code:'permission-denied'});
      count.serverDocuments++;return {exists:mode!=='missing-replay',metadata:{fromCache:false},data:()=>({...row,replayHash:mode==='conflict'?'e'.repeat(64):row.replayHash})};
    }})};}})};
  vm.createContext(context);
  const start=text.indexOf('  function localPbSyncSignature('),end=text.indexOf('  function hookLegacyNetworking(',start);
  assert.ok(start>0&&end>start);vm.runInContext(text.slice(start,end),context);
  return {context,ledger,run:()=>context.reconcileLocalPersonalBestsToCloud(account)};
}
for(const mode of ['exact','conflict','missing-replay','denied'])test(`custom PB ${mode}: cold and repeated warm document accounting`,comparisonOptions,async t=>{
  const measurements=[];
  for(const text of [baseline,source]){
    const h=pbHarness(text,mode);await h.run();const cold=JSON.parse(JSON.stringify(h.ledger));
    await h.run();await h.run();assert.deepEqual(h.ledger,cold,'warm retry must not repeat the canonical read');
    assert.equal(Object.values(cold)[0].getCalls,1);assert.equal(Object.values(cold)[0].writes,0);
    measurements.push(cold);
  }
  t.diagnostic(JSON.stringify({scenario:'custom-PB-'+mode,before:measurements[0],after:measurements[1],warmAdditionalDocuments:0,liveDocuments:0}));
});

test('exact-binding settled repair receipt eliminates duplicate reads for 30 seconds without storing replay',async()=>{
  const h=harness(source,{exact:true});h.release();await h.run();
  for(let i=0;i<100;i++)assert.equal(await h.run(),1);
  assert.deepEqual(h.totals(),{getCalls:1,serverDocuments:1,writes:1,deletes:0});
  const receipts=h.context.repairOwnNativeRecording.acknowledgements.get(h.database);
  assert.equal(receipts.size,1);
  for(const value of receipts.values())assert.equal(Object.hasOwn(value,'recording'),false);
  h.advance(30000);await h.run();assert.equal(h.totals().getCalls,2);assert.equal(h.totals().writes,1);
});
for(const change of ['time','hash','upload','local-generation','board-generation','package-generation','identity-epoch','user'])test('repair receipt rejects changed exact evidence: '+change,async()=>{
  const h=harness(source,{exact:true});h.release();await h.run();
  if(change==='time'){h.rows[0].timeMs=101;h.docs.get(account+'_'+track).timeMs=101;}
  if(change==='hash'){h.rows[0].replayHash='e'.repeat(64);h.docs.get(account+'_'+track).replayHash='e'.repeat(64);}
  if(change==='upload')h.rows[0].uploadId=9;
  if(change==='local-generation')h.context.localRaceGeneration++;
  if(change==='board-generation')h.context.trackCacheGeneration++;
  if(change==='package-generation')h.context.profileSnapshotEpoch++;
  if(change==='identity-epoch')h.context.runFirebaseTransaction.identityEpoch=1;
  if(change==='user')h.user({uid:'owner'});
  await h.run();
  assert.equal(h.totals().getCalls,change==='upload'?1:2);
});
test('exact receipt cannot hide a subsequently observed foreign canonical binding or failed commit',async()=>{
  const h=harness(source,{exact:true});h.release();await h.run();
  h.docs.get(account+'_'+track).ownerUid='foreign';h.context.trackCacheGeneration++;
  assert.equal(await h.run(),0);assert.equal(h.totals().getCalls,2);assert.equal(h.totals().writes,1);
  const failed=harness(source,{exact:true});failed.failWrite(true);failed.release();await assert.rejects(failed.run());
  assert.equal(failed.context.repairOwnNativeRecording.acknowledgements.get(failed.database).size,0);
  failed.failWrite(false);await failed.run();assert.equal(failed.totals().getCalls,2);
});
test('different replay bytes cannot inherit an exact digest receipt',async()=>{
  const h=harness(source,{exact:true});h.release();await h.run();
  await h.run({recording:'different bytes'});assert.equal(h.totals().getCalls,2);
});
